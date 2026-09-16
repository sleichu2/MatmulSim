/* ============================================================
 * test/test.mjs — 模拟器核心的正确性验证（node 直接运行）
 *
 * 运行: node test/test.mjs
 *
 * 验证项:
 *  1. 事件轨迹回放结果 == 朴素参考乘法（数值正确）
 *  2. 事件时间戳单调不减
 *  3. 总 FLOPs == 2·M·N·K
 *  4. 无限缓存 → DRAM 流量 == 强制缺失下限 2MN+MK+KN 元素
 *  5. 标准分块(小 L2) → DRAM 流量位于 [下限, 理论公式] 之间
 *  6. 无分块(1×1 tile) → A 流量 == M·N·K（每次全量重载）
 *  7. 缓存受限(面板>L2) → 3 次超容量、8 次级联缺失、流量==强制下限
 *  8. Player 回放终态计数器与模拟器统计完全一致
 *  9. 延迟模型：记账事件零耗时、事务=带宽+固定延迟、延迟随块摊销
 * 10. 循环顺序：90 种合法嵌套全部数值正确、非法回退、顺序改变行为
 * 11. 超大矩阵：256³ 预设流量界、事件量预警
 * 12. 写路径与链路统计：脏替换、每面板恰写一次、流量配平、Player 镜像
 * 13. 并行切分：block 数值正确、L1 独享、共享 L2、钳制
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['js/util.js', 'js/sim.js', 'js/player.js'];
const code = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n;\n');
const sandbox = { console, performance: { now: () => Date.now() } };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const { MSim, MPlayer } = sandbox;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  \u2713 ' + name);
  else { failures++; console.error('  \u2717 ' + name + (detail !== undefined ? '   (' + detail + ')' : '')); }
}

/** DRAM 流量（元素数） */
function dramEls(events) {
  let bytes = 0;
  for (const ev of events) if (ev.type === 'xfer' && (ev.from === 'dram' || ev.to === 'dram')) bytes += ev.bytes;
  return bytes / 8;
}

/** 生成轨迹并按事件回放，与朴素乘法对比 */
function replay(cfg) {
  const A = MSim.randMatrix(cfg.M, cfg.K, 42);
  const B = MSim.randMatrix(cfg.K, cfg.N, 7);
  const refC = MSim.matmulRef(A, B, cfg.M, cfg.N, cfg.K);
  const res = MSim.buildTrace(cfg);
  const C = new Float64Array(cfg.M * cfg.N);
  for (const ev of res.events) {
    if (ev.type === 'compute') {
      for (let ii = 0; ii < ev.mr; ii++) {
        for (let jj = 0; jj < ev.nr; jj++) {
          C[(ev.i + ii) * cfg.N + (ev.j + jj)] +=
            A[(ev.i + ii) * cfg.K + ev.k] * B[ev.k * cfg.N + (ev.j + jj)];
        }
      }
    }
  }
  let err = 0;
  for (let i = 0; i < C.length; i++) err = Math.max(err, Math.abs(C[i] - refC[i]));
  return { res, err, refC, A, B };
}

console.log('=== 1. 标准配置: 数值正确性 / 时间序 / FLOPs ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 }).cfg;
  const { res, err } = replay(cfg);
  check('回放 C == 参考 C (max |\u0394| < 1e-12)', err < 1e-12, err);
  let sorted = true;
  for (let i = 1; i < res.events.length; i++) if (res.events[i].t < res.events[i - 1].t) sorted = false;
  check('事件时间戳单调不减', sorted, res.events.length + ' events');
  check('总 FLOPs == 2\u00b7M\u00b7N\u00b7K', res.stats.flops === 2 * 16 * 16 * 16, res.stats.flops);
  check('C 写回 == M\u00b7N 元素', res.stats.dramWrite === 16 * 16 * 8, res.stats.dramWrite);
}

