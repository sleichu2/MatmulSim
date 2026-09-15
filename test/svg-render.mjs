/* ============================================================
 * test/svg-render.mjs — 视觉验证（无浏览器）
 *
 * 用一个「Canvas2D 子集 → SVG」适配器在 node 中执行真实渲染代码，
 * 输出各画布的 SVG 快照，再用 macOS qlmanage 转 PNG 人工查看：
 *   node test/svg-render.mjs            # 生成 test/shots/*.svg
 *   qlmanage -t -s 2048 -o test/shots test/shots/main.svg ...
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = join(root, 'test', 'shots');
mkdirSync(shotsDir, { recursive: true });

/* ---------- Canvas2D 子集 → SVG ---------- */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex8 = (c) => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (!m) return c;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
};

function makeSvgCanvas() {
  const ops = [];
  const state = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, dash: '', dashOffset: 0,
  };
  const path = { d: '', started: false };
  const anchor = { left: 'start', center: 'middle', right: 'end' };
  const base = {
    alphabetic: 'alphabetic', middle: 'central', top: 'hanging', bottom: 'alphabetic',
    hanging: 'hanging', ideographic: 'ideographic',
  };
  const attr = (o = {}) => {
    const f = o.fill !== undefined ? o.fill : hex8(state.fillStyle);
    const s = o.stroke !== undefined ? o.stroke : hex8(state.strokeStyle);
    let str = `fill="${f}"`;
    if (s !== 'none') {
      str += ` stroke="${s}" stroke-width="${state.lineWidth}"`;
      if (state.dash) str += ` stroke-dasharray="${state.dash}" stroke-dashoffset="${state.dashOffset}"`;
    }
    if (state.globalAlpha !== 1) str += ` opacity="${+state.globalAlpha.toFixed(3)}"`;
    return str;
  };
  const ctx = {
    canvas: null,
    setTransform() {},
    clearRect() {},
    fillRect(x, y, w, h) { ops.push(`<rect x="${+x.toFixed(2)}" y="${+y.toFixed(2)}" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" ${attr({ stroke: 'none' })}/>`); },
    strokeRect(x, y, w, h) { ops.push(`<rect x="${+x.toFixed(2)}" y="${+y.toFixed(2)}" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" ${attr({ fill: 'none' })}/>`); },
    beginPath() { path.d = ''; path.started = false; },
    moveTo(x, y) { path.d += `M${+x.toFixed(2)},${+y.toFixed(2)}`; path.started = true; },
    lineTo(x, y) { path.d += `L${+x.toFixed(2)},${+y.toFixed(2)}`; },
    quadraticCurveTo(cx, cy, x, y) { path.d += `Q${+cx.toFixed(2)},${+cy.toFixed(2)},${+x.toFixed(2)},${+y.toFixed(2)}`; },
    arcTo(x1, y1, x2, y2, r) {
      // 简化：直线段近似（视觉验证足够）
      if (!path.started) { path.d += `M${+x1.toFixed(2)},${+y1.toFixed(2)}`; path.started = true; }
      path.d += `L${+x2.toFixed(2)},${+y2.toFixed(2)}`;
    },
    arc(cx, cy, r, a0, a1) {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
      const sweep = a1 > a0 ? 1 : 0;
      if (!path.started) { path.d += `M${+x0.toFixed(2)},${+y0.toFixed(2)}`; path.started = true; }
      path.d += `A${+r.toFixed(2)},${+r.toFixed(2)},0,${large},${sweep},${+x1.toFixed(2)},${+y1.toFixed(2)}`;
    },
    closePath() { path.d += 'Z'; },
    stroke() { if (path.d) ops.push(`<path d="${path.d}" ${attr({ fill: 'none' })}/>`); },
    fill() { if (path.d) ops.push(`<path d="${path.d}" ${attr({ stroke: 'none' })}/>`); },
    fillText(text, x, y) {
      ops.push(`<text x="${+x.toFixed(2)}" y="${+y.toFixed(2)}" font-family="Menlo, monospace" font-size="${(parseFloat(state.font) || 10).toFixed(1)}" fill="${hex8(state.fillStyle)}" text-anchor="${anchor[state.textAlign] || 'start'}" dominant-baseline="${base[state.textBaseline] || 'alphabetic'}"${state.globalAlpha !== 1 ? ` opacity="${+state.globalAlpha.toFixed(3)}"` : ''}>${xmlEsc(text)}</text>`);
    },
    setLineDash(a) { state.dash = a && a.length ? a.join(' ') : ''; },
    drawImage(src, dx, dy, dw, dh) {
      // src 可能是裸 canvas(带 __svg) 或 DOM 桩 El(带 _svg)
      const c = src && src.__svg ? src : (src && src._svg ? src._svg : null);
      if (!c || !c.__svg) return;
      const sw = c.__svg.w || 1, sh = c.__svg.h || 1;
      ops.push(`<g transform="translate(${+dx.toFixed(2)},${+dy.toFixed(2)}) scale(${+(dw / sw).toFixed(4)},${+(dh / sh).toFixed(4)})">`);
      ops.push(...c.__svg.ops);
      ops.push('</g>');
    },
    // 状态属性（写入 state）
    set fillStyle(v) { state.fillStyle = v; }, get fillStyle() { return state.fillStyle; },
    set strokeStyle(v) { state.strokeStyle = v; }, get strokeStyle() { return state.strokeStyle; },
    set lineWidth(v) { state.lineWidth = v; }, get lineWidth() { return state.lineWidth; },
    set font(v) { state.font = v; }, get font() { return state.font; },
    set textAlign(v) { state.textAlign = v; }, get textAlign() { return state.textAlign; },
    set textBaseline(v) { state.textBaseline = v; }, get textBaseline() { return state.textBaseline; },
    set globalAlpha(v) { state.globalAlpha = v; }, get globalAlpha() { return state.globalAlpha; },
    set lineDashOffset(v) { state.dashOffset = v; }, get lineDashOffset() { return state.dashOffset; },
  };
  const canvas = {
    __svg: { ops, w: 0, h: 0 },
    width: 0, height: 0, style: {},
    getContext() { ctx.canvas = canvas; return ctx; },
  };
  return canvas;
}

