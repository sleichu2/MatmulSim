/* ============================================================
 * render-mem.js — 内存层次面板渲染
 *
 * 四层: DRAM(主存) / L2 / L1 / 寄存器。
 * 块在层间搬运时播放「飞行」动画，命中/未中/淘汰/超容量
 * 以闪烁标注反馈，驻留块按 LRU 顺序排列，容量条显示占用。
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  const PANEL_COLORS = { A: '#4c8dff', B: '#3fb950', C: '#f0883e' };
  const ROW_NAMES = { dram: 'DRAM', l2: 'L2', l1: 'L1', reg: '寄存器' };
  const ROW_ORDER = ['dram', 'l2', 'l1', 'reg'];

  class MemView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0;
      this.dpr = 1;
      this.anims = [];   // 搬运动画 {id,panel,from,to,t0,dur,bytes}
      this.flash = [];   // 命中/未中/超容量闪烁 {level,good,label,t0,dur}
      this.fades = [];   // 淘汰渐隐 {level,id,t0,dur}
      this.lastDramFlash = 0;
    }

    now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

    resize(w, h, dpr) {
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    clear() { this.anims.length = 0; this.flash.length = 0; this.fades.length = 0; }

    onEvent(ev, dwellMs) {
      const now = this.now();
      if (ev.type === 'xfer' && (ev.to === 'l2' || ev.to === 'l1')) {
        this.anims.push({
          id: ev.id, panel: ev.panel, from: ev.from, to: ev.to,
          t0: now, dur: U.clamp(dwellMs, 90, 520), bytes: ev.bytes,
          cascade: !!ev.cascade,
        });
        if (this.anims.length > 12) this.anims.shift();
      } else if (ev.type === 'xfer' && ev.from === 'dram') {
        this.lastDramFlash = now;
        this.flash.push({ level: 'dram', good: true, label: ev.to === 'l2' ? '读' : '级联读', t0: now, dur: 320 });
      } else if (ev.type === 'xfer' && ev.to === 'dram') {
        this.lastDramFlash = now;
        this.flash.push({ level: 'dram', good: true, label: ev.dirty ? '脏替换' : '写回', t0: now, dur: 320 });
      } else if (ev.type === 'xfer' && ev.miss) {
        this.flash.push({ level: ev.to, good: false, label: '未命中', t0: now, dur: 400 });
      } else if (ev.type === 'xfer' && ev.oversize) {
        this.flash.push({ level: 'l2', good: false, label: '超容量!', t0: now, dur: 800 });
      } else if (ev.type === 'hit') {
        this.flash.push({ level: ev.level, good: true, label: '命中', t0: now, dur: 380 });
      } else if (ev.type === 'evict') {
        this.fades.push({ level: ev.level, id: ev.id, t0: now, dur: 420 });
        if (this.fades.length > 8) this.fades.shift();
      } else if (ev.type === 'oversize') {
        this.flash.push({ level: ev.level, good: false, label: '超容量!', t0: now, dur: 800 });
      }
      if (this.flash.length > 10) this.flash.shift();
    }

    draw(now, player) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!player) return;
      const cfg = player.cfg;
      const gap = 8, labelW = 54;
      const rowH = (this.h - gap * 3) / 4;
      const contentX = labelW + 4, contentW = this.w - contentX - 6;

      // ---------- DRAM ----------
      let y = 0;
      rowBg(ctx, 0, y, this.w, rowH);
      rowTitle(ctx, 6, y + 4, 'DRAM', '主存(大容量)', rowH, this.w);
      // 三个完整矩阵的驻留块
      const aB = cfg.M * cfg.K * 8, bB = cfg.K * cfg.N * 8, cB = cfg.M * cfg.N * 8;
      const dramW = (contentW - 20) / 3;
      chip(ctx, contentX, y + 8, dramW, 18, 'A 全矩阵 ' + U.fmtBytes(aB), PANEL_COLORS.A, now - this.lastDramFlash < 400);
      chip(ctx, contentX + dramW + 10, y + 8, dramW, 18, 'B 全矩阵 ' + U.fmtBytes(bB), PANEL_COLORS.B, false);
      chip(ctx, contentX + 2 * (dramW + 10), y + 8, dramW, 18, 'C 全矩阵 ' + U.fmtBytes(cB), PANEL_COLORS.C, false);
      ctx.fillStyle = '#8b98a9';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('累计读 ' + U.fmtBytes(player.dramR) + ' · 写 ' + U.fmtBytes(player.dramW),
        contentX, y + rowH - 5);

      // ---------- L2 / L1 ----------
      this.drawCacheRow(ctx, 'l2', player, cfg.l2Bytes, labelW, contentX, contentW, y + rowH + gap, rowH);
      const nL1 = ((cfg.biBlocks || 1) * (cfg.bjBlocks || 1)) || 1;
      this.drawCacheRow(ctx, 'l1', player, cfg.l1Bytes * nL1, labelW, contentX, contentW, y + 2 * (rowH + gap), rowH);

      // ---------- 寄存器 ----------
      const ry = y + 3 * (rowH + gap);
      rowBg(ctx, 0, ry, this.w, rowH);
      rowTitle(ctx, 6, ry + 4, 'REG', '寄存器(微内核操作数)', rowH, this.w);
      this.drawRegs(ctx, player, contentX, ry, contentW, rowH);

      // ---------- 动画 ----------
      this.drawAnims(ctx, now, rowH, gap, labelW);
      this.drawFlash(ctx, now, rowH, gap, labelW);
      this.drawFades(ctx, now, rowH, gap, labelW);
    }

    drawCacheRow(ctx, level, player, capBytes, labelW, contentX, contentW, y, rowH) {
      rowBg(ctx, 0, y, this.w, rowH);
      const nBlk = level === 'l1' ? (((player.cfg || {}).biBlocks || 1) * ((player.cfg || {}).bjBlocks || 1)) || 1 : 1;
      rowTitle(ctx, 6, y + 4, level.toUpperCase(),
        U.fmtBytes(capBytes) + (nBlk > 1 ? ' ×' + nBlk + '(独享)' : ''), rowH, this.w);
      const map = level === 'l2' ? player.memL2 : player.memL1;
      const blocks = Array.from(map.values());
      const n = blocks.length;
      const slot = n ? U.clamp((contentW - 4) / n, 3, 60) : 60;
      let bx = contentX;
      for (let i = 0; i < n && bx < contentX + contentW - 4; i++) {
        const b = blocks[i];
        const color = PANEL_COLORS[b.panel] || '#8b98a9';
        ctx.fillStyle = color;
        ctx.fillRect(bx, y + 7, Math.min(slot, contentX + contentW - 4 - bx), 17);
        // 并行切分下 L1 块按 block 着边框色（独享语义可见）
        if (level === 'l1' && b.b !== undefined && nBlk > 1) {
          const bc = U.BLOCK_COLORS[b.b % U.BLOCK_COLORS.length];
          ctx.strokeStyle = bc;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx + 0.5, y + 7.5, Math.min(slot, contentX + contentW - 4 - bx) - 1, 16);
        }
        if (slot >= 26) {
          ctx.fillStyle = '#0b0f14';
          ctx.font = '8px ui-monospace, monospace';
          ctx.textAlign = 'left';
          // C 块为脏块（写分配），标 ✱ 提示其淘汰会产生写回流量
          const label = String(b.panel) + (b.panel === 'C' ? ' ✱' : '')
            + (level === 'l1' && b.b !== undefined && nBlk > 1 ? ' B' + b.b : '');
          ctx.fillText(label, bx + 3, y + 19);
        }
        bx += slot + 2;
      }
      if (!n) {
        ctx.fillStyle = 'rgba(139,152,169,0.3)';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText('（空）', contentX, y + 19);
      }
      // 容量条
      let total = 0;
      for (const b of map.values()) total += b.bytes;
      const frac = U.clamp(total / capBytes, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(contentX, y + rowH - 8, contentW - 4, 3);
      ctx.fillStyle = frac < 0.7 ? '#3fb950' : frac < 0.95 ? '#f0883e' : '#f85149';
      ctx.fillRect(contentX, y + rowH - 8, (contentW - 4) * frac, 3);
      // 计数
      const h = level === 'l2' ? player.l2Hit : player.l1Hit;
      const m = level === 'l2' ? player.l2Miss : player.l1Miss;
      ctx.fillStyle = '#5b6675';
      ctx.font = '8px ui-monospace, monospace';
      ctx.fillText('命中' + h + ' 未中' + m, contentX, y + rowH - 12);
      if (level === 'l2') ctx.fillText('淘汰' + player.evicts + ' 超容量' + player.oversize, contentX + 90, y + rowH - 12);
    }

    drawRegs(ctx, player, contentX, ry, contentW, rowH) {
      const cur = player.cur;
      const regC = player.regC;
      let x = contentX;
      const w3 = (contentW - 12) / 3;
      chip(ctx, x, ry + 6, w3, 16, regC ? 'C 微块 ' + regC.rows + '×' + regC.cols : 'C 微块 —', PANEL_COLORS.C, !!regC);
      x += w3 + 6;
      chip(ctx, x, ry + 6, w3, 16, cur ? 'A[:,k=' + cur.k + '] ' + cur.mr + '×1' : 'A 列 —', PANEL_COLORS.A, !!cur);
      x += w3 + 6;
      chip(ctx, x, ry + 6, w3, 16, cur ? 'B[k=' + cur.k + ',:] 1×' + cur.nr : 'B 行 —', PANEL_COLORS.B, !!cur);
      if (cur) {
        const K = player.K, N = player.N;
        const av = [];
        for (let ii = 0; ii < cur.mr; ii++) av.push(player.A[(cur.i + ii) * K + cur.k].toFixed(2));
        const bv = [];
        for (let jj = 0; jj < cur.nr; jj++) bv.push(player.B[cur.k * N + cur.j + jj].toFixed(2));
        ctx.fillStyle = '#8b98a9';
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillText('A: [' + av.join(' ') + ']', contentX, ry + rowH - 5);
        ctx.fillText('B: [' + bv.join(' ') + ']', contentX + contentW / 2, ry + rowH - 5);
      }
    }

    /* ---------- 动画层 ---------- */
    rowCenter(level, rowH, gap) { return ROW_ORDER.indexOf(level) * (rowH + gap) + rowH / 2; }

    drawAnims(ctx, now, rowH, gap, labelW) {
      this.anims = this.anims.filter((a) => now - a.t0 < a.dur);
      for (const a of this.anims) {
        const t = U.clamp((now - a.t0) / a.dur, 0, 1);
        const y1 = this.rowCenter(a.from, rowH, gap);
        const y2 = this.rowCenter(a.to, rowH, gap);
        const yy = U.lerp(y1, y2, t);
        const xx = labelW + 10 + (a.id.length * 7) % Math.max(40, this.w - labelW - 80);
        const color = a.cascade ? '#f85149' : (PANEL_COLORS[a.panel] || '#8b98a9');
        ctx.globalAlpha = 0.95 * (t < 0.15 ? t / 0.15 : 1) * (t > 0.85 ? (1 - t) / 0.15 : 1);
        ctx.fillStyle = color;
        ctx.fillRect(xx, yy - 6, 26, 12);
        ctx.fillStyle = '#0b0f14';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(a.id.replace('Ar:', 'a').replace('Br:', 'b'), xx + 2, yy + 3);
        ctx.globalAlpha = 1;
      }
    }

    drawFlash(ctx, now, rowH, gap, labelW) {
      this.flash = this.flash.filter((f) => now - f.t0 < f.dur);
      for (const f of this.flash) {
        const t = 1 - (now - f.t0) / f.dur;
        const y = this.rowCenter(f.level, rowH, gap);
        ctx.globalAlpha = U.clamp(t, 0, 1);
        ctx.fillStyle = f.good ? '#3fb950' : '#f85149';
        ctx.font = 'bold 10px -apple-system, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(f.label, this.w - 8, y + 3 - t * 6);
        ctx.globalAlpha = 1;
      }
    }

    drawFades(ctx, now, rowH, gap, labelW) {
      this.fades = this.fades.filter((f) => now - f.t0 < f.dur);
      for (const f of this.fades) {
        const t = 1 - (now - f.t0) / f.dur;
        const y = this.rowCenter(f.level, rowH, gap);
        ctx.globalAlpha = U.clamp(t, 0, 1);
        ctx.fillStyle = '#f85149';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('✕ ' + f.id + ' 淘汰', labelW + 8, y + 3);
        ctx.globalAlpha = 1;
      }
    }
  }

  function rowBg(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  function rowTitle(ctx, x, y, name, sub, rowH, w) {
    ctx.fillStyle = '#dbe4ee';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(name, x, y + 9);
    ctx.fillStyle = '#5b6675';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(sub, w - 6, y + 9);
  }
  function chip(ctx, x, y, w, h, label, color, hot) {
    ctx.fillStyle = color;
    ctx.globalAlpha = hot ? 1 : 0.75;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0b0f14';
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 3, y + h - 4);
    if (hot) {
      ctx.strokeStyle = '#ffc95c';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
  }

  global.MMemView = MemView;
})(typeof window !== 'undefined' ? window : globalThis);