console.log('=== 2. 无限缓存 → 强制缺失下限 2MN+MK+KN ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 10000, l1KB: 10000 }).cfg;
  const { res } = replay(cfg);
  const expect = (2 * 16 * 16 + 16 * 16 + 16 * 16);
  check('DRAM 流量 == ' + expect + ' 元素', dramEls(res.events) === expect, dramEls(res.events));
  check('L2 命中 > 0 (复用生效)', res.stats.l2.hit > 0, res.stats.l2.hit);
}

console.log('=== 3. 标准配置(小 L2): 流量位于 [下限, 理论公式] ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 }).cfg;
  const { res } = replay(cfg);
  const lo = 2 * 16 * 16 + 16 * 16 + 16 * 16;
  const hi = 16 * 16 * 16 * (1 / 8 + 1 / 8) + 2 * 16 * 16;
  const d = dramEls(res.events);
  check('流量 \u2208 [' + lo + ', ' + hi + ']', d >= lo && d <= hi, d);
}

console.log('=== 4. 无分块(1\u00d71 tile, 小 L2): 最坏 2MNK 搬运 ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, l2KB: 0.125, l1KB: 0.0625 }).cfg;
  const { res } = replay(cfg);
  let aEls = 0;
  for (const ev of res.events) {
    if (ev.type === 'xfer' && ev.from === 'dram' && ev.to === 'l2' && ev.panel === 'A') aEls += ev.bytes / 8;
  }
  check('A 面板 DRAM 流量 == M\u00b7N\u00b7K = 4096', aEls === 16 * 16 * 16, aEls);
  check('总 DRAM 流量 == 最坏情形 2MNK+2MN = 8704', dramEls(res.events) === 2 * 16 * 16 * 16 + 2 * 16 * 16, dramEls(res.events));
}

console.log('=== 5. 缓存受限: 超容量 → 级联缺失 + B 重复搬运 ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 1, l1KB: 1 }).cfg;
  const { res } = replay(cfg);
  const cascades = res.events.filter((e) => e.type === 'xfer' && e.cascade).length;
  check('超容量块 == 3 (A/B/C 面板)', res.stats.l2.oversize === 3, res.stats.l2.oversize);
  check('级联缺失 == 20 (4\u00d7Ar + 16\u00d7Br)', cascades === 20, cascades);
  // C 整块读+写 4KB；A 经 4 次级联读 1 遍 (2KB)；B 面板无法常驻 L1，
  // 每个 ir 都要重读 (16 次级联 = 8KB = 读 4 遍) → 合计 14KB = 1792 元素
  check('DRAM 流量 == 1792 元素 (含 B\u00d74 重复读)', dramEls(res.events) === 1792, dramEls(res.events));
}

console.log('=== 6. 中型配置: 回放正确性 ===');
{
  const cfg = MSim.normalize({ M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 10, l1KB: 3 }).cfg;
  const { res, err } = replay(cfg);
  check('回放 C == 参考 C (max |\u0394| < 1e-12)', err < 1e-12, err);
}

console.log('=== 7. Player 回放终态 == 模拟器统计 ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 }).cfg;
  const { res, err, refC, A, B } = replay(cfg);
  const player = new MPlayer({ events: res.events, cfg, A, B, refC });
  player.seekEnd();
  let perr = 0;
  for (let i = 0; i < player.C.length; i++) perr = Math.max(perr, Math.abs(player.C[i] - refC[i]));
  check('Player 部分和收敛 (max |\u0394| < 1e-9)', perr < 1e-9, perr);
  check('flops 一致', player.flops === res.stats.flops, player.flops + ' vs ' + res.stats.flops);
  check('DRAM 读一致', player.dramR === res.stats.dramRead);
  check('DRAM 写一致', player.dramW === res.stats.dramWrite);
  check('L2 命中/未中一致', player.l2Hit === res.stats.l2.hit && player.l2Miss === res.stats.l2.miss,
    player.l2Hit + '/' + player.l2Miss + ' vs ' + res.stats.l2.hit + '/' + res.stats.l2.miss);
  check('L1 命中/未中一致', player.l1Hit === res.stats.l1.hit && player.l1Miss === res.stats.l1.miss,
    player.l1Hit + '/' + player.l1Miss + ' vs ' + res.stats.l1.hit + '/' + res.stats.l1.miss);
  check('轨迹回放误差一致', player.maxErr === err, player.maxErr + ' vs ' + err);
}