/* ---------- DOM 桩（canvas 用 SVG 实现） ---------- */
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
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this._svg = tag === 'canvas' ? makeSvgCanvas() : null;
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {} };
  }
  set id(v) { this._id = v; if (v) byId.set(v, this); }
  get id() { return this._id; }
  set width(v) { this._svg.__svg.w = v; }
  get width() { return this._svg ? this._svg.__svg.w : 0; }
  set height(v) { this._svg.__svg.h = v; }
  get height() { return this._svg ? this._svg.__svg.h : 0; }
  appendChild(c) { this.children.push(c); return c; }
  querySelectorAll() { return this.children.filter((c) => c.tagName === 'BUTTON'); }
  getContext() { return this._svg.getContext(); }
  getBoundingClientRect() { return { width: 1180, height: 660 }; }
}
const STATIC_IDS = [
  'canvasMain', 'canvasMem', 'canvasTimeline', 'canvasRoofline', 'mainView', 'mainHud',
  'presetBar', 'btnPlay', 'btnReset', 'btnEnd', 'btnStep', 'selStep', 'rngSpeed', 'lblSpeed',
  'configPanel', 'btnApply', 'btnReseed', 'cfgNote', 'chkAutoCache',
  'inL2', 'inL1', 'inM', 'inN', 'inK', 'inMc', 'inNc', 'inKc', 'inMr', 'inNr', 'inSeed',
  'selView', 'progressFill', 'progressText', 'statsBody', 'rooflineNote', 'legend', 'codeView',
];
STATIC_IDS.forEach((id) => byId.set(id, new El(id.startsWith('canvas') ? 'canvas' : 'div')));
const documentStub = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => new El(tag),
  body: new El('body'),
};

