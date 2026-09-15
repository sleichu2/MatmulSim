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
 * 不直接算数，而是生成一条「事件轨迹」(trace)，由 Player 回放。
 * 数据搬运量按真实 tile 结构精确统计；缓存命中/淘汰由容量受限
 * LRU 模型判定（容量不足时会发生级联缺失 dram→l1）。
 * 时间模型：带宽 + 峰值吞吐（延迟忽略，见 README「真实性与简化」）。
 * ============================================================ */
(function (global) {
  'use strict';

  const PEAK = 64;                                  // 计算峰值 64 GFLOP/s = 64 FLOP/ns (double)
  const BW = { dram: 16, l2: 64, l1: 256, reg: 512 }; // 各层带宽 bytes/ns
  const ELEM = 8;                                   // float64 = 8 B

  /* ---------- 预设 ---------- */
  const PRESETS = [
    { id: 'small', name: '小型 · 数值', note: '16³ · 每个数值清晰可见', speed: 1,
      cfg: { M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 } },
    { id: 'medium', name: '中型 · 分块', note: '32³ · 多层 tile 层次清晰', speed: 4,
      cfg: { M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 10, l1KB: 3 } },
    { id: 'large', name: '大型 · 性能', note: '96³ · 接近真实规模', speed: 10,
      cfg: { M: 96, N: 96, K: 96, mc: 32, nc: 32, kc: 32, mr: 8, nr: 8, l2KB: 40, l1KB: 12 } },
    { id: 'naive', name: '无分块 · 对照', note: 'mc=nc=kc=1 · 每元素全量搬运(最坏 2MNK)', speed: 10,
      cfg: { M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, l2KB: 0.125, l1KB: 0.0625 } },
    { id: 'tight', name: '缓存受限', note: '面板超出 L2 容量 → 级联缺失', speed: 1,
      cfg: { M: 16, N: 16, K: 16, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 1, l1KB: 1 } },
  ];

  /** 校验并钳制配置，返回 {cfg, warnings} */
  function normalize(raw) {
    const c = {
      M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4,
      l2KB: 2.5, l1KB: 1, seed: 1,
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

  /* ---------- 容量受限 LRU 缓存模型 ---------- */
  class MemoryModel {
    constructor(cfg) {
      this.capL2 = cfg.l2Bytes;
      this.capL1 = cfg.l1Bytes;
      this.l2 = new Map(); // id -> {panel, bytes, last}
      this.l1 = new Map();
      this.clock = 0;
      this.stats = {
        l2: { hit: 0, miss: 0, evict: 0, oversize: 0 },
        l1: { hit: 0, miss: 0, evict: 0, oversize: 0 },
      };
    }
    lookup(level, id) { return (level === 'l2' ? this.l2 : this.l1).has(id); }
    touch(level, id) {
      const b = (level === 'l2' ? this.l2 : this.l1).get(id);
      if (b) b.last = ++this.clock;
    }
    insert(level, id, panel, bytes) {
      const m = level === 'l2' ? this.l2 : this.l1;
      const cap = level === 'l2' ? this.capL2 : this.capL1;
      const st = this.stats[level];
      const evicted = [];
      // 块本身大于容量 → 无法驻留（后续每次访问都级联到下一层）
      if (bytes > cap) { st.oversize++; return { evicted, resident: false }; }
      m.set(id, { panel, bytes, last: ++this.clock });
      let total = 0;
      for (const b of m.values()) total += b.bytes;
      while (total > cap) {
        let lru = null, lruId = null;
        for (const [id2, b] of m) if (!lru || b.last < lru.last) { lru = b; lruId = id2; }
        total -= lru.bytes;
        m.delete(lruId);
        st.evict++;
        evicted.push(lruId);
      }
      return { evicted, resident: true };
    }
    remove(level, id) { (level === 'l2' ? this.l2 : this.l1).delete(id); }
  }

  /* ---------- 事件轨迹生成 ---------- */
  function buildTrace(cfg) {
    const { M, N, K, mc, nc, kc, mr, nr } = cfg;
    const mm = new MemoryModel(cfg);
    const events = [];
    let t = 0;
    const emit = (ev, durNs) => { ev.t = t; events.push(ev); t += durNs; return ev; };

    let dramRead = 0, dramWrite = 0, l2Bytes = 0, l1Bytes = 0, regBytes = 0, flops = 0;

    /** 请求 L2 面板（A/B tile）；命中则无 DRAM 流量 */
    const requestL2 = (id, panel, bytes) => {
      if (mm.lookup('l2', id)) {
        mm.stats.l2.hit++;
        mm.touch('l2', id);
        emit({ type: 'hit', level: 'l2', id }, 0.5);
        return;
      }
      mm.stats.l2.miss++;
      const { evicted, resident } = mm.insert('l2', id, panel, bytes);
      for (const eid of evicted) emit({ type: 'evict', level: 'l2', id: eid }, 0.5);
      if (!resident) {
        // 面板大于 L2 容量 → 不驻留；数据按需通过 L1 级联读取（不再整块读入，避免重复计数）
        emit({ type: 'oversize', level: 'l2', id, bytes, miss: true }, 0.5);
        return;
      }
      dramRead += bytes;
      emit({ type: 'xfer', from: 'dram', to: 'l2', id, panel, bytes, miss: true }, bytes / BW.dram);
    };

    /** 请求 L1 微面板（Ar/Br）；L2 缺失时级联到 DRAM */
    const requestL1 = (id, tileId, panel, bytes) => {
      if (mm.lookup('l1', id)) {
        mm.stats.l1.hit++;
        mm.touch('l1', id);
        emit({ type: 'hit', level: 'l1', id }, 0.5);
        return;
      }
      mm.stats.l1.miss++;
      const { evicted, resident } = mm.insert('l1', id, panel, bytes);
      for (const eid of evicted) emit({ type: 'evict', level: 'l1', id: eid }, 0.5);
      if (!resident) emit({ type: 'oversize', level: 'l1', id, bytes }, 0.5);
      if (mm.lookup('l2', tileId)) {
        l2Bytes += bytes;
        emit({ type: 'xfer', from: 'l2', to: 'l1', id, panel, bytes, miss: true }, bytes / BW.l2);
      } else {
        // 级联缺失：L2 中无对应面板（容量不足/被淘汰）→ 直接访问 DRAM
        mm.stats.l2.miss++;
        dramRead += bytes;
        emit({ type: 'xfer', from: 'dram', to: 'l1', id, panel, bytes, miss: true, cascade: true },
          bytes / BW.dram);
      }
    };

    for (let i2 = 0; i2 < M; i2 += mc) {
      const mcE = Math.min(mc, M - i2);
      const bi = i2 / mc;
      for (let j2 = 0; j2 < N; j2 += nc) {
        const ncE = Math.min(nc, N - j2);
        const bj = j2 / nc;

        // C 块 → L2（整个 k2 循环内驻留，最终写回 DRAM）
        const cId = 'C:' + bi + ':' + bj;
        const cBytes = mcE * ncE * ELEM;
        mm.stats.l2.miss++; // 首触必缺
        {
          const { evicted, resident } = mm.insert('l2', cId, 'C', cBytes);
          for (const eid of evicted) emit({ type: 'evict', level: 'l2', id: eid }, 0.5);
          dramRead += cBytes;
          emit({ type: 'xfer', from: 'dram', to: 'l2', id: cId, panel: 'C', bytes: cBytes,
            miss: true, oversize: !resident, i2, j2 }, cBytes / BW.dram);
        }

        for (let k2 = 0; k2 < K; k2 += kc) {
          const kcE = Math.min(kc, K - k2);
          const bk = k2 / kc;
          requestL2('A:' + bi + ':' + bk, 'A', mcE * kcE * ELEM);
          requestL2('B:' + bk + ':' + bj, 'B', kcE * ncE * ELEM);

          for (let ir = i2; ir < i2 + mcE; ir += mr) {
            const mrE = Math.min(mr, i2 + mcE - ir);
            const ri = ir / mr;
            requestL1('Ar:' + ri + ':' + bk, 'A:' + bi + ':' + bk, 'A', mrE * kcE * ELEM);

            for (let jr = j2; jr < j2 + ncE; jr += nr) {
              const nrE = Math.min(nr, j2 + ncE - jr);
              const rj = jr / nr;
              requestL1('Br:' + bk + ':' + rj, 'B:' + bk + ':' + bj, 'B', kcE * nrE * ELEM);

              // C 微块载入寄存器（每个 (ir,jr,k2) 一次，跨 kr 循环驻留）
              regBytes += mrE * nrE * ELEM;
              emit({ type: 'reg', panel: 'C', i: ir, j: jr, rows: mrE, cols: nrE },
                mrE * nrE * ELEM / BW.reg);

              // 微内核：k 循环逐元素计算（A 列 + B 行 + 乘加 合并为一个 compute 事件）
              for (let kr = k2; kr < k2 + kcE; kr++) {
                const f = 2 * mrE * nrE;
                regBytes += (mrE + nrE) * ELEM;
                flops += f;
                emit({
                  type: 'compute', i: ir, j: jr, k: kr, mr: mrE, nr: nrE,
                  flops: f, i2, j2, k2, regBytes: (mrE + nrE) * ELEM,
                }, f / PEAK + (mrE + nrE) * ELEM / BW.reg);
              }
            }
          }
        }

        // C 块写回
        mm.remove('l2', cId);
        dramWrite += cBytes;
        emit({ type: 'xfer', from: 'l2', to: 'dram', id: cId, panel: 'C', bytes: cBytes, store: true, i2, j2 },
          cBytes / BW.dram);
      }
    }

    const transferTime = dramRead / BW.dram + dramWrite / BW.dram + l2Bytes / BW.l2
      + l1Bytes / BW.l1 + regBytes / BW.reg;
    const computeTime = flops / PEAK;

    return {
      events, cfg,
      stats: {
        l2: mm.stats.l2, l1: mm.stats.l1,
        flops, dramRead, dramWrite, l2Bytes, l1Bytes: regBytes, regBytes,
        computeTime, transferTime, totalTime: t,
        ai: flops / Math.max(1, dramRead + dramWrite),   // 算术强度 FLOP/B
        achieved: flops / Math.max(1, t),                // GFLOPS（串行回放）
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

  global.MSim = { PEAK, BW, ELEM, PRESETS, normalize, randMatrix, matmulRef, buildTrace, analyze };
})(typeof window !== 'undefined' ? window : globalThis);