console.log('=== 7b. 缓存受限配置: Player 计数器 == 模拟器统计 ===');
{
  const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 1, l1KB: 1 }).cfg;
  const { res, refC, A, B } = replay(cfg);
  const player = new MPlayer({ events: res.events, cfg, A, B, refC });
  player.seekEnd();
  check('L2 未中一致 (超容量+级联)', player.l2Miss === res.stats.l2.miss,
    player.l2Miss + ' vs ' + res.stats.l2.miss);
  check('超容量计数一致', player.oversize === res.stats.l2.oversize,
    player.oversize + ' vs ' + res.stats.l2.oversize);
  check('DRAM 读一致', player.dramR === res.stats.dramRead,
    player.dramR + ' vs ' + res.stats.dramRead);
  check('部分和收敛', (() => {
    let e = 0;
    for (let i = 0; i < player.C.length; i++) e = Math.max(e, Math.abs(player.C[i] - refC[i]));
    return e < 1e-9;
  })());
}

console.log('=== 8. Roofline 静态分析合理性 ===');
{
  const cfg = MSim.normalize({ M: 96, N: 96, K: 96, mc: 32, nc: 32, kc: 32, mr: 8, nr: 8, l2KB: 40, l1KB: 12 }).cfg;
  const an = MSim.analyze(cfg);
  check('无分块 AI < 当前分块 AI < 理论上限 AI',
    an.naive.ai < an.cur.ai && an.cur.ai < an.ideal.ai,
    [an.naive.ai, an.cur.ai, an.ideal.ai].join(' < '));
  check('分块后速率逼近峰值(重叠执行假设)', an.cur.gf > an.naive.gf, an.cur.gf + ' vs ' + an.naive.gf);
}

console.log('=== 9. 延迟模型: 记账零耗时 / 事务=带宽+延迟 / 延迟随块摊销 ===');
{
  const dwellOf = (events, i, total) =>
    (i + 1 < events.length ? events[i + 1].t : total) - events[i].t;

  // 9a. 记账事件(hit/evict/oversize)不占模拟时间
  {
    const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, l2KB: 0.125, l1KB: 0.0625 }).cfg;
    const res = MSim.buildTrace(cfg);
    let acct = 0;
    for (let i = 0; i < res.events.length; i++) {
      const e = res.events[i];
      if (e.type === 'hit' || e.type === 'evict' || e.type === 'oversize') acct += dwellOf(res.events, i, res.stats.serialTotalTime);
    }
    check('记账事件(hit/evict/oversize)耗时 == 0', acct === 0, acct + 'ns');
  }

  // 9b. 每笔事务时长 == bytes/带宽 + 固定延迟（DRAM 参与 80ns，L2→L1 4ns）
  {
    const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 }).cfg;
    const res = MSim.buildTrace(cfg);
    let okDram = 0, nDram = 0, okL2 = 0, nL2 = 0, xferNs = 0;
    for (let i = 0; i < res.events.length; i++) {
      const e = res.events[i];
      if (e.type !== 'xfer') continue;
      const d = dwellOf(res.events, i, res.stats.serialTotalTime);
      xferNs += d;
      if (e.from === 'dram' || e.to === 'dram') {
        nDram++;
        if (Math.abs(d - (e.bytes / MSim.BW.dram + MSim.LAT.dram)) < 1e-9) okDram++;
      } else {
        nL2++;
        if (Math.abs(d - (e.bytes / MSim.BW.l2 + MSim.LAT.l2)) < 1e-9) okL2++;
      }
    }
    check('DRAM 事务 == bytes/16B/ns + 80ns (' + okDram + '/' + nDram + ')', okDram === nDram && nDram > 0);
    check('L2\u2192L1 事务 == bytes/64B/ns + 4ns (' + okL2 + '/' + nL2 + ')', okL2 === nL2 && nL2 > 0);
    check('transferTime == xfer 时长累计', Math.abs(res.stats.transferTime - xferNs) < 1e-6,
      res.stats.transferTime.toFixed(2) + ' vs ' + xferNs.toFixed(2));
  }

  // 9c. 延迟摊销：无分块(8B 事务)的每字节 DRAM 成本远高于分块(512B)
  {
    const perByte = (cfg0) => {
      const cfg = MSim.normalize(cfg0).cfg;
      const res = MSim.buildTrace(cfg);
      return res.stats.serialTotalTime / (res.stats.dramRead + res.stats.dramWrite);
    };
    const naive = perByte({ M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, l2KB: 0.125, l1KB: 0.0625 });
    const blocked = perByte({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4, l2KB: 2.5, l1KB: 1 });
    check('无分块每字节 DRAM 成本 > 10\u00d7 分块 (延迟摊销效应)',
      naive > 10 * blocked, naive.toFixed(2) + ' vs ' + blocked.toFixed(2) + ' ns/B');
  }
}

