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

if (failures) {
  console.error('\n\u2717 ' + failures + ' 项失败');
  process.exit(1);
} else {
  console.log('\n全部通过 \u2713');
}
