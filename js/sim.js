/* ============================================================
 * sim.js — GEMM 多层 Tile 模拟核心
 *
 * 真实算法结构（BLIS/Goto 风格 6 层循环）:
 *   for i2 (C 行, 步长 mc):        L2 面板
 *     for j2 (C 列, 步长 nc):      L2 面板
 *       载入 C 块 (mc×nc) 到 L2
 *       for k2 (k, 步长 kc):       L2 面板
 *         载入 A 面板 (mc×kc)、B 面板 (kc×nc) 到 L2
 *         for ir (mr):             L1 微面板
 *           载入 Ar (mr×kc) 到 L1
 *           for jr (nr):           L1 微面板
 *             载入 Br (kc×nr) 到 L1
 *             for kr (步长 1):     微内核
 *               C[ir:ir+mr, jr:jr+nr] += A[:,kr] ⊗ B[kr,:]
 *       写回 C 块
 *
 * 6 层循环的嵌套顺序可配置（cfg.order，外→内）。合法性：ir/jr/kr
 * 的区间边界分别依赖 i2/j2/k2，必须排在其后 → 720 种排列中合法的
 * 共 90 种（legalOrders()）。数据请求绑定到其坐标依赖中「最内层」
 * 的循环入口发出（该循环每次迭代必然产生新的坐标组合），任意合法
 * 顺序下事件语义正确，且缓存命中/缺失模式随顺序自然变化——这正是
 * 循环重排改变局部性的教学演示点。默认顺序与上面的经典结构等价。
 *
 * 不直接算数，而是生成一条「事件轨迹」(trace)，由 Player 回放。
 * 数据搬运量按真实 tile 结构精确统计；缓存命中/淘汰由容量受限
 * LRU 模型判定（容量不足时会发生级联缺失 dram→l1）。
 * 时间模型：带宽 + 固定延迟 + 峰值吞吐（见 README「真实性与简化」）。
 * ============================================================ */
