/* ============================================================
 * test/dom-smoke.mjs — 渲染层冒烟测试（无浏览器）
 *
 * 用最小 DOM/Canvas 桩在 node 中执行全部渲染与 UI 代码路径，
 * 捕获引用错误（typo、未定义变量等），并断言运行状态：
 * 播放到结束、统计面板数值、预设切换、配置面板、键盘快捷键。
 * 运行: node test/dom-smoke.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- 最小 DOM 桩（诚实版：未注册 id 返回 null，与真实浏览器一致） ---------- */
function makeCtxProxy() {
  const target = { canvas: null };
  return new Proxy(target, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k in t) return t[k];
      return () => 0; // 任意方法都返回 0（fillRect/strokeRect/fillText/...）
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const byId = new Map();

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.className = '';
    this.checked = false;
    this.disabled = false;
    this.width = 0;
    this.height = 0;
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this._ctx = null;
    this.classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
    };
  }
  set id(v) { this._id = v; if (v) byId.set(v, this); }
  get id() { return this._id; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  querySelectorAll() { return this.children.filter((c) => c.tagName === 'BUTTON'); }
  getContext() { if (!this._ctx) { this._ctx = makeCtxProxy(); this._ctx.canvas = this; } return this._ctx; }
  getBoundingClientRect() { return { width: 1200, height: 700 }; }
}

function makeEl(tag) { return new El(tag); }

// index.html 中存在的全部 id（应用按 id 查询）
const STATIC_IDS = [
  'canvasMain', 'canvasMem', 'canvasHier', 'canvasTimeline', 'canvasRoofline', 'mainView', 'mainHud',
  'presetBar', 'btnPlay', 'btnReset', 'btnEnd', 'btnStep', 'selStep', 'rngSpeed', 'lblSpeed',
  'configPanel', 'btnApply', 'btnReseed', 'cfgNote', 'chkAutoCache',
  'inL2', 'inL1', 'inM', 'inN', 'inK', 'inMc', 'inNc', 'inKc', 'inMr', 'inNr', 'inSeed',
  'selView', 'selOrder', 'progressFill', 'progressText', 'statsBody', 'rooflineNote', 'legend', 'codeView',
];
STATIC_IDS.forEach((id) => byId.set(id, makeEl(/^canvas/.test(id) ? 'canvas' : 'div')));

const documentStub = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => makeEl(tag),
  body: makeEl('body'),
};

/* ---------- 沙箱 ---------- */
let rafCb = null;
const roCallbacks = [];
let nowMs = 0;
const keyHandlers = [];
const sandbox = {
  console,
  performance: { now: () => nowMs },
  requestAnimationFrame: (f) => { rafCb = f; return 1; },
  ResizeObserver: class { constructor(fn) { roCallbacks.push(fn); } observe() {} },
  addEventListener: (t, fn) => { if (t === 'keydown') keyHandlers.push(fn); },
  devicePixelRatio: 2,
  document: documentStub,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

/* ---------- 加载脚本 ---------- */
const files = ['js/util.js', 'js/sim.js', 'js/player.js', 'js/render-main.js',
  'js/render-mem.js', 'js/render-hier.js', 'js/render-charts.js', 'js/render-code.js',
  'js/ui.js', 'js/main.js'];
const code = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n;\n');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  \u2713 ' + name);
  else { failures++; console.error('  \u2717 ' + name + (detail !== undefined ? '   (' + detail + ')' : '')); }
}