console.log('=== 10. 循环顺序: 90 种合法嵌套 / 非法回退 / 顺序改变行为 ===');
{
  check('合法嵌套共 90 种', MSim.legalOrders().length === 90, MSim.legalOrders().length);

  // 10a. 非法顺序回退默认 + 警告
  {
    const n = MSim.normalize({ M: 8, N: 8, K: 8, order: ['ir', 'i2', 'j2', 'k2', 'jr', 'kr'] });
    check('非法顺序回退默认 + 警告',
      JSON.stringify(n.cfg.order) === JSON.stringify(MSim.DEFAULT_ORDER) && n.warnings.length > 0,
      n.cfg.order.join(',') + ' / ' + n.warnings.length);
  }

  // 10b. 全部 90 种顺序：数值正确 + flops 一致 + C 载入/写回配对（含非整除边缘块）
  //  注：C 载入/写回次数 = (i2,j2) 组合数 ×「夹在中间的外层循环」迭代数——
  //  顺序不同可以合法地多于面板数（如 i2,k2,j2 下 C 被重复读写 K/kc 次），
  //  这正是循环顺序改变局部性的体现，故断言配对不变量而非固定值。
  {
    const N = 12;
    const A = MSim.randMatrix(N, N, 3), B = MSim.randMatrix(N, N, 4);
    const refC = MSim.matmulRef(A, B, N, N, N);
    let ok = 0, worst = 0;
    for (const order of MSim.legalOrders()) {
      const cfg = MSim.normalize({ M: N, N, K: N, mc: 4, nc: 4, kc: 4, mr: 2, nr: 2, order }).cfg;
      const res = MSim.buildTrace(cfg);
      const C = new Float64Array(N * N);
      for (const ev of res.events) {
        if (ev.type !== 'compute') continue;
        for (let ii = 0; ii < ev.mr; ii++)
          for (let jj = 0; jj < ev.nr; jj++)
            C[(ev.i + ii) * N + ev.j + jj] += A[(ev.i + ii) * N + ev.k] * B[ev.k * N + ev.j + jj];
      }
      let err = 0;
      for (let i = 0; i < C.length; i++) err = Math.max(err, Math.abs(C[i] - refC[i]));
      worst = Math.max(worst, err);
      const cLoads = res.events.filter((e) => e.type === 'xfer' && e.panel === 'C' && e.to === 'l2').length;
      const cStores = res.events.filter((e) => e.type === 'xfer' && e.store).length;
      if (err < 1e-9 && res.stats.flops === 2 * N * N * N
        && cLoads === cStores && res.stats.dramWrite === cStores * 4 * 4 * 8) ok++;
    }
    check('90 种顺序全部数值正确且 C 读写配对 (最坏 |Δ|=' + worst.toExponential(1) + ')', ok === 90, ok + '/90');
  }

  // 10c. 默认顺序结构回归：事件头 + 写回位置
  {
    const cfg = MSim.normalize(MSim.PRESETS[0].cfg).cfg;
    const res = MSim.buildTrace(cfg);
    const head = res.events.slice(0, 7).map((e) => e.type).join(',');
    check('默认顺序事件头 == xfer×5,reg,compute', head === 'xfer,xfer,xfer,xfer,xfer,reg,compute', head);
    check('默认顺序 C 写回存在且带 (i2,j2)', res.events.some((e) =>
      e.type === 'xfer' && e.store && e.i2 === 0 && e.j2 === 0));
  }

  // 10d. 顺序改变缓存/寄存器行为（教学对比点）
  {
    const run = (order) => {
      const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4,
        l2KB: 2.5, l1KB: 1, order }).cfg;
      const res = MSim.buildTrace(cfg);
      return { reg: res.stats.regBytes, flops: res.stats.flops };
    };
    const def = run(['i2', 'j2', 'k2', 'ir', 'jr', 'kr']);
    const krEarly = run(['i2', 'j2', 'k2', 'kr', 'ir', 'jr']);
    check('kr 前置 → 寄存器流量放大 ' + (krEarly.reg / def.reg).toFixed(1) + '×',
      krEarly.reg > def.reg * 2 && krEarly.flops === def.flops,
      krEarly.reg + ' vs ' + def.reg);
  }
}

