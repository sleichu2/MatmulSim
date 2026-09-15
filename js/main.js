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

  /* ---------- 视图 ---------- */
  const mainView = new MMainView($('canvasMain'));
  const memView = new MMemView($('canvasMem'));
  const timeline = new MTimelineView($('canvasTimeline'));
  const roofline = new MRooflineView($('canvasRoofline'));
  const codeView = new MCodeView($('codeView'));

  /** 回放事件分发：内存搬运动画 + 伪代码当前行 */
  const onEv = (ev, dwell) => {
    memView.onEvent(ev, dwell);
    codeView.onEvent(ev);
  };

  /** 自动缓存容量启发式：L2 ≈ 工作集的 40%，L1 ≈ L2 的 18%（演示缩放，见 README） */
  function heuristicCache(cfg) {
    const l2KB = Math.round(U.clamp(0.4 * (cfg.M * cfg.K + cfg.K * cfg.N) * 8 / 1024, 0.5, 4096) * 4) / 4;
    const l1KB = Math.round(U.clamp(l2KB * 0.18, 0.25, 1024) * 4) / 4;
    return { l2KB, l1KB };
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
    },
    onSeekEnd() {
      state.player.seekEnd(onEv);
      state.playing = false;
      ui.setPlaying(false, true);
    },
    onStep(mode) {
      state.playing = false;
      ui.setPlaying(false, state.player.isEnd);
      state.player.step(mode, onEv);
    },
    onSpeed(v) { state.speed = v; },
    onPreset(id) {
      const p = MSim.PRESETS.find((x) => x.id === id);
      if (!p) return;
      state.speed = p.speed;
      const rng = $('#rngSpeed');
      rng.value = p.speed;
      $('#lblSpeed').textContent = p.speed.toFixed(1) + '×';
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

  function updateHud() {
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
    timeline.draw();
    codeView.draw();
    roofline.draw(state.cfg, state.analysis,
      state.player.flops > 0 ? { ai: state.player.liveAI, gf: state.player.liveGF } : null);
    updateHud();
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
