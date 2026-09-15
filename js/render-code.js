/* ============================================================
 * render-code.js — 伪代码面板：切分与循环的实时回放
 *
 * 静态展示与 sim.js buildTrace 逐行对应的 6 层循环伪代码，
 * 回放时随事件实时更新：
 *  - 当前事件对应的代码行高亮（载入蓝 / 计算绿 / 写回橙），
 *    行尾标注 命中✓ / 未中 / 级联 / 超容量 / FLOP 等状态
 *  - 6 个循环变量 i2/j2/k2/ir/jr/kr 的当前值、轮次 x/y 与
 *    迷你进度条实时推进——直观呈现「切分」的执行情况
 *
 * 事件 → 代码行 映射（依据 trace 事件结构）：
 *   xfer(dram→l2, C) → 3 行     hit/oversize/xfer(A:|B:) → 5/6 行
 *   hit/oversize/xfer(Ar:|Br:) → 8/10 行    reg → 11 行
 *   compute → 13 行    xfer(l2→dram) → 14 行
 *   evict → 伴随事件，不改行（随后紧跟的搬运事件会更新）
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  /* 行定义: t=代码文本(每层缩进 1 空格)  k=行类型 loop|load|compute|store
   *         v=循环变量名  lv=所属缓存层级徽章 l2|l1|reg */
  const LINES = [
    { t: 'for i2 = 0 .. M step mc', k: 'loop', v: 'i2', lv: 'l2' },
    { t: ' for j2 = 0 .. N step nc', k: 'loop', v: 'j2', lv: 'l2' },
    { t: '  load C[i2:+mc, j2:+nc] → L2', k: 'load' },
    { t: '  for k2 = 0 .. K step kc', k: 'loop', v: 'k2', lv: 'l2' },
    { t: '   load A[i2:+mc, k2:+kc] → L2', k: 'load' },
    { t: '   load B[k2:+kc, j2:+nc] → L2', k: 'load' },
    { t: '   for ir = i2 .. +mc step mr', k: 'loop', v: 'ir', lv: 'l1' },
    { t: '    load Ar[ir:+mr, k2:+kc] → L1', k: 'load' },
    { t: '    for jr = j2 .. +nc step nr', k: 'loop', v: 'jr', lv: 'l1' },
    { t: '     load Br[k2:+kc, jr:+nr] → L1', k: 'load' },
    { t: '     load C[ir:+mr, jr:+nr] → Reg', k: 'load' },
    { t: '     for kr = k2 .. +kc step 1', k: 'loop', v: 'kr', lv: 'reg' },
    { t: '      C[ir:+mr, jr:+nr] += A[:,kr] ⊗ B[kr,:]', k: 'compute' },
    { t: '  write C[i2:+mc, j2:+nc] → DRAM', k: 'store' },
  ];

  const LOOP_VAR_IDS = { i2: 1, j2: 1, k2: 1, ir: 1, jr: 1, kr: 1 };
  const PARAM_IDS = { mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, M: 1, N: 1, K: 1 };

  class CodeView {
    constructor(root) {
      this.root = root;
      this.cfg = null;
      this.rows = [];
      this.st = this.freshState();
      this.sig = null;
      this.build();
    }

    freshState() {
      return {
        line: 0, tag: { text: '', cls: '' },
        i2: null, j2: null, k2: null, ir: null, jr: null, kr: null,
      };
    }

    /* ---------- DOM 构建（一次性） ---------- */
    build() {
      const doc = global.document;
      LINES.forEach((def, i) => {
        const el = doc.createElement('div');
        el.className = 'cl cl-' + def.k;
        const num = doc.createElement('span');
        num.className = 'cl-n';
        num.textContent = i + 1;
        el.appendChild(num);
        if (def.lv) {
          const badge = doc.createElement('i');
          badge.className = 'cl-badge ' + def.lv;
          badge.textContent = def.lv === 'reg' ? 'REG' : def.lv.toUpperCase();
          el.appendChild(badge);
        }
        const code = doc.createElement('span');
        code.className = 'cl-t';
        this.appendTokens(code, def.t);
        el.appendChild(code);

        const right = doc.createElement('span');
        right.className = 'cl-r';
        const row = { el, kind: def.k, varName: def.v || null };
        if (def.k === 'loop') {
          const val = doc.createElement('b');
          val.className = 'cl-val';
          val.textContent = def.v + '=—';
          const barWrap = doc.createElement('i');
          barWrap.className = 'cl-bar';
          const bar = doc.createElement('u');
          barWrap.appendChild(bar);
          const cnt = doc.createElement('em');
          cnt.className = 'cl-cnt';
          right.appendChild(val);
          right.appendChild(barWrap);
          right.appendChild(cnt);
          row.val = val; row.bar = bar; row.cnt = cnt;
        } else {
          const tag = doc.createElement('b');
          tag.className = 'cl-tag';
          right.appendChild(tag);
          row.tag = tag;
        }
        el.appendChild(right);
        this.root.appendChild(el);
        this.rows.push(row);
      });
    }

    /** 简易语法着色：关键字 / 循环变量 / 尺寸参数 / 矩阵名 */
    appendTokens(parent, text) {
      const doc = global.document;
      text.split(/([A-Za-z_][A-Za-z0-9_]*)/).forEach((p) => {
        if (!p) return;
        const s = doc.createElement('span');
        s.textContent = p;
        let cls = '';
        if (p === 'for' || p === 'step' || p === 'load' || p === 'write') cls = 'w-k';
        else if (LOOP_VAR_IDS[p]) cls = 'w-v';
        else if (PARAM_IDS[p]) cls = 'w-p';
        else if (p === 'A' || p === 'Ar') cls = 'w-a';
        else if (p === 'B' || p === 'Br') cls = 'w-b';
        else if (p === 'C') cls = 'w-c';
        if (cls) s.className = cls;
        parent.appendChild(s);
      });
    }

    /* ---------- 状态 ---------- */
    setConfig(cfg) { this.cfg = cfg; this.reset(); }

    reset() {
      this.st = this.freshState();
      this.sig = null;
      this.draw();
    }

    /* 事件 id → 代码行号（1 基） */
    lineOfId(id) {
      if (id.indexOf('Ar') === 0) return 8;
      if (id.indexOf('Br') === 0) return 10;
      if (id.charAt(0) === 'A') return 5;
      if (id.charAt(0) === 'B') return 6;
      return 3;
    }

    /* 事件 id 中解析循环变量坐标（块索引×块尺寸；块内起点用 round 复原） */
    coordsOf(id) {
      const c = this.cfg;
      const st = this.st;
      if (!c || !id) return {};
      const m = id.split(':');
      const n = (s) => parseInt(s, 10) || 0;
      switch (m[0]) {
        case 'C': return { i2: n(m[1]) * c.mc, j2: n(m[2]) * c.nc };
        case 'A': return { i2: n(m[1]) * c.mc, k2: n(m[2]) * c.kc };
        case 'B': return { k2: n(m[1]) * c.kc, j2: n(m[2]) * c.nc };
        case 'Ar': {
          const i2 = st.i2 == null ? 0 : st.i2;
          return { ir: i2 + Math.round((n(m[1]) * c.mr - i2) / c.mr) * c.mr, k2: n(m[2]) * c.kc };
        }
        case 'Br': {
          const j2 = st.j2 == null ? 0 : st.j2;
          return { jr: j2 + Math.round((n(m[2]) * c.nr - j2) / c.nr) * c.nr, k2: n(m[1]) * c.kc };
        }
        default: return {};
      }
    }

    /** 每个回放事件 → 更新当前行与循环变量 */
    onEvent(ev) {
      const st = this.st;
      const assign = (o) => { for (const key in o) st[key] = o[key]; };
      switch (ev.type) {
        case 'compute':
          st.line = 13;
          st.tag = { text: ev.flops + ' FLOP', cls: 'calc' };
          assign({ i2: ev.i2, j2: ev.j2, k2: ev.k2, ir: ev.i, jr: ev.j, kr: ev.k });
          break;
        case 'reg':
          st.line = 11;
          st.tag = { text: ev.rows + '×' + ev.cols, cls: 'reg' };
          assign({ ir: ev.i, jr: ev.j });
          break;
        case 'hit':
          st.line = this.lineOfId(ev.id);
          st.tag = { text: '命中 ✓', cls: 'hit' };
          assign(this.coordsOf(ev.id));
          break;
        case 'oversize':
          st.line = this.lineOfId(ev.id);
          st.tag = { text: '超容量 · ' + U.fmtBytes(ev.bytes), cls: 'warn' };
          assign(this.coordsOf(ev.id));
          break;
        case 'xfer':
          if (ev.panel === 'C' && ev.to === 'l2') {        // C 面板 → L2
            st.line = 3;
            st.tag = ev.oversize
              ? { text: '超容量 · ' + U.fmtBytes(ev.bytes), cls: 'warn' }
              : { text: '未中 · ' + U.fmtBytes(ev.bytes), cls: 'miss' };
            assign({ i2: ev.i2, j2: ev.j2 });
          } else if (ev.to === 'dram') {                   // C 面板写回
            st.line = 14;
            st.tag = { text: '写回 · ' + U.fmtBytes(ev.bytes), cls: 'store' };
            assign({ i2: ev.i2, j2: ev.j2 });
          } else if (ev.to === 'l2') {                     // A / B 面板 → L2
            st.line = ev.id.charAt(0) === 'A' ? 5 : 6;
            st.tag = { text: '未中 · ' + U.fmtBytes(ev.bytes), cls: 'miss' };
            assign(this.coordsOf(ev.id));
          } else {                                         // → L1: Ar / Br 微面板
            st.line = ev.id.indexOf('Ar') === 0 ? 8 : 10;
            st.tag = ev.cascade
              ? { text: '级联 · ' + U.fmtBytes(ev.bytes), cls: 'warn' }
              : { text: '未中 · ' + U.fmtBytes(ev.bytes), cls: 'miss' };
            assign(this.coordsOf(ev.id));
          }
          break;
        default: break; // evict 为伴随事件，不改行
      }
    }

    /* 循环变量的当前值与轮次 x/y（依配置和所在块的边缘尺寸推导） */
    loopInfo(name) {
      const c = this.cfg, s = this.st;
      if (!c) return null;
      if (name === 'i2') {
        if (s.i2 == null) return null;
        return { v: s.i2, x: s.i2 / c.mc + 1, y: Math.ceil(c.M / c.mc) };
      }
      if (name === 'j2') {
        if (s.j2 == null) return null;
        return { v: s.j2, x: s.j2 / c.nc + 1, y: Math.ceil(c.N / c.nc) };
      }
      if (name === 'k2') {
        if (s.k2 == null) return null;
        return { v: s.k2, x: s.k2 / c.kc + 1, y: Math.ceil(c.K / c.kc) };
      }
      if (name === 'ir') {
        if (s.ir == null || s.i2 == null) return null;
        const rows = Math.min(c.mc, c.M - s.i2);
        return { v: s.ir, x: Math.round((s.ir - s.i2) / c.mr) + 1, y: Math.ceil(rows / c.mr) };
      }
      if (name === 'jr') {
        if (s.jr == null || s.j2 == null) return null;
        const cols = Math.min(c.nc, c.N - s.j2);
        return { v: s.jr, x: Math.round((s.jr - s.j2) / c.nr) + 1, y: Math.ceil(cols / c.nr) };
      }
      if (s.kr == null || s.k2 == null) return null;
      const depth = Math.min(c.kc, c.K - s.k2);
      return { v: s.kr, x: s.kr - s.k2 + 1, y: depth };
    }

    /* 应用到 DOM（状态签名未变则跳过，避免每帧重写） */
    draw() {
      const s = this.st;
      const sig = s.line + '|' + s.tag.text + '|' + s.i2 + ',' + s.j2 + ','
        + s.k2 + ',' + s.ir + ',' + s.jr + ',' + s.kr;
      if (sig === this.sig) return;
      this.sig = sig;
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i];
        const active = s.line === i + 1;
        r.el.className = 'cl cl-' + r.kind + (active ? ' active' : '');
        if (r.kind === 'loop') {
          const info = this.loopInfo(r.varName);
          r.val.textContent = r.varName + '=' + (info ? info.v : '—');
          r.cnt.textContent = info ? info.x + '/' + info.y : '';
          r.bar.style.width = info ? Math.round(100 * info.x / info.y) + '%' : '0%';
        } else {
          r.tag.textContent = active ? s.tag.text : '';
          r.tag.className = 'cl-tag' + (active ? ' ' + s.tag.cls : '');
        }
      }
    }
  }

  global.MCodeView = CodeView;
})(typeof window !== 'undefined' ? window : globalThis);