console.log('=== 11. 超大矩阵 ===');
{
  const huge = MSim.PRESETS.find((x) => x.id === 'huge');
  check('存在 256³ 超大预设', !!huge && huge.cfg.M === 256);
  const cfg = MSim.normalize(huge.cfg).cfg;
  const res = MSim.buildTrace(cfg);
  check('超大 256³ flops == 2\u00b7N\u00b3', res.stats.flops === 2 * 256 ** 3, res.stats.flops);
  const els = (res.stats.dramRead + res.stats.dramWrite) / 8;
  const lo = 2 * 256 * 256 + 256 * 256 + 256 * 256;
  const hi = 256 ** 3 * (1 / 64 + 1 / 64) + 2 * 256 * 256;
  check('超大 256\u00b3 DRAM 流量 \u2208 [下限, 公式]', els >= lo && els <= hi,
    els + ' \u2208 [' + lo + ', ' + hi + ']');
  check('超大事件量预警 (512\u00b3 无分块触发)',
    MSim.normalize({ M: 512, N: 512, K: 512, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1 })
      .warnings.some((w) => w.indexOf('事件轨迹') === 0));
  check('正常规模无预警', MSim.normalize({ M: 96, N: 96, K: 96, mc: 32, nc: 32, kc: 32, mr: 8, nr: 8 })
    .warnings.length === 0);
}