/* ---------- 沙箱 ---------- */
let rafCb = null;
let nowMs = 0;
const roCallbacks = [];
const sandbox = {
  console,
  performance: { now: () => nowMs },
  requestAnimationFrame: (f) => { rafCb = f; return 1; },
  ResizeObserver: class { constructor(fn) { roCallbacks.push(fn); } observe() {} },
  addEventListener: () => {},
  devicePixelRatio: 1,
  document: documentStub,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const files = ['js/util.js', 'js/sim.js', 'js/player.js', 'js/render-main.js',
  'js/render-mem.js', 'js/render-charts.js', 'js/render-code.js', 'js/ui.js', 'js/main.js'];
const code = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n;\n');
vm.runInContext(code, sandbox, { filename: 'app.js' });

// 触发 ResizeObserver（设置画布逻辑尺寸）
roCallbacks.forEach((fn) => fn());

function frame(dt) { nowMs += dt; rafCb(nowMs); }
function svgOf(id) {
  const c = byId.get(id)._svg;
  const w = c.__svg.w || 800, h = c.__svg.h || 400;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  s += `<rect width="${w}" height="${h}" fill="#11161d"/>`;
  s += c.__svg.ops.join('');
  s += '</svg>';
  return s;
}
const dump = (name) => {
  writeFileSync(join(shotsDir, name + '.svg'), svgOf(name === 'main' ? 'canvasMain' : name === 'mem' ? 'canvasMem' : name === 'timeline' ? 'canvasTimeline' : 'canvasRoofline'));
};

/* ---------- 场景 ---------- */
frame(16); frame(16);
dump('main'); dump('mem'); dump('timeline'); dump('roofline');
writeFileSync(join(shotsDir, '01-initial.svg'), svgOf('canvasMain'));

// 播放 4 秒
byId.get('btnPlay').onclick();
for (let i = 0; i < 80; i++) frame(50);
writeFileSync(join(shotsDir, '02-playing.svg'), svgOf('canvasMain'));
writeFileSync(join(shotsDir, '02-mem.svg'), svgOf('canvasMem'));

// 运行到结束
byId.get('btnEnd').onclick();
frame(16);
writeFileSync(join(shotsDir, '03-done.svg'), svgOf('canvasMain'));
writeFileSync(join(shotsDir, '03-mem.svg'), svgOf('canvasMem'));
writeFileSync(join(shotsDir, '03-roofline.svg'), svgOf('canvasRoofline'));

// 热度视图
byId.get('selView').value = 'heat';
byId.get('btnApply').onclick();
frame(16);
byId.get('btnEnd').onclick();
frame(16);
writeFileSync(join(shotsDir, '04-heat.svg'), svgOf('canvasMain'));

// 无分块预设（部分播放）
const naive = byId.get('presetBar').children.find((c) => c.dataset.id === 'naive');
naive.onclick();
frame(16);
byId.get('btnPlay').onclick();
for (let i = 0; i < 60; i++) frame(50);
writeFileSync(join(shotsDir, '05-naive.svg'), svgOf('canvasMain'));

// 大型预设（运行到结束 → roofline 完整）
const large = byId.get('presetBar').children.find((c) => c.dataset.id === 'large');
large.onclick();
frame(16);
byId.get('btnEnd').onclick();
frame(16);
writeFileSync(join(shotsDir, '06-large.svg'), svgOf('canvasMain'));
writeFileSync(join(shotsDir, '06-large-mem.svg'), svgOf('canvasMem'));
writeFileSync(join(shotsDir, '06-large-roofline.svg'), svgOf('canvasRoofline'));

console.log('SVG 快照已输出到 ' + shotsDir);
console.log('转 PNG:  qlmanage -t -s 2048 -o ' + shotsDir + ' ' + join(shotsDir, '02-playing.svg'));
