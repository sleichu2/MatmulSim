/* ============================================================
 * render-code.js — 伪代码面板：切分与循环的实时回放
 *
 * 伪代码行按 cfg.order（6 层循环嵌套顺序，外→内）动态生成：
 * 每条 load 语句挂在其坐标依赖中「最内层」的循环体内，乘加语句
 * 在 inner(ir,jr,kr) 循环体内，C 写回在 inner(i2,j2) 循环体之后
 * ——与 sim.js 的执行引擎同一套绑定规则，任意合法顺序下都与
 * 回放事件一一对应。
 *
 * 回放时随事件实时更新：
 *  - 当前事件对应的代码行高亮（载入蓝 / 计算绿 / 写回橙），
 *    行尾标注 命中✓ / 未中 / 级联 / 超容量 / FLOP 等状态
 *  - 6 个循环变量 i2/j2/k2/ir/jr/kr 的当前值、轮次 x/y 与
 *    迷你进度条实时推进——直观呈现「切分」的执行情况
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  /* ---------- 行文本模板（与循环顺序无关的部分） ---------- */
  const LOOP_TEXT = {
    i2: 'for i2 = 0 .. M step mc',
    j2: 'for j2 = 0 .. N step nc',
    k2: 'for k2 = 0 .. K step kc',
    ir: 'for ir = i2 .. +mc step mr',
    jr: 'for jr = j2 .. +nc step nr',
    kr: 'for kr = k2 .. +kc step 1',
  };
  const LOOP_BADGE = { i2: 'l2', j2: 'l2', k2: 'l2', ir: 'l1', jr: 'l1', kr: 'reg' };
  const LOAD_TEXT = {
    C: 'load C[i2:+mc, j2:+nc] → L2',
    A: 'load A[i2:+mc, k2:+kc] → L2',
    B: 'load B[k2:+kc, j2:+nc] → L2',
    Ar: 'load Ar[ir:+mr, k2:+kc] → L1',
    Br: 'load Br[k2:+kc, jr:+nr] → L1',
    Reg: 'load C[ir:+mr, jr:+nr] → Reg',
  };
  const COMPUTE_TEXT = 'C[ir:+mr, jr:+nr] += A[:,kr] ⊗ B[kr,:]';
  const STORE_TEXT = 'write C[i2:+mc, j2:+nc] → DRAM';

  /** 按 order 生成行定义（与 sim.js 执行引擎同一套绑定规则） */
  function buildLines(order) {
    const pos = {};
    order.forEach((v, i) => { pos[v] = i; });
    const innerOf = (vars) => vars.reduce((a, b) => (pos[a] > pos[b] ? a : b));
    const FIRE = {
      C: innerOf(['i2', 'j2']), A: innerOf(['i2', 'k2']), B: innerOf(['j2', 'k2']),
      Ar: innerOf(['ir', 'k2']), Br: innerOf(['jr', 'k2']), Reg: innerOf(['ir', 'jr']),
    };
    const enter = {};
    order.forEach((v) => { enter[v] = []; });
    ['C', 'A', 'B', 'Ar', 'Br', 'Reg'].forEach((key) => enter[FIRE[key]].push(key));
    const lines = [];
    order.forEach((v, depth) => {
      lines.push({ t: ' '.repeat(depth) + LOOP_TEXT[v], k: 'loop', v, lv: LOOP_BADGE[v] });
      for (const key of enter[v])
        lines.push({ t: ' '.repeat(depth + 1) + LOAD_TEXT[key], k: 'load', req: key });
      if (v === innerOf(['ir', 'jr', 'kr']))
        lines.push({ t: ' '.repeat(depth + 1) + COMPUTE_TEXT, k: 'compute', req: 'MAC' });
    });
    lines.push({ t: ' '.repeat(pos[innerOf(['i2', 'j2'])] + 1) + STORE_TEXT, k: 'store', req: 'Store' });
    return lines;
  }

  const LOOP_VAR_IDS = { i2: 1, j2: 1, k2: 1, ir: 1, jr: 1, kr: 1 };
  const PARAM_IDS = { mc: 1, nc: 1, kc: 1, mr: 1, nr: 1, M: 1, N: 1, K: 1 };

  class CodeView {
    constructor(root) {
      this.root = root;
      this.cfg = null;
      this.rows = [];
      this.lineByReq = {};   // 语义语句 → 行号（1 基）
      this.orderKey = '';
      this.st = this.freshState();
      this.sig = null;
      this.activeRow = 0;    // 当前高亮行（1 基，0=无）
    }

    freshState() {
      return {
        line: 0, tag: { text: '', cls: '' },
        i2: null, j2: null, k2: null, ir: null, jr: null, kr: null,
      };
    }

    /* ---------- DOM 构建（顺序变化时重建） ---------- */
    rebuild(order) {
      const doc = global.document;
      while (this.root.children.length) this.root.removeChild(this.root.children[0]);
      this.rows = [];
      this.lineByReq = {};
      buildLines(order).forEach((def, i) => {
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
        const row = { el, kind: def.k, varName: def.v || null, req: def.req || null };
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
        if (def.req) this.lineByReq[def.req] = i + 1;
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
    setConfig(cfg) {
      const key = (cfg.order || []).join(',');
      if (key !== this.orderKey) {
        this.orderKey = key;
        this.rebuild(cfg.order);
      }
      this.cfg = cfg;
      this.reset();
    }

    reset() {
      this.st = this.freshState();
      this.sig = null;
      this.draw();
    }

    /* 事件 id 前缀 → 语义语句键 */
    reqOfId(id) {
      if (id.indexOf('Ar') === 0) return 'Ar';
      if (id.indexOf('Br') === 0) return 'Br';
      if (id.charAt(0) === 'A') return 'A';
      if (id.charAt(0) === 'B') return 'B';
      return 'C';
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

    /** 每个回放事件 → 更新当前行与循环变量（evict 为伴随事件，不改行） */
    onEvent(ev) {
      const st = this.st;
      const L = this.lineByReq;
      const assign = (o) => { for (const key in o) st[key] = o[key]; };
      switch (ev.type) {
        case 'compute':
          st.line = L.MAC;
          st.tag = { text: ev.flops + ' FLOP', cls: 'calc' };
          assign({ i2: ev.i2, j2: ev.j2, k2: ev.k2, ir: ev.i, jr: ev.j, kr: ev.k });
          break;
        case 'reg':
          st.line = L.Reg;
          st.tag = { text: ev.rows + '×' + ev.cols, cls: 'reg' };
          assign({ ir: ev.i, jr: ev.j });
          break;
        case 'hit':
          st.line = L[this.reqOfId(ev.id)];
          st.tag = { text: '命中 ✓', cls: 'hit' };
          assign(this.coordsOf(ev.id));
          break;
        case 'oversize':
          st.line = L[this.reqOfId(ev.id)];
          st.tag = { text: '超容量 · ' + U.fmtBytes(ev.bytes), cls: 'warn' };
          assign(this.coordsOf(ev.id));
          break;
        case 'xfer':
          if (ev.panel === 'C' && ev.to === 'l2') {        // C 面板 → L2
            st.line = L.C;
            st.tag = ev.oversize
              ? { text: '超容量 · ' + U.fmtBytes(ev.bytes), cls: 'warn' }
              : { text: '未中 · ' + U.fmtBytes(ev.bytes), cls: 'miss' };
            assign({ i2: ev.i2, j2: ev.j2 });
          } else if (ev.to === 'dram') {                   // C 面板写回
            st.line = L.Store;
            st.tag = { text: '写回 · ' + U.fmtBytes(ev.bytes), cls: 'store' };
            assign({ i2: ev.i2, j2: ev.j2 });
          } else if (ev.to === 'l2') {                     // A / B 面板 → L2
            st.line = L[this.reqOfId(ev.id)];
            st.tag = { text: '未中 · ' + U.fmtBytes(ev.bytes), cls: 'miss' };
            assign(this.coordsOf(ev.id));
          } else {                                          // → L1: Ar / Br 微面板
            st.line = L[this.reqOfId(ev.id)];
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

    /* 应用到 DOM：事件签名未变则跳过；行内再做逐节点 diff，
     * 高亮只碰上一行/当前行两行，chip 只写值变化的节点——
     * 避免每个事件重写 14 行 className 造成整面板样式失效 */
    draw() {
      const s = this.st;
      const sig = s.line + '|' + s.tag.text + '|' + s.tag.cls + '|' + s.i2 + ',' + s.j2 + ','
        + s.k2 + ',' + s.ir + ',' + s.jr + ',' + s.kr;
      if (sig === this.sig) return;
      this.sig = sig;
      if (this.activeRow !== s.line) {
        if (this.activeRow) {
          const r = this.rows[this.activeRow - 1];
          r.el.className = 'cl cl-' + r.kind;
          if (r.tag) r.tag.textContent = '';
        }
        if (s.line) {
          const r = this.rows[s.line - 1];
          r.el.className = 'cl cl-' + r.kind + ' active';
        }
        this.activeRow = s.line;
      }
      if (s.line) {
        const r = this.rows[s.line - 1];
        if (r.tag) {
          if (r.tag.textContent !== s.tag.text) r.tag.textContent = s.tag.text;
          const cls = 'cl-tag' + (s.tag.cls ? ' ' + s.tag.cls : '');
          if (r.tag.className !== cls) r.tag.className = cls;
        }
      }
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i];
        if (r.kind !== 'loop') continue;
        const info = this.loopInfo(r.varName);
        const val = r.varName + '=' + (info ? info.v : '—');
        const cnt = info ? info.x + '/' + info.y : '';
        const w = info ? Math.round(100 * info.x / info.y) + '%' : '0%';
        if (r.val.textContent !== val) r.val.textContent = val;
        if (r.cnt.textContent !== cnt) r.cnt.textContent = cnt;
        if (r.bar.style.width !== w) r.bar.style.width = w;
      }
    }
  }

  global.MCodeView = CodeView;
})(typeof window !== 'undefined' ? window : globalThis);