console.log('=== 13. 并行切分: block 数值正确 / L1 独享 / 共享 L2 / 钳制 ===');
{
  // 13a. 钳制：块数超过面板数时回退
  {
    const n = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, biBlocks: 4, bjBlocks: 1 });
    check('i2 并行块数超面板数时钳制', n.cfg.biBlocks === 2 && n.warnings.length > 0,
      n.cfg.biBlocks);
    check('合法范围内不钳制不警告', (() => {
      const m = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, biBlocks: 2, bjBlocks: 2 });
      return m.cfg.biBlocks === 2 && m.cfg.bjBlocks === 2 && !m.warnings.some((w) => w.indexOf('并行') === 0);
    })());
  }

  // 13b. 全部并行配置数值正确（12³ mc=4 边缘块 + 2×2 切分）
  {
    const N = 12;
    const A = MSim.randMatrix(N, N, 5), B = MSim.randMatrix(N, N, 6);
    const refC = MSim.matmulRef(A, B, N, N, N);
    let ok = 0;
    const configs = [
      { biBlocks: 1, bjBlocks: 1 }, { biBlocks: 2, bjBlocks: 1 },
      { biBlocks: 1, bjBlocks: 2 }, { biBlocks: 2, bjBlocks: 2 },
      { biBlocks: 3, bjBlocks: 3 },
    ];
    for (const bl of configs) {
      const cfg = MSim.normalize({ M: N, N, K: N, mc: 4, nc: 4, kc: 4, mr: 2, nr: 2, ...bl }).cfg;
      const res = MSim.buildTrace(cfg);
      const C = new Float64Array(N * N);
      for (const ev of res.events) {
        if (ev.type !== 'compute') continue;
        for (let ii = 0; ii < ev.mr; ii++)
          for (let jj = 0; jj < ev.nr; jj++)
            C[(ev.i + ii) * N + ev.j + jj] += A[(ev.i + ii) * N + ev.k] * B[ev.k * N + ev.j + jj];
      }
      let err = 0;
      for (let i = 0; i < C.length; i++) err = Math.max(err, Math.abs(C[i] - refC[i]));
      if (err < 1e-9 && res.stats.flops === 2 * N * N * N) ok++;
    }
    check('5 种并行配置全部数值正确', ok === configs.length, ok + '/' + configs.length);
  }

  // 13c. L1 独享：切分后 L1 总容量 = nBlocks×l1Bytes，
  //      Ar/Br 的 L1 命中率不因切分下降（每 block 独立复用）
  {
    const base = { M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 10, l1KB: 3 };
    const l1Hit = (bl) => MSim.buildTrace(MSim.normalize({ ...base, ...bl }).cfg).stats.l1.hit;
    const h1 = l1Hit({}), h2 = l1Hit({ bjBlocks: 2 });
    check('j2 切分 2 block 后 L1 命中总数 ≥ 串行 (L1 独享互不干扰)', h2 >= h1, h2 + ' vs ' + h1);
  }

  // 13d. 共享 L2：i2 切分时 B 面板跨 block 共享读，DRAM 读流量不增
  {
    const run = (bl) => {
      const res = MSim.buildTrace(MSim.normalize({ M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16,
        mr: 4, nr: 4, l2KB: 10, l1KB: 3, ...bl }).cfg);
      return { dram: res.stats.dramRead, flops: res.stats.flops };
    };
    const one = run({}), two = run({ bjBlocks: 2 });
    check('j2 切分 2 block DRAM 读不增（A 面板共享 L2）', two.dram <= one.dram,
      two.dram + ' vs ' + one.dram);
  }

  // 13e. 计算单元池：单元数可单独设置；单元 < 块数时计算在单元上串行排队
  {
    // 计算主导配置（大方阵 + 大面板，算术强度远超带宽脊点），单元数差异
    // 才能在总时间上显现——访存主导配置会被共享带宽项掩盖
    const base = { M: 256, N: 256, K: 512, mc: 128, nc: 128, kc: 128, mr: 16, nr: 16,
      l2KB: 512, l1KB: 256 };
    const run = (bl) => MSim.buildTrace(MSim.normalize({ ...base, ...bl }).cfg).stats;
    // 钳制：单元数 > 块数 → 钳到块数
    const c1 = MSim.normalize({ ...base, biBlocks: 2, nCores: 8 });
    check('计算单元数超过块数时钳制', c1.cfg.nCores === 2 && c1.warnings.length > 0,
      c1.cfg.nCores);
    // 自动（0）与显式 = 块数等价：时间模型结果完全一致
    const auto = run({ biBlocks: 2 });
    const expl = run({ biBlocks: 2, nCores: 2 });
    check('自动计算单元 == 显式块数（totalTime 一致）',
      auto.totalTime === expl.totalTime && auto.nCores === 2 && expl.nCores === 2,
      auto.totalTime + ' vs ' + expl.totalTime);
    // 单元受限：1 单元跑 2 块 → 计算排队，总时间近乎翻倍
    const one = run({ biBlocks: 2, nCores: 1 });
    check('1 单元 2 块慢于 2 单元（计算串行排队）', one.totalTime > expl.totalTime * 1.5,
      one.totalTime.toFixed(0) + ' vs ' + expl.totalTime.toFixed(0));
    check('1 单元加速比 < 2 单元加速比', one.speedup < expl.speedup,
      one.speedup.toFixed(2) + ' vs ' + expl.speedup.toFixed(2));
    // 单元数不影响计算量
    check('受限单元 FLOPs 不变', one.flops === expl.flops && expl.flops === 2 * 256 * 256 * 512,
      one.flops + ' vs ' + expl.flops);
  }

  // 13f. 锁步并行：微内核粒度轮转，compute 事件按 block 逐拍交错，
  //      同一拍内各 block 的 k 相同（动画上可见同步并行推进）
  {
    const base2 = { M: 32, N: 32, K: 32, mc: 16, nc: 16, kc: 16, mr: 4, nr: 4, l2KB: 10, l1KB: 3 };
    const res = MSim.buildTrace(MSim.normalize({ ...base2, biBlocks: 2, bjBlocks: 2 }).cfg);
    const cs = res.events.filter((e) => e.type === 'compute');
    check('compute 事件按 block 锁步轮转 (0,1,2,3,0,…)',
      cs.length >= 8 && cs[0].b === 0 && cs[1].b === 1 && cs[2].b === 2 && cs[3].b === 3 && cs[4].b === 0,
      cs.slice(0, 5).map((e) => e.b).join(','));
    check('锁步：同一拍各 block 的 k 相同，下一拍 +1',
      cs[0].k === cs[1].k && cs[1].k === cs[2].k && cs[2].k === cs[3].k
        && cs[4].k === cs[0].k + 1 && cs[5].k === cs[1].k + 1,
      cs.slice(0, 6).map((e) => 'B' + e.b + ':k' + e.k).join(' '));
    // 单 block 不受锁步影响：compute 事件数恒为 MNK/(mr·nr)，全部属于 B0
    const one = MSim.buildTrace(MSim.normalize(base2).cfg);
    const oneCs = one.events.filter((e) => e.type === 'compute');
    check('单 block 无锁步交错（compute 数恒定）',
      oneCs.length === 32 ** 3 / 16 && oneCs.every((e) => !e.b),
      oneCs.length);
    check('锁步不改变计算量', res.stats.flops === one.stats.flops && one.stats.flops === 2 * 32 ** 3,
      res.stats.flops);
  }

  // 13g. K 轴切分（split-K）暂不支持：跨 block 归约依赖，列入 TODO
  //      （normalize 不处理 kBlocks，传入无效果——此处仅文档化约束）
}