(function (global) {
  'use strict';

  const PEAK = 64;                                  // 计算峰值 64 GFLOP/s = 64 FLOP/ns (double)
  const BW = { dram: 16, l2: 64, l1: 256, reg: 512 }; // 各层带宽 bytes/ns
  const LAT = { dram: 80, l2: 4 };                  // 事务固定延迟 ns：DRAM 参与读/写 80，L2→L1 4
  const ELEM = 8;                                   // float64 = 8 B

  /* ---------- 循环顺序 ---------- */
  const LOOP_VARS = ['i2', 'j2', 'k2', 'ir', 'jr', 'kr'];
  const DEFAULT_ORDER = LOOP_VARS.slice();

  /** 合法性：ir/jr/kr 的区间边界依赖 i2/j2/k2，必须排在其后 */
  function isLegalOrder(order) {
    if (!Array.isArray(order) || order.length !== 6) return false;
    if (new Set(order).size !== 6) return false;
    const pos = {};
    for (let i = 0; i < 6; i++) {
      if (LOOP_VARS.indexOf(order[i]) < 0) return false;
      pos[order[i]] = i;
    }
    return pos.ir > pos.i2 && pos.jr > pos.j2 && pos.kr > pos.k2;
  }

  /** 枚举全部 90 种合法嵌套顺序（外→内） */
  function legalOrders() {
    const all = [];
    const permute = (arr, rest) => {
      if (!rest.length) { all.push(arr.slice()); return; }
      for (let i = 0; i < rest.length; i++)
        permute(arr.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
    };
    permute([], LOOP_VARS);
    return all.filter(isLegalOrder);
  }

  /* ---------- 预设 ---------- */
  const PRESETS = [
    { id: 'small', name: '小型 · 数值', note: '16³ · 每个数值清晰可见', speed: 1,
      cfg: { M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 } },
    { id: 'medium', name: '中型 · 分块', note: '32³ · 多层 tile 层次清晰', speed: 4,
      cfg: { M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 10, l1KB: 3 } },
    { id: 'large', name: '大型 · 性能', note: '96³ · 接近真实规模', speed: 10,
      cfg: { M: 96, N: 96, K: 96, mc: 32, nc: 32, kc: 32, mr: 8, nr: 8, l2KB: 40, l1KB: 12 } },
    { id: 'huge', name: '超大 · 256³', note: '256³ · 面板带宽瓶颈主导', speed: 20,
      cfg: { M: 256, N: 256, K: 256, mc: 64, nc: 64, kc: 64, mr: 8, nr: 8, l2KB: 160, l1KB: 45 } },
    { id: 'naive', name: '无分块 · 对照', note: 'mc=nc=kc=1 · 每元素全量搬运(最坏 2MNK)', speed: 10,
      cfg: { M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, l2KB: 0.125, l1KB: 0.0625 } },
    { id: 'tight', name: '缓存受限', note: '面板超出 L2 容量 → 级联缺失', speed: 1,
      cfg: { M: 16, N: 16, K: 16, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 1, l1KB: 1 } },
  ];

  /** 校验并钳制配置，返回 {cfg, warnings} */
  function normalize(raw) {
    const c = {
      M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4,
      l2KB: 2.5, l1KB: 1, seed: 1, biBlocks: 1, bjBlocks: 1, nCores: 0,
    };
    Object.assign(c, raw || {});
    const warnings = [];
    const i1 = (v) => Math.max(1, Math.round(Number(v)) || 1);
    ['M', 'N', 'K', 'mc', 'nc', 'kc', 'mr', 'nr'].forEach((k) => { c[k] = i1(c[k]); });

    if (c.mc > c.M) { c.mc = c.M; warnings.push('mc 超过 M，已钳制为 M'); }
    if (c.nc > c.N) { c.nc = c.N; warnings.push('nc 超过 N，已钳制为 N'); }
    if (c.kc > c.K) { c.kc = c.K; warnings.push('kc 超过 K，已钳制为 K'); }
    if (c.mr > c.mc) { c.mr = c.mc; warnings.push('mr 不能大于 mc，已钳制'); }
    if (c.nr > c.nc) { c.nr = c.nc; warnings.push('nr 不能大于 nc，已钳制'); }
    if (c.mr > c.M) { c.mr = c.M; warnings.push('mr 超过 M，已钳制为 M'); }
    if (c.nr > c.N) { c.nr = c.N; warnings.push('nr 超过 N，已钳制为 N'); }
    if (c.M % c.mc) warnings.push('M 不被 mc 整除，存在边缘块');
    if (c.N % c.nc) warnings.push('N 不被 nc 整除，存在边缘块');
    if (c.K % c.kc) warnings.push('K 不被 kc 整除，存在边缘块');

    // 事件轨迹规模预警：compute 事件数 ≈ M·N·K/(mr·nr)
    const macs = c.M * c.N * c.K / (c.mr * c.nr);
    if (macs > 3e6) {
      warnings.push('事件轨迹约 ' + Math.round(macs / 1e6) + 'M 条：构建与回放将明显变慢、内存占用高（建议增大 mr/nr 或 kc）');
    }

    // 并行切分（类比 CUDA block）：i2/j2 轴各切成若干份，每份一个 block
    // （独享 L1、共享 L2）。K 轴切分（split-K）因跨 block 归约依赖暂不支持。
    c.biBlocks = Math.max(1, Math.round(Number(c.biBlocks)) || 1);
    c.bjBlocks = Math.max(1, Math.round(Number(c.bjBlocks)) || 1);
    const panelI = Math.ceil(c.M / c.mc), panelJ = Math.ceil(c.N / c.nc);
    if (c.biBlocks > panelI) { c.biBlocks = panelI; warnings.push('i2 并行块数超过面板数 ' + panelI + '，已钳制'); }
    if (c.bjBlocks > panelJ) { c.bjBlocks = panelJ; warnings.push('j2 并行块数超过面板数 ' + panelJ + '，已钳制'); }

    // 计算单元数（并行计算资源份数，类比 CUDA SM）：0 = 自动（跟随并行
    // 块数，每 block 独享一个单元、计算完全并行）。可单独设置以模拟
    // 计算资源受限：单元数 < 块数时，多块分时共享同一单元串行排队。
    c.nCores = Math.max(0, Math.round(Number(c.nCores)) || 0);
    if (c.nCores > 8) { c.nCores = 8; warnings.push('计算单元数最多 8，已钳制'); }
    const nBlk = c.biBlocks * c.bjBlocks;
    if (c.nCores > nBlk) { c.nCores = nBlk; warnings.push('计算单元数超过并行块数 ' + nBlk + '，已钳制'); }

    if (!Array.isArray(c.order)) c.order = DEFAULT_ORDER.slice();
    if (!isLegalOrder(c.order)) {
      c.order = DEFAULT_ORDER.slice();
      warnings.push('循环顺序不合法（ir 需在 i2 后、jr 在 j2 后、kr 在 k2 后），已回退默认');
    }

    c.l2Bytes = Math.max(128, Math.round(Number(c.l2KB) * 1024));
    c.l1Bytes = Math.max(64, Math.round(Number(c.l1KB) * 1024));
    c.seed = Math.round(Number(c.seed)) || 1;
    return { cfg: c, warnings };
  }

  /** 生成 [−1, 1] 均匀随机矩阵（确定性） */
  function randMatrix(m, n, seed) {
    const rnd = mulberry32Local(seed);
    const a = new Float64Array(m * n);
    for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1;
    return a;
  }
  function mulberry32Local(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 朴素三重循环参考实现（用于校验可视化结果的正确性） */
  function matmulRef(A, B, M, N, K) {
    const C = new Float64Array(M * N);
    for (let i = 0; i < M; i++) {
      for (let k = 0; k < K; k++) {
        const a = A[i * K + k];
        if (a === 0) continue;
        for (let j = 0; j < N; j++) C[i * N + j] += a * B[k * N + j];
      }
    }
    return C;
  }

  /* ---------- 容量受限 LRU 缓存模型 ----------
   * 块携带脏位：C 面板是唯一可写数据（写分配/读改写语义，载入即脏），
   * A/B 面板只读恒为干净块。脏块被 LRU 淘汰 = 脏替换，须先冲刷回
   * 下一层（L2 脏块 → DRAM 写回），产生写流量；干净块淘汰零流量。
   * 并行切分下 L1 按 block 独享（nBlocks 套独立 Map，容量各自判定），
   * L2 全局共享一套。 */
  class MemoryModel {
    constructor(cfg, nL1) {
      this.capL2 = cfg.l2Bytes;
      this.capL1 = cfg.l1Bytes;
      this.l2 = new Map(); // id -> {panel, bytes, last, dirty, i2, j2}
      this.l1 = Array.from({ length: Math.max(1, nL1 | 0) }, () => new Map());
      this.clock = 0;
      this.stats = {
        l2: { hit: 0, miss: 0, evict: 0, oversize: 0 },
        l1: { hit: 0, miss: 0, evict: 0, oversize: 0 },
      };
    }
    mapFor(level, b) { return level === 'l2' ? this.l2 : this.l1[(b || 0) % this.l1.length]; }
    lookup(level, id, b) { return this.mapFor(level, b).has(id); }
    get(level, id, b) { return this.mapFor(level, b).get(id) || null; }
    touch(level, id, b) {
      const blk = this.mapFor(level, b).get(id);
      if (blk) blk.last = ++this.clock;
    }
    insert(level, id, panel, bytes, opts, b) {
      const m = this.mapFor(level, b);
      const cap = level === 'l2' ? this.capL2 : this.capL1;
      const st = this.stats[level];
      const evicted = [];
      // 块本身大于容量 → 无法驻留（后续每次访问都级联到下一层）
      if (bytes > cap) { st.oversize++; return { evicted, resident: false }; }
      m.set(id, {
        panel, bytes, last: ++this.clock,
        dirty: !!(opts && opts.dirty), i2: opts && opts.i2, j2: opts && opts.j2,
      });
      let total = 0;
      for (const blk of m.values()) total += blk.bytes;
      while (total > cap) {
        let lru = null, lruId = null;
        for (const [id2, blk] of m) if (!lru || blk.last < lru.last) { lru = blk; lruId = id2; }
        total -= lru.bytes;
        m.delete(lruId);
        st.evict++;
        evicted.push({ id: lruId, panel: lru.panel, bytes: lru.bytes,
          dirty: lru.dirty, i2: lru.i2, j2: lru.j2 });
      }
      return { evicted, resident: true };
    }
    remove(level, id, b) { this.mapFor(level, b).delete(id); }
  }

  /* ---------- 事件轨迹生成 ---------- */
  function buildTrace(cfg) {
    const { M, N, K, mc, nc, kc, mr, nr } = cfg;
    // L1 按 block 独享：必须传入块数，否则所有 block 共享一套 L1 Map，
    // 锁步并行时互相挤出 Ar/Br（此 bug 曾被 k2 粒度轮转掩盖）
    const mm = new MemoryModel(cfg, Math.max(1, (cfg.biBlocks || 1) * (cfg.bjBlocks || 1)));
    const events = [];
    let t = 0;
    // emit(ev, durNs): durNs 是该事件的模拟时长。记账事件(hit/evict/oversize)
    // 只记录缓存系统状态，不占用模拟时间（动画节奏由 player.dwellOf 决定，
    // 与此处无关）——此前 0.5ns 的记账时长曾占无分块预设 59% 的 totalTime。
    const emit = (ev, durNs) => { ev.t = t; events.push(ev); t += durNs; return ev; };

    /** 链路流量统计：key = from>to，实测带宽 = bytes/ns（含延迟，
     *  小块事务被延迟压制的程度由此可见——「真实带宽」对理论常数的比
     *  即链路利用率）。 */
    const links = {};
    const linkAdd = (key, bytes, ns, dirty) => {
      const L = links[key] || (links[key] = { bytes: 0, ns: 0, n: 0, dirty: 0 });
      L.bytes += bytes; L.ns += ns; L.n++;
      if (dirty) L.dirty++;
    };

    /* ---- 并行时间模型 ----
     * 私有资源（计算单元 / L1 / 寄存器）按计算单元并行：block b 的计算
     * 时间累加到单元 b % nCores，单元间互不阻塞；多个 block 分派到同一
     * 单元时，其计算在该单元上串行排队。nCores = 0（自动）时单元数 =
     * 块数，每 block 独享一个单元、计算完全并行。
     * 共享资源（L2 / DRAM 带宽）全局固定：所有 block 的共享访存时间
     * 串行叠加，竞争同一带宽。
     * 并行总时间 = max(最忙计算单元的负载, 全部共享访存时间)——
     * 计算主导场景加速比 ≈ min(nCores, nBlocks)，访存主导场景受共享
     * 带宽压制。nBlocks = 1 时退化为 max(计算时间, 访存时间)。 */
    const nBlocks = cfg.biBlocks * cfg.bjBlocks;
    const nCores = cfg.nCores > 0 ? cfg.nCores : nBlocks;
    const parPriv = new Array(nBlocks).fill(0);   // 各 block 的计算时间
    const coreLoad = new Array(nCores).fill(0);   // 各计算单元的排队负载（私有时间）
    let parShared = 0;                            // 共享 L2/DRAM 访存总时间

    /** 搬运时长 = 带宽项 + 固定延迟项。带宽按瓶颈侧计（DRAM 参与读/写
     *  都按 DRAM 带宽）；延迟按事务类型计——块越小延迟占比越大，
     *  「分块摊销延迟」由模型自然产生（见 README）。
     *  所有 xfer（L2↔DRAM↔L1）都走共享资源，累加到 parShared。 */
    let xferNs = 0;   // 全部 xfer 事件真实时长累计（含延迟）
    const xferTime = (from, to, bytes, dirty) => {
      const dram = from === 'dram' || to === 'dram';
      const d = bytes / (dram ? BW.dram : BW[from]) + (dram ? LAT.dram : LAT.l2);
      xferNs += d;
      parShared += d;   // 共享资源（L2/DRAM 带宽）
      linkAdd(from + '>' + to, bytes, d, dirty);
      return d;
    };

    /** L2 淘汰块处理：干净块零流量；脏块（C 面板）须冲刷回 DRAM
     *  ——脏替换写回，计入 flushed 集合以跳过其后的最终写回（防双计） */
    const flushed = new Set();
    const flushEvicted = (evicted) => {
      for (const b of evicted) {
        emit({ type: 'evict', level: 'l2', id: b.id }, 0);
        if (b.dirty) {
          dramWrite += b.bytes;
          flushed.add(b.id);
          emit({ type: 'xfer', from: 'l2', to: 'dram', id: b.id, panel: b.panel,
            bytes: b.bytes, store: true, dirty: true, i2: b.i2, j2: b.j2 },
          xferTime('l2', 'dram', b.bytes, true));
        }
      }
    };

    let dramRead = 0, dramWrite = 0, l2Bytes = 0, l1Bytes = 0, regBytes = 0, flops = 0;

    /** 请求 L2 面板（A/B tile）；命中则无 DRAM 流量。L2 全局共享（跨 block）。 */
    const requestL2 = (id, panel, bytes) => {
      if (mm.lookup('l2', id)) {
        mm.stats.l2.hit++;
        mm.touch('l2', id);
        emit({ type: 'hit', level: 'l2', id }, 0);
        return;
      }
      mm.stats.l2.miss++;
      const { evicted, resident } = mm.insert('l2', id, panel, bytes);
      flushEvicted(evicted);
      if (!resident) {
        // 面板大于 L2 容量 → 不驻留；数据按需通过 L1 级联读取（不再整块读入，避免重复计数）
        emit({ type: 'oversize', level: 'l2', id, bytes, miss: true }, 0);
        return;
      }
      dramRead += bytes;
      emit({ type: 'xfer', from: 'dram', to: 'l2', id, panel, bytes, miss: true }, xferTime('dram', 'l2', bytes));
    };

    /** 请求 L1 微面板（Ar/Br）；L2 缺失时级联到 DRAM。Ar/Br 只读
     *  恒为干净块，L1 淘汰不产生写回流量。L1 按 block 独享
     *  （b 选择本 block 的 L1，容量独立判定，id 空间互不可见）。 */
    const requestL1 = (id, tileId, panel, bytes, b) => {
      if (mm.lookup('l1', id, b)) {
        mm.stats.l1.hit++;
        mm.touch('l1', id, b);
        emit({ type: 'hit', level: 'l1', id, b }, 0);
        return;
      }
      mm.stats.l1.miss++;
      const { evicted, resident } = mm.insert('l1', id, panel, bytes, null, b);
      for (const blk of evicted) emit({ type: 'evict', level: 'l1', id: blk.id, b }, 0);
      if (!resident) emit({ type: 'oversize', level: 'l1', id, bytes, b }, 0);
      if (!mm.lookup('l2', tileId)) {
        // 级联缺失：L2 中无对应面板（容量不足/被淘汰）→ 直接访问 DRAM
        mm.stats.l2.miss++;
        dramRead += bytes;
        emit({ type: 'xfer', from: 'dram', to: 'l1', id, panel, bytes, miss: true, cascade: true, b },
          xferTime('dram', 'l1', bytes));
        return;
      }
      // L2 命中供数：必须 touch L2 面板（正在被使用的面板保持 LRU 新鲜度，
      // 否则会被后续面板分配挤出，产生多余的脏替换与重读）
      mm.touch('l2', tileId);
      l2Bytes += bytes;
      emit({ type: 'xfer', from: 'l2', to: 'l1', id, panel, bytes, miss: true, b }, xferTime('l2', 'l1', bytes));
    };

    /* ----- 顺序驱动 + 并行 block 的执行引擎 -----
     * 每条语句在其坐标依赖中「最内层」循环的入口发出（该循环每次迭代
     * 必然产生新的坐标组合）；C 写回在 inner(i2,j2) 循环体结束处发出。
     * 合法顺序下乘加循环必为最内层（i2/j2/k2 若嵌进 ir/jr/kr 内部，
     * 与其边界依赖矛盾）。默认顺序与经典 BLIS 结构逐事件等价。
     *
     * 并行切分（类比 CUDA block）：i2/j2 面板按 biBlocks/bjBlocks 连续
     * 分组，每组一个 block——独享一套 L1（id 空间独立、容量独立判定），
     * 共享同一 L2。block 任务实现为 generator；多 block 时在**每个微内核
     * （MAC）之后** yield，调度器按 blockIdx 轮转（round-robin）——
     * 各 block 的 kr 逐拍锁步推进（同一拍内各 block 的 k 相同），
     * 动画上可见多 block 真正同步并行计算；单 block 不额外 yield。
     * ctx 在挂起/恢复间以快照保存（各 generator 共享同一 ctx 对象）。 */
    const order = cfg.order;
    const pos = {};
    order.forEach((v, i) => { pos[v] = i; });
    const innerOf = (vars) => vars.reduce((a, b) => (pos[a] > pos[b] ? a : b));
    const FIRE = {
      C: innerOf(['i2', 'j2']),   // C 面板 → L2
      A: innerOf(['i2', 'k2']),   // A 面板 → L2
      B: innerOf(['j2', 'k2']),   // B 面板 → L2
      Ar: innerOf(['ir', 'k2']),  // A 微面板 → L1
      Br: innerOf(['jr', 'k2']),  // B 微面板 → L1
      Reg: innerOf(['ir', 'jr']), // C 微块 → 寄存器
    };
    const enter = {};
    order.forEach((v) => { enter[v] = []; });
    ['C', 'A', 'B', 'Ar', 'Br', 'Reg'].forEach((key) => enter[FIRE[key]].push(key));
    const MAC_AT = innerOf(['ir', 'jr', 'kr']);
    const STORE_AT = innerOf(['i2', 'j2']);

    const panelI = Math.ceil(M / mc), panelJ = Math.ceil(N / nc);
    const perI = Math.ceil(panelI / cfg.biBlocks), perJ = Math.ceil(panelJ / cfg.bjBlocks);

    const ctx = { i2: 0, j2: 0, k2: 0, ir: 0, jr: 0, kr: 0, b: 0,
      mcE: M, ncE: N, kcE: K, mrE: mr, nrE: nr };

    // 各 block 的 i2/j2 面板值列表（连续分组：block b 负责第 b 片）
    const panelVals = (pTotal, per, b) => {
      const s = Math.min(b * per, pTotal), e = Math.min((b + 1) * per, pTotal);
      const a = [];
      for (let p = s; p < e; p++) a.push(p);
      return a;
    };
    const rangeArr = (s, stop, step) => {
      const a = [];
      for (let v = s; v < stop; v += step) a.push(v);
      return a;
    };

    const RANGE = {
      i2: () => panelVals(panelI, perI, Math.floor(ctx.b / cfg.bjBlocks)).map((p) => p * mc),
      j2: () => panelVals(panelJ, perJ, ctx.b % cfg.bjBlocks).map((p) => p * nc),
      k2: () => rangeArr(0, K, kc),
      ir: () => rangeArr(ctx.i2, ctx.i2 + ctx.mcE, mr),
      jr: () => rangeArr(ctx.j2, ctx.j2 + ctx.ncE, nr),
      kr: () => rangeArr(ctx.k2, ctx.k2 + ctx.kcE, 1),
    };

    const stmt = (key) => {
      const { i2, j2, k2, ir, jr, kr, mcE, ncE, kcE, mrE, nrE, b } = ctx;
      const bi = i2 / mc, bj = j2 / nc, bk = k2 / kc;
      if (key === 'C') {
        // C 块 → L2（写分配/读改写：载入即脏；整个内层循环期间驻留，最终写回）
        const cId = 'C:' + bi + ':' + bj;
        const cBytes = mcE * ncE * ELEM;
        mm.stats.l2.miss++; // 首触必缺
        const { evicted, resident } = mm.insert('l2', cId, 'C', cBytes, { dirty: true, i2, j2 });
        flushEvicted(evicted);
        dramRead += cBytes;
        emit({ type: 'xfer', from: 'dram', to: 'l2', id: cId, panel: 'C', bytes: cBytes,
          miss: true, oversize: !resident, i2, j2 }, xferTime('dram', 'l2', cBytes));
      } else if (key === 'A') {
        requestL2('A:' + bi + ':' + bk, 'A', mcE * kcE * ELEM);
      } else if (key === 'B') {
        requestL2('B:' + bk + ':' + bj, 'B', kcE * ncE * ELEM);
      } else if (key === 'Ar') {
        requestL1('Ar:' + (ir / mr) + ':' + bk, 'A:' + bi + ':' + bk, 'A', mrE * kcE * ELEM, b);
      } else if (key === 'Br') {
        requestL1('Br:' + bk + ':' + (jr / nr), 'B:' + bk + ':' + bj, 'B', kcE * nrE * ELEM, b);
      } else if (key === 'Reg') {
        // C 微块载入寄存器：物理上是 L2 读（带宽与延迟按 L2 链路计），
        // 跨其内层的 kr 循环驻留；寄存器写回即最终的 C 写路径。
        // L2 带宽共享 → parShared。
        const bytes = mrE * nrE * ELEM;
        regBytes += bytes;
        mm.touch('l2', 'C:' + bi + ':' + bj);
        const d = bytes / BW.l2 + LAT.l2;
        linkAdd('l2>reg', bytes, d);
        parShared += d;
        emit({ type: 'reg', panel: 'C', i: ir, j: jr, rows: mrE, cols: nrE, bytes }, d);
      } else if (key === 'MAC') {
        // 微内核：k 循环逐元素计算（A 列 + B 行 + 乘加 合并为一个 compute 事件）；
        // 操作数流经 L1→Reg 端口。计算在 block 所属的计算单元上执行
        // （b % nCores 分派，同单元多块串行排队），单元间真正并行。
        const f = 2 * mrE * nrE;
        const ob = (mrE + nrE) * ELEM;
        regBytes += ob;
        linkAdd('l1>reg', ob, ob / BW.reg);
        flops += f;
        const d = f / PEAK + ob / BW.reg;
        parPriv[b] += d;
        coreLoad[b % nCores] += d;
        emit({
          type: 'compute', i: ir, j: jr, k: kr, mr: mrE, nr: nrE,
          flops: f, i2, j2, k2, regBytes: ob, b, core: b % nCores,
        }, d);
      } else { // Store: C 块写回（若已被脏替换冲刷则跳过，防双计）
        const cId = 'C:' + bi + ':' + bj;
        const cBytes = mcE * ncE * ELEM;
        if (!flushed.has(cId)) {
          mm.remove('l2', cId);
          dramWrite += cBytes;
          emit({ type: 'xfer', from: 'l2', to: 'dram', id: cId, panel: 'C', bytes: cBytes, store: true, i2, j2 },
            xferTime('l2', 'dram', cBytes));
        }
      }
    };

    function* runGen(depth) {
      const name = order[depth];
      for (const v of RANGE[name]()) {
        ctx[name] = v;
        if (name === 'i2') ctx.mcE = Math.min(mc, M - v);
        else if (name === 'j2') ctx.ncE = Math.min(nc, N - v);
        else if (name === 'k2') ctx.kcE = Math.min(kc, K - v);
        else if (name === 'ir') ctx.mrE = Math.min(mr, ctx.i2 + ctx.mcE - v);
        else if (name === 'jr') ctx.nrE = Math.min(nr, ctx.j2 + ctx.ncE - v);
        for (const key of enter[name]) stmt(key);
        if (name === MAC_AT) {
          stmt('MAC');
          // 微内核粒度锁步：多 block 时每个 MAC 后让出，各 block 的 kr
          // 同拍推进——回放动画上可见所有 block 同步并行计算
          if (nBlocks > 1) yield;
        }
        if (depth + 1 < 6) yield* runGen(depth + 1);
        if (name === STORE_AT) stmt('Store');
        if (name === 'k2') yield;   // k2 迭代边界：轮转调度点（单 block 时唯一让出点）
      }
    }

    /* 调度器：每 block 一个 generator（携带本 block 的 ctx 快照），
     * 多 block 时按微内核粒度轮转（round-robin）——每拍各 block 各前进一步
     * 微内核（kr 锁步），模拟多 block 真正同步并行；单 block 一次跑完。 */
    const iters = [];
    for (let b = 0; b < nBlocks; b++) {
      for (const k of Object.keys(ctx)) ctx[k] = 0;
      ctx.mcE = M; ctx.ncE = N; ctx.kcE = K; ctx.mrE = mr; ctx.nrE = nr; ctx.b = b;
      const it = runGen(0);
      const r = it.next();
      if (!r.done) iters.push({ it, b, snap: Object.assign({}, ctx) });
    }
    let alive = iters.slice();
    while (alive.length) {
      const next = [];
      for (const task of alive) {
        Object.assign(ctx, task.snap);   // 恢复本 block 的循环状态
        const r = task.it.next();
        task.snap = Object.assign({}, ctx);
        if (!r.done) next.push(task);
      }
      alive = next;
    }

    const computeTime = flops / PEAK;

    /* 并行时间模型总结：
     * totalTime = max(最忙计算单元负载, 全部共享访存时间)。
     * - 私有 = 计算+寄存器端口，按计算单元并行（nCores 个单元，自动时
     *   = 块数；block b → 单元 b % nCores，同单元多块串行排队）
     * - 共享 = L2/DRAM 带宽（全局固定，所有 block 竞争）
     * 计算主导 → 加速比 ≈ min(nCores, nBlocks)；访存主导 → 共享带宽压制 */
    const maxPrivTime = Math.max(...coreLoad, 0);
    const parallelTotalTime = Math.max(maxPrivTime, parShared);
    const serialTotalTime = t;   // 串行 wall time（事件轨迹全部叠加）
    const speedup = parallelTotalTime > 0 ? serialTotalTime / parallelTotalTime : 1;

    // 链路统计：实测带宽 = bytes/ns（含延迟）；理论 = 瓶颈侧带宽常量
    const THEORY = {
      'dram>l2': BW.dram, 'l2>l1': BW.l2, 'dram>l1': BW.dram,
      'l2>reg': BW.l2, 'l1>reg': BW.reg, 'l2>dram': BW.dram,
    };
    const linkStats = {};
    for (const key of Object.keys(links)) {
      const L = links[key];
      const bw = L.ns ? L.bytes / L.ns : 0;
      const theory = THEORY[key] || 0;
      linkStats[key] = {
        bytes: L.bytes, ns: L.ns, n: L.n, dirty: L.dirty,
        bw, theory, util: theory ? bw / theory : 0,
      };
    }

    return {
      events, cfg,
      stats: {
        l2: mm.stats.l2, l1: mm.stats.l1,
        flops, dramRead, dramWrite, l2Bytes, l1Bytes: regBytes, regBytes,
        computeTime, transferTime: xferNs,
        serialTotalTime, parallelTotalTime, totalTime: parallelTotalTime,
        speedup, nCores,
        parPrivTime: maxPrivTime, parSharedTime: parShared,
        links: linkStats,
        ai: flops / Math.max(1, dramRead + dramWrite),   // 算术强度 FLOP/B
        achieved: flops / Math.max(1, parallelTotalTime), // GFLOPS（并行模型）
      },
    };
  }

  /* ---------- Roofline 静态分析 ----------
   * 理论 DRAM 流量（无容量缺失时）: M·N·K·(1/nc + 1/mc) + 2·M·N 元素
   * 无分块最坏: 2·M·N·K + 2·M·N；理论下限(强制缺失): 2MN + MK + KN
   * 按「计算与搬运重叠」假设估时: time = max(computeTime, dramTime) */
  function analyze(cfg) {
    const { M, N, K, mc, nc } = cfg;
    const flops = 2 * M * N * K;
    const dramBytes = (M * N * K * (1 / nc + 1 / mc) + 2 * M * N) * ELEM;
    const idealBytes = (2 * M * N + M * K + N * K) * ELEM;
    const naiveBytes = (2 * M * N * K + 2 * M * N) * ELEM;
    const perf = (bytes) => flops / Math.max(flops / PEAK, bytes / BW.dram);
    return {
      flops,
      cur: { ai: flops / dramBytes, gf: perf(dramBytes), bytes: dramBytes },
      ideal: { ai: flops / idealBytes, gf: perf(idealBytes), bytes: idealBytes },
      naive: { ai: flops / naiveBytes, gf: perf(naiveBytes), bytes: naiveBytes },
      formula: 'M·N·K·(1/nc + 1/mc) + 2·M·N',
    };
  }

  global.MSim = { PEAK, BW, LAT, ELEM, PRESETS, DEFAULT_ORDER, isLegalOrder, legalOrders,
    normalize, randMatrix, matmulRef, buildTrace, analyze };
})(typeof window !== 'undefined' ? window : globalThis);