let errs = [];
try {
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  errs.push('boot: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
}

function frame(dt) {
  nowMs += dt;
  try { rafCb(nowMs); } catch (e) { errs.push('frame: ' + e.message); }
}
function press(el) {
  try { el.onclick(); } catch (e) { errs.push('click: ' + e.message); }
}

check('启动无异常', errs.length === 0, errs[0]);

/* 初始渲染 */
frame(16);
frame(16);
check('初始渲染无异常', errs.length === 0, errs[0]);

const codeLines = () => byId.get('codeView').children;
const activeLine = () => codeLines().findIndex((c) => (c.className || '').indexOf('active') >= 0);
check('伪代码面板生成 14 行', codeLines().length === 14, codeLines().length);
check('初始无高亮行', activeLine() === -1, activeLine());

/* 播放到结束（小型预设 ~10s 墙钟 @1×，每帧 50ms → ~200 帧） */
press(byId.get('btnPlay'));
for (let i = 0; i < 260 && errs.length === 0; i++) frame(50);
check('播放过程无异常', errs.length === 0, errs[0]);
check('播放到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);
check('播放按钮变 ↻', byId.get('btnPlay').textContent === '↻', byId.get('btnPlay').textContent);
check('FLOPs 统计完整', byId.get('stFlops').textContent.indexOf('/ 8.2K') >= 0, byId.get('stFlops').textContent);
check('数值校验通过', byId.get('stErr').textContent.indexOf('✓') === 0, byId.get('stErr').textContent);

/* 伪代码面板：播放结束时最后事件 = C 面板写回 → 第 14 行高亮，i2 收敛到最后一块 */
check('伪代码高亮=写回行(14)', activeLine() === 13, activeLine());
const i2Chip = codeLines()[0].children[3].children[0].textContent;
check('伪代码循环变量 i2 收敛', i2Chip === 'i2=8', i2Chip);
check('伪代码轮次 2/2', codeLines()[0].children[3].children[2].textContent === '2/2',
  codeLines()[0].children[3].children[2].textContent);

/* 单步与重置 */
byId.get('btnPlay').onclick(); // ↻ → 重置并播放
for (let i = 0; i < 4; i++) frame(16);
press(byId.get('btnReset'));
frame(16);
check('重置后进度归零', byId.get('progressText').textContent.indexOf('0.0%') >= 0,
  byId.get('progressText').textContent);
check('重置后伪代码无高亮', activeLine() === -1, activeLine());

/* k 步单步 */
byId.get('selStep').value = 'k';
for (let i = 0; i < 3; i++) press(byId.get('btnStep'));
frame(16);
check('单步无异常', errs.length === 0, errs[0]);
check('单步后伪代码高亮微内核行(13)', activeLine() === 12, activeLine());

/* 无分块预设 */
const naiveBtn = byId.get('presetBar').children.find((c) => c.dataset.id === 'naive');
press(naiveBtn);
frame(16);
press(byId.get('btnEnd'));
frame(16);
check('无分块预设运行到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);

/* 缓存受限预设 → 统计中应出现超容量 3 */
const tightBtn = byId.get('presetBar').children.find((c) => c.dataset.id === 'tight');
press(tightBtn);
frame(16);
press(byId.get('btnEnd'));
frame(16);
check('缓存受限: 超容量 3', byId.get('stL2c').textContent.indexOf('超容量 3') >= 0,
  byId.get('stL2c').textContent);

/* 配置面板：改尺寸并应用 */
byId.get('inM').value = '24';
byId.get('inN').value = '24';
byId.get('inK').value = '24';
press(byId.get('btnApply'));
frame(16);
check('自定义配置应用无异常', errs.length === 0, errs[0]);
check('配置回填 M=24', String(byId.get('inM').value) === '24');

/* 自动容量：按面板工作集给容量，L1 不得乒乓（Ar+Br 装得下） */
byId.get('chkAutoCache').checked = true;
byId.get('inM').value = '16';
byId.get('inN').value = '16';
byId.get('inK').value = '16';
byId.get('inMc').value = '8';
byId.get('inNc').value = '8';
byId.get('inKc').value = '8';
byId.get('inMr').value = '4';
byId.get('inNr').value = '4';
press(byId.get('btnApply'));
frame(16);
check('自动容量应用无异常', errs.length === 0, errs[0]);
check('自动容量 L2 回填 2.5KB', String(byId.get('inL2').value) === '2.5', byId.get('inL2').value);
check('自动容量 L1 回填 1KB', String(byId.get('inL1').value) === '1', byId.get('inL1').value);
press(byId.get('btnEnd'));
frame(16);
check('自动容量运行到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);
check('自动容量无超容量', byId.get('stL2c').textContent.indexOf('超容量 0') >= 0,
  byId.get('stL2c').textContent);
const l1cAuto = byId.get('stL1c').textContent;
check('自动容量 L1 有命中(不乒乓)', /命中 (\d+)/.exec(l1cAuto) && parseInt(/命中 (\d+)/.exec(l1cAuto)[1], 10) > 0, l1cAuto);
byId.get('chkAutoCache').checked = false;

/* 预设切换关闭自动容量（预设自带容量） */
byId.get('chkAutoCache').checked = true;
const tightBtn2 = byId.get('presetBar').children.find((c) => c.dataset.id === 'tight');
press(tightBtn2);
frame(16);
check('预设切换后自动容量被关闭', byId.get('chkAutoCache').checked === false);
check('预设自带容量不被覆盖', String(byId.get('inL2').value) === '1', byId.get('inL2').value);

/* 循环顺序：下拉应有 90 项；切非默认顺序 → 应用 → 播放 → 伪代码面板重建 */
check('循环序下拉 90 项', byId.get('selOrder').children.length === 90,
  byId.get('selOrder').children.length);
byId.get('selOrder').value = 'i2,j2,k2,kr,ir,jr';
press(byId.get('btnApply'));
frame(16);
check('自定义循环序应用无异常', errs.length === 0, errs[0]);
check('循环序伪代码仍 14 行', codeLines().length === 14, codeLines().length);
press(byId.get('btnEnd'));
frame(16);
check('自定义循环序运行到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);
check('自定义循环序数值校验', byId.get('stErr').textContent.indexOf('✓') === 0,
  byId.get('stErr').textContent);
check('自定义循环序结束高亮写回行', activeLine() === 13, activeLine());
byId.get('selOrder').value = 'i2,j2,k2,ir,jr,kr';
press(byId.get('btnApply'));
frame(16);
check('恢复默认循环序无异常', errs.length === 0, errs[0]);

/* 超大预设：256³ 构建 + 跑到结束 */
const hugeBtn = byId.get('presetBar').children.find((c) => c.dataset.id === 'huge');
press(hugeBtn);
frame(16);
press(byId.get('btnEnd'));
frame(16);
check('超大 256³ 运行到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);
check('超大 256³ 数值校验', byId.get('stErr').textContent.indexOf('✓') === 0,
  byId.get('stErr').textContent);

/* 热度视图切换 */
byId.get('selView').value = 'heat';
press(byId.get('btnApply'));
press(byId.get('btnEnd'));
frame(16);
check('热度视图运行到结束', byId.get('progressText').textContent.indexOf('完成') >= 0,
  byId.get('progressText').textContent);

/* 键盘快捷键 */
keyHandlers.forEach((h) => {
  try { h({ code: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault: () => {} }); } catch (e) { errs.push('key: ' + e.message); }
});
frame(16);
check('键盘单步无异常', errs.length === 0, errs[0]);

/* 窗口缩放（ResizeObserver 回调） */
roCallbacks.forEach((fn) => {
  try { fn(); } catch (e) { errs.push('resize: ' + e.message); }
});
frame(16);
check('缩放重排无异常', errs.length === 0, errs[0]);

/* 速度调节 */
byId.get('rngSpeed').oninput({ target: { value: '8' } });
frame(16);
check('速度调节无异常', errs.length === 0, errs[0]);

if (failures) {
  console.error('\n\u2717 ' + failures + ' 项失败');
  process.exit(1);
} else {
  console.log('\nDOM 冒烟测试全部通过 \u2713');
}