console.log('=== 12. 写路径与链路统计: 脏替换 / 配平 / 实测带宽 / Player 镜像 ===');
{
  // 12a. 默认配置：C 常驻 → 无脏替换；链路流量与既有统计配平
  {
    const cfg = MSim.normalize(MSim.PRESETS[0].cfg).cfg;
    const res = MSim.buildTrace(cfg);
    const L = res.stats.links;
    check('默认配置无脏替换写回', !res.events.some((e) => e.dirty), L['l2>dram'].dirty);
    check('dram>l2 流量 == dramRead', L['dram>l2'].bytes === res.stats.dramRead,
      L['dram>l2'].bytes + ' vs ' + res.stats.dramRead);
    check('l2>l1 流量 == l2Bytes', L['l2>l1'].bytes === res.stats.l2Bytes,
      L['l2>l1'].bytes + ' vs ' + res.stats.l2Bytes);
    check('l2>dram 流量 == dramWrite', L['l2>dram'].bytes === res.stats.dramWrite,
      L['l2>dram'].bytes + ' vs ' + res.stats.dramWrite);
    check('l2>reg 流量 == C 微块字节 (MNK/kc·8)',
      L['l2>reg'].bytes === 16 ** 3 / 8 * 8, L['l2>reg'].bytes);
    check('l1>reg 流量 == 操作数字节 (MNK(1/mr+1/nr)·8)',
      L['l1>reg'].bytes === 16 ** 3 * (1 / 4 + 1 / 4) * 8, L['l1>reg'].bytes);
  }

  // 12b. 实测带宽 < 理论（延迟压制）；大块利用率更高（摊销）
  {
    const cfg = MSim.normalize(MSim.PRESETS[0].cfg).cfg;
    const L = MSim.buildTrace(cfg).stats.links;
    check('dram>l2 实测带宽 < 理论 16B/ns (延迟压制)',
      L['dram>l2'].bw > 0 && L['dram>l2'].bw < 16, L['dram>l2'].bw.toFixed(2));
  }

  // 12c. 脏替换：L2 连 C+A+B 都装不下 → C 载入后被挤出（脏替换冲刷），
  //      最终写回跳过，每 C 面板恰好写回一次（总写 == M·N·8 不变）
  {
    const cfg = MSim.normalize({ M: 16, N: 16, K: 16, mc: 8, nc: 8, kc: 8, mr: 4, nr: 4,
      l2KB: 1.25, l1KB: 1 }).cfg;
    const res = MSim.buildTrace(cfg);
    const dirtyEv = res.events.filter((e) => e.type === 'xfer' && e.dirty);
    check('脏替换写回事件存在且全为 C 面板',
      dirtyEv.length > 0 && dirtyEv.every((e) => e.panel === 'C' && e.store === true),
      dirtyEv.length);
    check('总写 == M\u00b7N\u00b78 (每面板恰写一次)', res.stats.dramWrite === 16 * 16 * 8,
      res.stats.dramWrite);
    check('无分块: C 块无重复写回（脏替换/最终写回恰好各一次）', (() => {
      const cfgN = MSim.normalize({ M: 16, N: 16, K: 16, mc: 1, nc: 1, kc: 1, mr: 1, nr: 1,
        l2KB: 0.125, l1KB: 0.0625 }).cfg;
      const resN = MSim.buildTrace(cfgN);
      const writes = {};
      for (const e of resN.events) {
        if (e.type === 'xfer' && e.store) writes[e.id] = (writes[e.id] || 0) + 1;
      }
      const ids = Object.keys(writes);
      return ids.length === 256 && ids.every((id) => writes[id] === 1)
        && resN.stats.dramWrite === 16 * 16 * 8;
    })());
  }

  // 12d. Player 链路镜像 == 模拟器链路统计（终态一致）
  {
    const cfg = MSim.normalize(MSim.PRESETS[0].cfg).cfg;
    const res = MSim.buildTrace(cfg);
    const A = MSim.randMatrix(cfg.M, cfg.K, 1), B = MSim.randMatrix(cfg.K, cfg.N, 2);
    const player = new MPlayer({ events: res.events, cfg, A, B, refC: null });
    player.seekEnd();
    const keys = new Set([...Object.keys(player.links), ...Object.keys(res.stats.links)]);
    let same = true;
    for (const k of keys) {
      const a = player.links[k] || { bytes: 0, ns: 0, n: 0, dirty: 0 };
      const b = res.stats.links[k] || { bytes: 0, ns: 0, n: 0, dirty: 0 };
      if (a.bytes !== b.bytes || Math.abs(a.ns - b.ns) > 1e-6 || a.n !== b.n || a.dirty !== b.dirty) same = false;
    }
    check('Player 链路镜像 == 模拟器统计', same, JSON.stringify(player.links));
  }
}

if (failures) {
  console.error('\n\u2717 ' + failures + ' 项失败');
  process.exit(1);
} else {
  console.log('\n全部通过 \u2713');
}
