/* ============================================================
 * main.js — 应用启动与主循环
 *
 * 组装 模拟器 → 轨迹 → 回放器 → 渲染器，驱动 rAF 循环，
 * 处理控制回调、窗口缩放与键盘快捷键。
 * ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));
  const U = MUtil;

  /* ---------- 状态 ---------- */
  const state = {
    cfg: null,
    result: null,
    analysis: null,
    player: null,
    playing: false,
    speed: 1,
    viewMode: 'value',
    autoCache: true,
  };
  let hudLastMs = -1e9;   // HUD/统计 DOM 上次刷新时刻（节流）
  let endFlushed = false; // 回放结束时已强制刷新过统计

  /* ---------- 视图 ---------- */
  const mainView = new MMainView($('canvasMain'));
  const memView = new MMemView($('canvasMem'));
  const hierView = new MHierView($('canvasHier'));
  const timeline = new MTimelineView($('canvasTimeline'));
  const roofline = new MRooflineView($('canvasRoofline'));
  const codeView = new MCodeView($('codeView'));

  /** 回放事件分发：内存搬运动画 + 伪代码当前行 */
  const onEv = (ev, dwell) => {
    memView.onEvent(ev, dwell);
    codeView.onEvent(ev);
  };

  /** 自动缓存容量：按 tile 面板工作集推容量（与预设出厂值同源）
   *  L2 = C 面板 + 两代 A/B 面板——C 需常驻整个 j2 循环，A/B 每 k2
   *  换代一次，LRU 下最坏共存 C+2A+2B；对 16³/32³/96³ 预设精确复现
   *  出厂值 2.5/10/40KB。
   *  L1 = Ar 微面板 + 整排 Br 微面板（跨 ir 复用是 L1 层的核心演示）
   *  再留 25% 余量；下限对齐 normalize 的字节地板(128/64B)。 */
  function heuristicCache(cfg) {
    const q = (kb, minKB) => Math.max(minKB, Math.round(kb * 4) / 4);
    const l2Need = (cfg.mc * cfg.nc + 2 * cfg.mc * cfg.kc + 2 * cfg.kc * cfg.nc) * MSim.ELEM;
    const l1Need = (cfg.mr * cfg.kc + cfg.kc * cfg.nc) * MSim.ELEM * 1.25;
    return { l2KB: q(l2Need / 1024, 0.125), l1KB: q(l1Need / 1024, 0.0625) };
  }

  function build(rawCfg, opts) {
    const first = MSim.normalize(rawCfg);
    const cfg = first.cfg;
    if (opts && opts.autoCache) {
      const h = heuristicCache(cfg);
      cfg.l2KB = h.l2KB;
      cfg.l1KB = h.l1KB;
    }
    const n = MSim.normalize(cfg);
    state.cfg = n.cfg;

    const A = MSim.randMatrix(n.cfg.M, n.cfg.K, n.cfg.seed * 1000 + 1);
    const B = MSim.randMatrix(n.cfg.K, n.cfg.N, n.cfg.seed * 2000 + 2);
    const result = MSim.buildTrace(n.cfg);
    result.A = A;
    result.B = B;
    result.refC = MSim.matmulRef(A, B, n.cfg.M, n.cfg.N, n.cfg.K);
    state.result = result;
    state.analysis = MSim.analyze(n.cfg);

    state.player = new MPlayer(result);
    mainView.bind(state.player, n.cfg);
    mainView.setViewMode(state.viewMode);
    memView.clear();
    timeline.bind(state.player);
    codeView.setConfig(n.cfg);

    ui.fillConfigInputs(n.cfg);
    ui.setCfgNote(n.warnings);
    ui.setStats({ player: state.player, result, cfg: n.cfg, analysis: state.analysis });
    ui.setProgress(0, '就绪 — 按 ▶ 开始');
    ui.setHud('就绪');
    ui.setRooflineNote(rooflineText(n.cfg));
    state.playing = false;
    ui.setPlaying(false, false);
    endFlushed = false;
  }

  function rooflineText(cfg) {
    const an = state.analysis;
    return '横轴=算术强度 FLOP/B，纵轴=GFLOPS。斜线=DRAM 带宽墙(' + MSim.BW.dram + ' GB/s)，'
      + '水平虚线=计算峰值(' + MSim.PEAK + ')。白点=当前回放进度。'
      + '分块(白点)把工作点从带宽墙推向峰值墙：理论流量 ' + an.formula;
  }

  function resetAll() {
    state.player.reset();
    memView.clear();
    codeView.reset();
    endFlushed = false;
  }

  /* ---------- UI 回调 ---------- */
  const ui = initUI({
    onPlayToggle() {
      if (state.player.isEnd) { resetAll(); state.playing = true; }
      else state.playing = !state.playing;
      ui.setPlaying(state.playing, state.player.isEnd);
    },
    onReset() {
      resetAll();
      state.playing = false;
      ui.setPlaying(false, false);
      updateHud(true);
    },
    onSeekEnd() {
      state.player.seekEnd(onEv);
      state.playing = false;
      ui.setPlaying(false, true);
      updateHud(true);
    },
    onStep(mode) {
      state.playing = false;
      ui.setPlaying(false, state.player.isEnd);
      state.player.step(mode, onEv);
      updateHud(true);
    },
    onSpeed(v) { state.speed = v; },
    onPreset(id) {
      const p = MSim.PRESETS.find((x) => x.id === id);
      if (!p) return;
      state.speed = p.speed;
      const rng = $('#rngSpeed');
      rng.value = p.speed;
      $('#lblSpeed').textContent = p.speed.toFixed(1) + '×';
      // 预设自带缓存容量（「缓存受限」等演示依赖具体值），自动容量须让位
      ui.setAutoCache(false);
      build({ ...p.cfg, seed: state.cfg ? state.cfg.seed : 1 }, { autoCache: false });
      ui.setPresetActive(id);
    },
    onApply(values, autoCache, viewMode) {
      state.autoCache = autoCache;
      state.viewMode = viewMode;
      build(values, { autoCache });
      ui.setPresetActive(null);
    },
    onReseed() {
      build({ ...state.cfg, seed: state.cfg.seed + 1 }, { autoCache: false });
      ui.setPresetActive(null);
    },
  });

  /* ---------- HUD ---------- */
  function describeEvent(ev) {
    switch (ev.type) {
      case 'compute':
        return '计算 C[' + ev.i + ':' + (ev.i + ev.mr) + ', ' + ev.j + ':' + (ev.j + ev.nr)
          + '] += A[:,k=' + ev.k + '] ⊗ B[k=' + ev.k + ',:]  (' + ev.mr + '×' + ev.nr + ' 宏内核)';
      case 'xfer': {
        const name = (l) => l === 'dram' ? 'DRAM' : l === 'l2' ? 'L2' : 'L1';
        let s = name(ev.from) + ' → ' + name(ev.to) + '  ' + ev.id + '  ' + U.fmtBytes(ev.bytes);
        if (ev.store) s += ' (写回)';
        if (ev.cascade) s += ' ⚠ 级联缺失(L2 无此面板)';
        else if (ev.miss) s += ' (未命中)';
        if (ev.oversize) s += ' ⚠ 超出容量不驻留';
        return s;
      }
      case 'hit': return '缓存命中  ' + ev.level.toUpperCase() + '  ' + ev.id;
      case 'evict': return 'LRU 淘汰  ' + ev.level.toUpperCase() + '  ' + ev.id;
      case 'oversize': return '⚠ 块 ' + ev.id + ' 大于 ' + ev.level.toUpperCase() + ' 容量 → 无法驻留';
      case 'reg': return '载入寄存器  C 微块 ' + ev.rows + '×' + ev.cols;
      default: return ev.type;
    }
  }

  /** HUD/统计/进度条 DOM 刷新。
   *  节流到 ≥100ms 一次：这批 textContent/style 写入每帧都会弄脏
   *  header 与统计面板的布局，是稳态帧预算与 GC 压力的主要来源；
   *  10Hz 对人眼足够流畅（进度条自带 width 过渡补间）。
   *  force=true 时立即刷新（用户操作、回放结束）。 */
  function updateHud(force) {
    if (!force && performance.now() - hudLastMs < 100) return;
    hudLastMs = performance.now();
    const pl = state.player;
    let s = '';
    if (pl.cur) s = 'i2=' + pl.cur.i2 + ' j2=' + pl.cur.j2 + ' k2=' + pl.cur.k2
      + ' · ir=' + pl.cur.i + ' jr=' + pl.cur.j + ' · k=' + pl.cur.k + '   |   ';
    if (pl.lastEv) s += describeEvent(pl.lastEv);
    else s += '待开始';
    ui.setHud(s);
    ui.setProgress(pl.progress, pl.isEnd
      ? '完成 ✓ · ' + U.fmt(pl.flops, 1) + ' FLOP · 模拟耗时 ' + U.fmtNs(pl.simT)
      : (pl.progress * 100).toFixed(1) + '% · 事件 ' + pl.cursor + '/' + pl.events.length);
    ui.setStats({ player: pl, result: state.result, cfg: state.cfg, analysis: state.analysis });
  }

  /* ---------- 主循环 ---------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last);
    last = now;
    if (state.playing && !state.player.isEnd) {
      state.player.advance(dt, state.speed, onEv);
      if (state.player.isEnd) {
        state.playing = false;
        ui.setPlaying(false, true);
      }
    }
    mainView.render(now);
    memView.draw(now, state.player);
    hierView.draw(state.player, state.cfg);
    timeline.draw();
    codeView.draw();
    roofline.draw(state.cfg, state.analysis,
      state.player.flops > 0 ? { ai: state.player.liveAI, gf: state.player.liveGF } : null);
    if (state.player.isEnd && !endFlushed) {
      endFlushed = true;
      updateHud(true);
    } else {
      updateHud();
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 自适应尺寸 ---------- */
  function observe(el, fn) {
    const ro = new ResizeObserver(fn);
    ro.observe(el);
  }
  const dprOf = () => window.devicePixelRatio || 1;
  observe($('mainView'), () => {
    const r = $('mainView').getBoundingClientRect();
    mainView.resize(r.width, r.height, dprOf());
  });
  observe($('canvasMem'), () => {
    const r = $('canvasMem').getBoundingClientRect();
    memView.resize(r.width, r.height, dprOf());
  });
  observe($('canvasHier'), () => {
    const r = $('canvasHier').getBoundingClientRect();
    hierView.resize(r.width, r.height, dprOf());
  });
  observe($('canvasTimeline'), () => {
    const r = $('canvasTimeline').getBoundingClientRect();
    timeline.resize(r.width, r.height, dprOf());
  });
  observe($('canvasRoofline'), () => {
    const r = $('canvasRoofline').getBoundingClientRect();
    roofline.resize(r.width, r.height, dprOf());
  });

  /* ---------- 键盘 ---------- */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.player.isEnd) { resetAll(); state.playing = true; }
      else state.playing = !state.playing;
      ui.setPlaying(state.playing, state.player.isEnd);
    } else if (e.code === 'ArrowRight') {
      state.playing = false;
      ui.setPlaying(false, state.player.isEnd);
      state.player.step($('#selStep').value, onEv);
      updateHud(true);
    }
  });

  /* ---------- 启动 ---------- */
  const p0 = MSim.PRESETS[0];
  state.speed = p0.speed;
  $('#rngSpeed').value = p0.speed;
  $('#lblSpeed').textContent = p0.speed.toFixed(1) + '×';
  build({ ...p0.cfg }, { autoCache: false });
  ui.setPresetActive(p0.id);
  requestAnimationFrame(frame);
})();
