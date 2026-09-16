/* ============================================================
 * ui.js — DOM 控制与统计面板
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  /* 统计面板：分组单列。id 与 dom-smoke 断言耦合，勿随意改名 */
  const STAT_SECTIONS = [
    { title: '计算', rows: [['FLOPs', 'stFlops'], ['实测速率', 'stGf']] },
    { title: '并行', rows: [['加速比', 'stSpd'], ['私有/共享时间', 'stPar']] },
    { title: '访存', rows: [
      ['DRAM 读/写', 'stDram'],
      ['并行块', 'stBlk'],
      ['L2 命中/未中', 'stL2h'],
      ['L2 淘汰/超容', 'stL2c'],
      ['L1 命中/未中', 'stL1c'],
      ['算术强度', 'stAi'],
    ] },
    { title: '正确性', rows: [['数值校验', 'stErr', true]] },
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
    const applyAutoCache = (on) => {
      $('#inL2').disabled = on;
      $('#inL1').disabled = on;
    };
    $('#chkAutoCache').onchange = (e) => applyAutoCache(e.target.checked);

    /* 循环序下拉：全部 90 种合法嵌套，常用的加注释 */
    {
      const NOTES = {
        'i2,j2,k2,ir,jr,kr': 'BLIS 默认 · C 面板行优先',
        'j2,i2,k2,jr,ir,kr': 'j2 最外 · Goto 实际面板序（B 面板驻留）',
        'i2,k2,j2,ir,jr,kr': 'k2 提前 · 面板级 ikj',
        'i2,j2,k2,jr,ir,kr': '微行列互换 · A/B 微面板复用对调',
        'i2,j2,k2,ir,kr,jr': 'kr 提前 · C 微块逐 k 进出寄存器',
        'i2,j2,k2,kr,ir,jr': 'kr 最内提前 · 寄存器流量病态对照',
      };
      const sel = $('#selOrder');
      global.MSim.legalOrders().forEach((o) => {
        const v = o.join(',');
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = o.join(' ') + (NOTES[v] ? ' — ' + NOTES[v] : '');
        sel.appendChild(opt);
      });
      // 并行切分下拉（清空静态 option 后填充，避免重复项）
      for (const id of ['selBI2', 'selBJ2']) {
        const s = $('#' + id);
        s.innerHTML = '';
        ['1', '2', '4', '8'].forEach((v) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = v;
          s.appendChild(o);
        });
      }
    }
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
    STAT_SECTIONS.forEach((sec) => {
      const h = document.createElement('div');
      h.className = 'stat-sec';
      h.textContent = sec.title;
      sb.appendChild(h);
      sec.rows.forEach(([label, id]) => {
        const d = document.createElement('div');
        d.className = 'stat';
        const s = document.createElement('span');
        s.textContent = label;
        const b = document.createElement('b');
        b.id = id;
        b.textContent = '—';
        d.appendChild(s); d.appendChild(b);
        sb.appendChild(d);
      });
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
      /** 同步「自动容量」勾选态（预设自带容量，切换预设时需关闭） */
      setAutoCache(on) {
        const chk = $('#chkAutoCache');
        chk.checked = on;
        applyAutoCache(on);
      },
      fillConfigInputs(cfg) {
        const map = { inM: cfg.M, inN: cfg.N, inK: cfg.K, inMc: cfg.mc, inNc: cfg.nc,
          inKc: cfg.kc, inMr: cfg.mr, inNr: cfg.nr, inSeed: cfg.seed,
          inL2: cfg.l2KB, inL1: cfg.l1KB };
        for (const [id, v] of Object.entries(map)) { const el = $('#' + id); if (el) el.value = v; }
        const sel = $('#selOrder');
        if (sel && cfg.order) sel.value = cfg.order.join(',');
        const mapB = { selBI2: cfg.biBlocks || 1, selBJ2: cfg.bjBlocks || 1 };
        for (const [id, v] of Object.entries(mapB)) { const el = $('#' + id); if (el) el.value = String(v); }
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
        const nb = (cfg.biBlocks || 1) + '×' + (cfg.bjBlocks || 1);
        $b('stFlops').textContent = U.fmt(pl.flops, 1) + ' / ' + U.fmt(st.flops, 1);
        $b('stGf').textContent = (pl.flops > 0 ? pl.liveGF.toFixed(1) : '0.0') + ' / ' + global.MSim.PEAK;
        $b('stSpd').textContent = st.speedup ? st.speedup.toFixed(2) + '×' : '—';
        $b('stPar').textContent = U.fmtNs(st.parPrivTime || 0) + ' / ' + U.fmtNs(st.parSharedTime || 0);
        $b('stDram').textContent = U.fmtBytes(pl.dramR) + ' / ' + U.fmtBytes(pl.dramW);
        $b('stBlk').textContent = nb + ' = ' + ((cfg.biBlocks || 1) * (cfg.bjBlocks || 1));
        $b('stL2h').textContent = pl.l2Hit + ' / ' + pl.l2Miss;
        $b('stL2c').textContent = pl.evicts + ' / ' + pl.oversize;
        $b('stL1c').textContent = pl.l1Hit + ' / ' + pl.l1Miss;
        $b('stAi').textContent = pl.flops > 0 ? pl.liveAI.toFixed(2) + ' FLOP/B' : '—';
        if (!pl.errDone) {
          $b('stErr').textContent = '计算中…';
          $b('stErr').className = '';
        } else if (pl.isEnd) {
          $b('stErr').textContent = '✓ max |Δ| = ' + pl.maxErr.toExponential(1);
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
      biBlocks: parseInt($('selBI2').value, 10) || 1,
      bjBlocks: parseInt($('selBJ2').value, 10) || 1,
      order: ($('selOrder').value || '').split(',').filter(Boolean),
    };
  }

  global.initUI = initUI;
})(typeof window !== 'undefined' ? window : globalThis);
