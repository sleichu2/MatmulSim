/* ============================================================
 * ui.js — DOM 控制与统计面板
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  const STAT_ROWS = [
    ['进度', 'stProg', false],
    ['循环位置', 'stLoop', false],
    ['计算量', 'stFlops', false],
    ['DRAM 搬运', 'stDram', false],
    ['L2→L1', 'stL2', false],
    ['L1→寄存器', 'stL1', false],
    ['算术强度', 'stAi', false],
    ['实际速率', 'stGf', false],
    ['L2 缓存', 'stL2c', true],
    ['L1 缓存', 'stL1c', true],
    ['面板复用', 'stReuse', false],
    ['理论流量', 'stFml', true],
    ['数值校验', 'stErr', true],
  ];

  function initUI(cb) {
    const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));

    /* ---------- 预设按钮 ---------- */
    const presetBar = $('#presetBar');
    global.MSim.PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'preset-btn';
      b.textContent = p.name;
      b.title = p.note;
      b.dataset.id = p.id;
      b.onclick = () => cb.onPreset(p.id);
      presetBar.appendChild(b);
    });

    /* ---------- 传输控制 ---------- */
    $('#btnPlay').onclick = () => cb.onPlayToggle();
    $('#btnReset').onclick = () => cb.onReset();
    $('#btnEnd').onclick = () => cb.onSeekEnd();
    $('#btnStep').onclick = () => cb.onStep($('#selStep').value);
    $('#rngSpeed').oninput = (e) => {
      const v = parseFloat(e.target.value);
      $('#lblSpeed').textContent = v.toFixed(v < 1 ? 2 : 1) + '×';
      cb.onSpeed(v);
    };

    /* ---------- 参数条（常驻） ---------- */
    $('#chkAutoCache').onchange = (e) => {
      $('#inL2').disabled = e.target.checked;
      $('#inL1').disabled = e.target.checked;
    };
    $('#btnApply').onclick = () => cb.onApply(readConfig(), $('#chkAutoCache').checked, $('#selView').value);
    $('#btnReseed').onclick = () => cb.onReseed();

    /* ---------- 图例 ---------- */
    const LEGEND = [
      { label: 'L2 面板框', color: '#58a6ff', outline: true },
      { label: '微块(寄存器级)', color: '#d2a8ff', outline: true },
      { label: 'k 切片带', color: 'rgba(240,180,41,0.35)' },
      { label: '当前 k 亮线', color: '#ffcd5a' },
      { label: '数据流', color: 'rgba(255,196,90,0.6)' },
      { label: '计算', color: '#3fb950' },
      { label: '数值: 蓝负/橙正', color: 'linear-gradient(90deg,#38bdf8,#f97316)' },
    ];
    const leg = $('#legend');
    LEGEND.forEach((it) => {
      const s = document.createElement('span');
      s.className = 'leg';
      const i = document.createElement('i');
      if (it.outline) { i.className = 'outline'; i.style.borderColor = it.color; }
      else if (it.color.indexOf('gradient') >= 0) i.style.background = it.color;
      else { i.style.background = it.color; }
      const t = document.createElement('span');
      t.textContent = it.label;
      s.appendChild(i); s.appendChild(t);
      leg.appendChild(s);
    });

    /* ---------- 统计面板 ---------- */
    const sb = $('#statsBody');
    STAT_ROWS.forEach(([label, id, wide]) => {
      const d = document.createElement('div');
      d.className = 'stat' + (wide ? ' wide' : '');
      const s = document.createElement('span');
      s.textContent = label;
      const b = document.createElement('b');
      b.id = id;
      b.textContent = '—';
      d.appendChild(s); d.appendChild(b);
      sb.appendChild(d);
    });

    return {
      $,
      setPlaying(playing, isEnd) {
        $('#btnPlay').textContent = isEnd ? '↻' : playing ? '⏸' : '▶';
      },
      setPresetActive(id) {
        presetBar.querySelectorAll('.preset-btn').forEach((b) =>
          b.classList.toggle('active', b.dataset.id === id));
      },
      fillConfigInputs(cfg) {
        const map = { inM: cfg.M, inN: cfg.N, inK: cfg.K, inMc: cfg.mc, inNc: cfg.nc,
          inKc: cfg.kc, inMr: cfg.mr, inNr: cfg.nr, inSeed: cfg.seed,
          inL2: cfg.l2KB, inL1: cfg.l1KB };
        for (const [id, v] of Object.entries(map)) { const el = $('#' + id); if (el) el.value = v; }
      },
      setCfgNote(warnings) {
        $('#cfgNote').textContent = warnings.length ? '⚠ ' + warnings.join('；') : '';
      },
      setProgress(frac, text) {
        $('#progressFill').style.width = (frac * 100).toFixed(1) + '%';
        $('#progressText').textContent = text;
      },
      setHud(text) { $('#mainHud').textContent = text; },
      setRooflineNote(text) { $('#rooflineNote').textContent = text; },
      setStats(s) {
        const $b = (id) => $('#' + id);
        const pl = s.player, st = s.result.stats, cfg = s.cfg;
        const an = s.analysis;
        $b('stProg').textContent = (pl.progress * 100).toFixed(1) + '% · 事件 ' + pl.cursor + '/' + pl.events.length;
        if (pl.cur) {
          $b('stLoop').textContent = 'i2=' + pl.cur.i2 + ' j2=' + pl.cur.j2 + ' k2=' + pl.cur.k2
            + ' · ir=' + pl.cur.i + ' jr=' + pl.cur.j + ' · k=' + pl.cur.k;
        } else {
          $b('stLoop').textContent = '未开始';
        }
        $b('stFlops').textContent = U.fmt(pl.flops, 1) + ' / ' + U.fmt(st.flops, 1) + ' FLOP';
        $b('stDram').textContent = '读 ' + U.fmtBytes(pl.dramR) + ' · 写 ' + U.fmtBytes(pl.dramW);
        $b('stL2').textContent = U.fmtBytes(pl.l2B) + ' / ' + U.fmtBytes(st.l2Bytes);
        $b('stL1').textContent = U.fmtBytes(pl.regB) + ' / ' + U.fmtBytes(st.regBytes);
        $b('stAi').textContent = pl.flops > 0 ? pl.liveAI.toFixed(2) + ' FLOP/B' : '—';
        $b('stGf').textContent = (pl.flops > 0 ? pl.liveGF.toFixed(1) : '0.0') + ' / ' + global.MSim.PEAK + ' GFLOPS';
        $b('stL2c').textContent = '命中 ' + pl.l2Hit + ' · 未中 ' + pl.l2Miss
          + ' · 淘汰 ' + pl.evicts + ' · 超容量 ' + pl.oversize;
        $b('stL1c').textContent = '命中 ' + pl.l1Hit + ' · 未中 ' + pl.l1Miss;
        const reuseA = cfg.N / cfg.nc, reuseB = cfg.M / cfg.mc;
        $b('stReuse').textContent = 'A ×' + reuseA.toFixed(1) + ' · B ×' + reuseB.toFixed(1)
          + '  (理论 N/nc, M/mc)';
        if (an) {
          $b('stFml').textContent = an.formula + ' = ' + U.fmtBytes(an.cur.bytes);
        }
        if (!pl.errDone) {
          $b('stErr').textContent = '计算中…';
          $b('stErr').className = '';
        } else if (pl.isEnd) {
          $b('stErr').textContent = '✓ 与朴素乘法一致 (max |Δ| = ' + pl.maxErr.toExponential(1) + ')';
          $b('stErr').className = 'ok';
        } else {
          $b('stErr').textContent = '已收敛格 max |Δ| = ' + pl.maxErr.toExponential(1);
          $b('stErr').className = 'ok';
        }
      },
    };
  }

  function readConfig() {
    const $ = (id) => document.getElementById(String(id).replace(/^#/, ''));
    return {
      M: parseInt($('inM').value, 10),
      N: parseInt($('inN').value, 10),
      K: parseInt($('inK').value, 10),
      mc: parseInt($('inMc').value, 10),
      nc: parseInt($('inNc').value, 10),
      kc: parseInt($('inKc').value, 10),
      mr: parseInt($('inMr').value, 10),
      nr: parseInt($('inNr').value, 10),
      seed: parseInt($('inSeed').value, 10),
      l2KB: parseFloat($('inL2').value),
      l1KB: parseFloat($('inL1').value),
    };
  }

  global.initUI = initUI;
})(typeof window !== 'undefined' ? window : globalThis);
