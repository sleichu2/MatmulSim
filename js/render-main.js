/* ============================================================
 * render-main.js — 主画布渲染
 *
 * 布局: B(K×N) 右上 / A(M×K) 左下 / C(M×N) 右下，k 维对应:
 * A 的列 ↔ B 的行。静态层(A/B 数值、网格、标签)离屏缓存，
 * C 层增量更新(每次 compute 事件只重绘微块单元格)。
 * 动态覆盖: k2 切片带 / L2 面板框 / L1 微面板 / kr 亮线 /
 * 数据流箭头 / 微内核放大动画。
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  function makeLayer(w, h, dpr) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, x };
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const C_L2 = '#58a6ff';      // L2 面板框
  const C_MICRO = '#d2a8ff';   // 微块/寄存器级
  const C_K = 'rgba(255,200,80,'; // k 切片

  class MainView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.player = null;
      this.cfg = null;
      this.viewMode = 'value';
      this.dpr = 1;
      this.w = 0; this.h = 0;
      this.L = null;
      this.layers = {};
    }

    bind(player, cfg) {
      this.player = player;
      this.cfg = cfg;
      this.rebuild();
    }
    setViewMode(m) {
      this.viewMode = m;
      if (this.player) { this.player.fullRepaint = true; this.player.dirty.length = 0; }
    }

    resize(w, h, dpr) {
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.cfg) this.rebuild();
    }

    computeLayout() {
      const { M, N, K } = this.cfg;
      const gap = 18, mx = 14, my = 14;
      const W = this.w, H = this.h;
      // 大矩阵允许亚像素单元格（最低 0.4px），保证始终完整装进画布；
      // p < 4 时静态层走 ImageData 快速路径（见 paintMatrixFast）
      let p = Math.min((W - 2 * mx - gap) / (K + N), (H - 2 * my - gap) / (K + M));
      p = Math.max(0.4, Math.min(40, Math.floor(p * 100) / 100));
      const aW = K * p, aH = M * p, bW = N * p, bH = K * p, cW = N * p, cH = M * p;
      const bX = mx + aW + gap, bY = my;
      const cX = bX, cY = bY + bH + gap;
      const aX = mx, aY = cY + cH - aH; // A 底边与 C 底边对齐
      this.L = { p, aX, aY, bX, bY, cX, cY, aW, aH, bW, bH, cW, cH, gap, mx, my };
    }

    rebuild() {
      if (!this.cfg || !this.player || !this.w) return;
      this.computeLayout();
      const { M, N, K } = this.cfg;
      const L = this.L, p = L.p;
      const A = makeLayer(L.aW, L.aH, this.dpr);
      const B = makeLayer(L.bW, L.bH, this.dpr);
      const C = makeLayer(L.cW, L.cH, this.dpr);
      const G = makeLayer(this.w, this.h, this.dpr);

      const colorA = (ri, ci) => this.player.A[ri * K + ci];
      const colorB = (ri, ci) => this.player.B[ri * N + ci];
      const zeros = () => 0;
      this.paintMatrixValues(A.x, M, K, p, colorA);
      this.paintMatrixValues(B.x, K, N, p, colorB);
      this.paintMatrixValues(C.x, M, N, p, zeros);

      gridLines(G.x, L.aX, L.aY, K, M, this.cfg.kc, this.cfg.mc, p);
      gridLines(G.x, L.bX, L.bY, N, K, this.cfg.nc, this.cfg.kc, p);
      gridLines(G.x, L.cX, L.cY, N, M, this.cfg.nc, this.cfg.mc, p);
      G.x.font = '10px -apple-system, "PingFang SC", sans-serif';
      G.x.textBaseline = 'bottom';
      G.x.fillStyle = '#8b98a9';
      G.x.fillText('A (M×K)  ' + M + '×' + K, L.aX + 4, L.aY - 5);
      G.x.fillText('B (K×N)  ' + K + '×' + N, L.bX + 4, L.bY - 5);
      G.x.fillText('C (M×N)  ' + M + '×' + N, L.cX + 4, L.cY - 5);
      this.layers = { A, B, C, G };
      this.player.fullRepaint = true;
      this.player.dirty.length = 0;
    }

    /** 数值模式矩阵层：单元格 ≥3px 逐格 fillRect(大格附数值文本)；
     *  更小（大矩阵缩到亚像素）时改为 1px/格 ImageData + 一次缩放
     *  blit——几十万格从秒级降到毫秒级；无 ImageData 环境自动回退。 */
    paintMatrixValues(ctx, rows, cols, p, valueOf) {
      if (p >= 3) {
        for (let ri = 0; ri < rows; ri++)
          for (let ci = 0; ci < cols; ci++)
            paintValueCell(ctx, ci * p, ri * p, p, valueOf(ri, ci));
        return;
      }
      let img = null;
      try {
        const tiny = document.createElement('canvas');
        tiny.width = cols;
        tiny.height = rows;
        const tctx = tiny.getContext('2d');
        img = tctx.createImageData(cols, rows);
        if (img && img.data) {
          const data = img.data;
          let o = 0;
          for (let ri = 0; ri < rows; ri++) {
            for (let ci = 0; ci < cols; ci++) {
              const c = U.valueRGB(valueOf(ri, ci));
              data[o++] = c[0];
              data[o++] = c[1];
              data[o++] = c[2];
              data[o++] = 255;
            }
          }
          tctx.putImageData(img, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, cols * p, rows * p);
          ctx.drawImage(tiny, 0, 0, cols, rows, 0, 0, cols * p, rows * p);
          return;
        }
      } catch (e) { img = null; }
      for (let ri = 0; ri < rows; ri++) {
        for (let ci = 0; ci < cols; ci++) {
          ctx.fillStyle = U.valueColor(valueOf(ri, ci));
          ctx.fillRect(ci * p, ri * p, p, p);
        }
      }
    }

    /** 热度模式 C 全量重绘（同上按像素密度分流） */
    paintMatrixHeat(ctx, rows, cols, p, heat, K) {
      if (p >= 3) {
        ctx.fillStyle = U.heatColor(0);
        for (let ri = 0; ri < rows; ri++) {
          for (let ci = 0; ci < cols; ci++) {
            const f = heat[ri * cols + ci] / K;
            if (f > 0) ctx.fillStyle = U.heatColor(f);
            ctx.fillRect(ci * p, ri * p, p, p);
          }
        }
        return;
      }
      let img = null;
      try {
        const tiny = document.createElement('canvas');
        tiny.width = cols;
        tiny.height = rows;
        const tctx = tiny.getContext('2d');
        img = tctx.createImageData(cols, rows);
        if (img && img.data) {
          const data = img.data;
          let o = 0;
          for (let i = 0; i < rows * cols; i++) {
            const c = U.heatRGB(heat[i] / K);
            data[o++] = c[0];
            data[o++] = c[1];
            data[o++] = c[2];
            data[o++] = 255;
          }
          tctx.putImageData(img, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, cols * p, rows * p);
          ctx.drawImage(tiny, 0, 0, cols, rows, 0, 0, cols * p, rows * p);
          return;
        }
      } catch (e) { img = null; }
      for (let i = 0; i < rows * cols; i++) {
        const ri = (i / cols) | 0, ci = i % cols;
        ctx.fillStyle = U.heatColor(heat[i] / K);
        ctx.fillRect(ci * p, ri * p, p, p);
      }
    }

    paintCell(ctx, ri, ci, v, h) {
      const p = this.L.p;
      ctx.fillStyle = this.viewMode === 'heat' ? U.heatColor(h / this.cfg.K) : U.valueColor(v);
      ctx.fillRect(ci * p, ri * p, p, p);
      if (this.viewMode === 'value' && p >= 15) {
        ctx.fillStyle = Math.abs(v) > 0.55 ? '#0b0f14' : '#c8d3e0';
        ctx.font = Math.max(7, Math.round(p * 0.34)) + 'px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.toFixed(2), ci * p + p / 2, ri * p + p / 2 + 0.5);
      }
    }

    fullRepaintC() {
      const { M, N, K } = this.cfg;
      const pl = this.player;
      const ctx = this.layers.C.x;
      const p = this.L.p;
      if (this.viewMode === 'heat') this.paintMatrixHeat(ctx, M, N, p, pl.heat, K);
      else this.paintMatrixValues(ctx, M, N, p, (ri, ci) => pl.C[ri * N + ci]);
    }

    render(now) {
      if (!this.player || !this.layers.A) return;
      const pl = this.player;
      // 1) C 层增量更新
      if (pl.fullRepaint) {
        this.fullRepaintC();
        pl.fullRepaint = false;
        pl.dirty.length = 0;
      } else if (pl.dirty.length) {
        const x = this.layers.C.x;
        const N = this.cfg.N;
        for (let d = 0; d < pl.dirty.length; d += 2) {
          const ri = pl.dirty[d], ci = pl.dirty[d + 1];
          this.paintCell(x, ri, ci, pl.C[ri * N + ci], pl.heat[ri * N + ci]);
        }
        pl.dirty.length = 0;
      }
      // 2) 合成
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const L = this.L;
      ctx.drawImage(this.layers.A.c, L.aX, L.aY, L.aW, L.aH);
      ctx.drawImage(this.layers.B.c, L.bX, L.bY, L.bW, L.bH);
      ctx.drawImage(this.layers.C.c, L.cX, L.cY, L.cW, L.cH);
      ctx.drawImage(this.layers.G.c, 0, 0, this.w, this.h);
      // 3) 动态覆盖
      if (pl.cur) this.drawHighlights(ctx, pl.cur, now);
      this.drawInset(ctx, now);
      // 4) 初始提示
      if (pl.cursor === 0) {
        ctx.fillStyle = 'rgba(219,228,238,0.75)';
        ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('按 ▶ 播放 · 「k 步」可逐 k 观察微内核 · 「块步/面板步」观察 tile 层次',
          L.cX + L.cW / 2, L.cY + L.cH / 2);
      }
    }

    /* ---------- 动态高亮 ---------- */
    drawHighlights(ctx, cur, now) {
      const { M, N, K, mc, nc, kc } = this.cfg;
      const { i2, j2, k2, i, j, k, mr, nr } = cur;
      const mcE = Math.min(mc, M - i2), ncE = Math.min(nc, N - j2), kcE = Math.min(kc, K - k2);
      const L = this.L, p = L.p;
      const nBlocks = (this.cfg.biBlocks || 1) * (this.cfg.bjBlocks || 1);
      const bColor = nBlocks > 1 ? U.BLOCK_COLORS[cur.b % U.BLOCK_COLORS.length] : null;

      // block 领地区域：C 矩阵上各 block 的 (i2,j2) 面板范围着色
      if (nBlocks > 1) {
        const perI = Math.ceil(M / mc / this.cfg.biBlocks);
        const perJ = Math.ceil(N / nc / this.cfg.bjBlocks);
        for (let b = 0; b < nBlocks; b++) {
          const bi = Math.floor(b / this.cfg.bjBlocks), bj = b % this.cfg.bjBlocks;
          const i2s = bi * perI * mc, i2e = Math.min((bi + 1) * perI * mc, M);
          const j2s = bj * perJ * nc, j2e = Math.min((bj + 1) * perJ * nc, N);
          const c = U.BLOCK_COLORS[b % U.BLOCK_COLORS.length];
          ctx.fillStyle = c + '10';
          ctx.fillRect(L.cX + j2s * p, L.cY + i2s * p, (j2e - j2s) * p, (i2e - i2s) * p);
          ctx.strokeStyle = c + '30';
          ctx.lineWidth = 1;
          ctx.strokeRect(L.cX + j2s * p + 0.5, L.cY + i2s * p + 0.5, (j2e - j2s) * p - 1, (i2e - i2s) * p - 1);
          ctx.fillStyle = c;
          ctx.font = 'bold 8px ui-monospace, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText('B' + b, L.cX + j2s * p + 3, L.cY + i2s * p + 3);
        }
      }

      // k2 切片带
      ctx.fillStyle = C_K + '0.07)';
      ctx.fillRect(L.aX + k2 * p, L.aY, kcE * p, L.aH);
      ctx.fillRect(L.bX, L.bY + k2 * p, L.bW, kcE * p);

      // L2 面板框（多 block 时用 block 色标注当前归属）
      const panelColor = bColor || C_L2;
      glowRect(ctx, L.aX + k2 * p, L.aY + i2 * p, kcE * p, mcE * p, panelColor);
      glowRect(ctx, L.bX + j2 * p, L.bY + k2 * p, ncE * p, kcE * p, panelColor);
      glowRect(ctx, L.cX + j2 * p, L.cY + i2 * p, ncE * p, mcE * p, panelColor);

      // L1 微面板 (Ar / Br / C 微块)
      ctx.fillStyle = 'rgba(210,168,255,0.07)';
      ctx.fillRect(L.aX + k2 * p, L.aY + i * p, kcE * p, mr * p);
      ctx.fillRect(L.bX + j * p, L.bY + k2 * p, nr * p, kcE * p);
      ctx.fillRect(L.cX + j * p, L.cY + i * p, nr * p, mr * p);
      ctx.strokeStyle = 'rgba(210,168,255,0.9)';
      ctx.lineWidth = 1.25;
      ctx.strokeRect(L.aX + k2 * p + 0.5, L.aY + i * p + 0.5, kcE * p - 1, mr * p - 1);
      ctx.strokeRect(L.bX + j * p + 0.5, L.bY + k2 * p + 0.5, nr * p - 1, kcE * p - 1);
      ctx.strokeRect(L.cX + j * p + 0.5, L.cY + i * p + 0.5, nr * p - 1, mr * p - 1);

      // 当前 kr 亮线（A 列 / B 行）
      const pulse = 0.22 + 0.12 * Math.sin(now / 160);
      ctx.fillStyle = 'rgba(255,205,90,' + pulse.toFixed(3) + ')';
      ctx.fillRect(L.aX + k * p, L.aY, p, L.aH);
      ctx.fillRect(L.bX, L.bY + k * p, L.bW, p);

      // 数据流箭头 A→C、B→C（多 block 时用 block 色）
      const arrowColor = bColor ? bColor + '70' : 'rgba(255,196,90,0.45)';
      ctx.strokeStyle = arrowColor;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -((now / 40) % 9);
      const aYmid = L.aY + (i + mr / 2) * p;
      ctx.beginPath();
      ctx.moveTo(L.aX + L.aW, aYmid);
      ctx.quadraticCurveTo(L.cX - L.gap / 2, aYmid, L.cX, L.cY + (i + mr / 2) * p);
      ctx.stroke();
      const bXmid = L.bX + (j + nr / 2) * p;
      ctx.beginPath();
      ctx.moveTo(bXmid, L.bY + L.bH);
      ctx.quadraticCurveTo(bXmid, L.cY - L.gap / 2, L.cX + (j + nr / 2) * p, L.cY);
      ctx.stroke();
      ctx.setLineDash([]);

      // block 索引标签（多 block 时显示在 C 微块旁）
      if (bColor) {
        ctx.fillStyle = bColor;
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('B' + cur.b, L.cX + (j + nr) * p + 3, L.cY + i * p + 2);
      }
    }

    /* ---------- 微内核放大动画 ---------- */
    insetSize() {
      const mr = this.player.cur ? this.player.cur.mr : this.cfg.mr;
      const nr = this.player.cur ? this.player.cur.nr : this.cfg.nr;
      const cs = Math.max(10, Math.min(26, Math.floor(120 / Math.max(mr, nr, 1))));
      const pad = 8, titleH = 15, footH = 14;
      return {
        cs, pad, titleH, footH,
        w: pad * 2 + cs + nr * cs,
        h: titleH + pad * 2 + cs + mr * cs + footH,
      };
    }
    insetPos(w, h) {
      const L = this.L;
      // 优先左上（阅读动线：先微内核后矩阵）；空间不足时放右上
      if (L.aY > L.my + h + 10) return { x: L.mx, y: L.my };
      if (L.bX + L.bW + w + 10 <= this.w) return { x: L.bX + L.bW + 10, y: L.my };
      return { x: L.mx, y: L.my };
    }

    drawInset(ctx, now) {
      const S = this.insetSize();
      const pos = this.insetPos(S.w, S.h);
      const { x, y } = pos, pl = this.player;
      ctx.fillStyle = 'rgba(13,17,23,0.9)';
      rr(ctx, x, y, S.w, S.h, 6);
      ctx.fill();
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth = 1;
      rr(ctx, x, y, S.w, S.h, 6);
      ctx.stroke();

      ctx.fillStyle = '#8b98a9';
      ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('微内核(寄存器级)  C[i,j] += A[:,k] ⊗ B[k,:]', x + S.pad, y + 11);

      const cur = pl.cur;
      if (!cur) {
        ctx.fillStyle = '#5b6675';
        ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('等待第一个乘加…', x + S.pad, y + S.titleH + S.pad + S.cs * 2);
        return;
      }
      const { i, j, k, mr, nr } = cur;
      const cs = S.cs;
      const ox = x + S.pad + cs, oy = y + S.titleH + S.pad + cs;
      const N = this.cfg.N, K = this.cfg.K;
      const pulse = 0.5 + 0.5 * Math.sin(now / 150);

      const cell = (cx, cy, v, hot) => {
        ctx.fillStyle = U.valueColor(v);
        ctx.fillRect(cx, cy, cs, cs);
        if (hot) {
          ctx.strokeStyle = 'rgba(255,205,90,' + (0.35 + 0.4 * pulse).toFixed(3) + ')';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx + 0.5, cy + 0.5, cs - 1, cs - 1);
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.10)';
          ctx.lineWidth = 1;
          ctx.strokeRect(cx + 0.5, cy + 0.5, cs - 1, cs - 1);
        }
        ctx.fillStyle = Math.abs(v) > 0.55 ? '#0b0f14' : '#c8d3e0';
        ctx.font = Math.max(6, Math.round(cs * 0.4)) + 'px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.toFixed(2), cx + cs / 2, cy + cs / 2 + 0.5);
      };

      // B 行 (1×nr)
      for (let jj = 0; jj < nr; jj++)
        cell(ox + jj * cs, oy - cs, pl.B[k * N + j + jj], true);
      // A 列 (mr×1)
      for (let ii = 0; ii < mr; ii++)
        cell(ox - cs, oy + ii * cs, pl.A[(i + ii) * K + k], true);
      // C 微块（部分和）
      for (let ii = 0; ii < mr; ii++)
        for (let jj = 0; jj < nr; jj++)
          cell(ox + jj * cs, oy + ii * cs, pl.C[(i + ii) * N + j + jj], false);

      // 运算符号
      ctx.fillStyle = '#8b98a9';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×', ox - cs / 2, oy - cs / 2);
      ctx.fillText('+=', ox - cs / 2 - 2, oy + (mr * cs) / 2);

      // 数据流箭头
      ctx.strokeStyle = 'rgba(255,196,90,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.lineDashOffset = -((now / 40) % 6);
      for (let ii = 0; ii < mr; ii++) {
        ctx.beginPath();
        ctx.moveTo(ox - cs + 3, oy + ii * cs + cs / 2);
        ctx.lineTo(ox - 2, oy + ii * cs + cs / 2);
        ctx.stroke();
      }
      for (let jj = 0; jj < nr; jj++) {
        ctx.beginPath();
        ctx.moveTo(ox + jj * cs + cs / 2, oy - cs + 3);
        ctx.lineTo(ox + jj * cs + cs / 2, oy - 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // k 进度
      const kcE = Math.min(this.cfg.kc, this.cfg.K - cur.k2);
      ctx.fillStyle = '#8b98a9';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('k=' + k + '  (' + (k - cur.k2 + 1) + '/' + kcE + ')', x + S.w - S.pad, y + S.h - 4);
      ctx.textAlign = 'left';
      ctx.fillText('ir=' + i + ' jr=' + j, x + S.pad, y + S.h - 4);
    }
  }

  /* ---------- 静态层绘制辅助 ---------- */
  function paintValueCell(ctx, x, y, p, v) {
    ctx.fillStyle = U.valueColor(v);
    ctx.fillRect(x, y, p, p);
    if (p >= 15) {
      ctx.fillStyle = Math.abs(v) > 0.55 ? '#0b0f14' : '#c8d3e0';
      ctx.font = Math.max(7, Math.round(p * 0.34)) + 'px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(2), x + p / 2, y + p / 2 + 0.5);
    }
  }

  function gridLines(ctx, x0, y0, cols, rows, colStep, rowStep, p) {
    ctx.strokeStyle = 'rgba(148,163,184,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 大矩阵下 tile 间隔缩到 3px 以内时跳过次级网格线，避免糊成噪点
    if (colStep * p >= 3) {
      for (let c = colStep; c < cols; c += colStep) {
        ctx.moveTo(x0 + c * p + 0.5, y0);
        ctx.lineTo(x0 + c * p + 0.5, y0 + rows * p);
      }
    }
    if (rowStep * p >= 3) {
      for (let r = rowStep; r < rows; r += rowStep) {
        ctx.moveTo(x0, y0 + r * p + 0.5);
        ctx.lineTo(x0 + cols * p, y0 + r * p + 0.5);
      }
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cols * p - 1, rows * p - 1);
  }

  function glowRect(ctx, x, y, w, h, color) {
    ctx.strokeStyle = color + '4d';
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  global.MMainView = MainView;
})(typeof window !== 'undefined' ? window : globalThis);
