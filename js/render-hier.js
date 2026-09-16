/* ============================================================
 * render-hier.js — 内存层次框图：链路流量与实测带宽
 *
 * 经典内存层次漏斗图：REG / L1 / L2 / DRAM 居中堆叠，
 * 盒宽按容量比例递增（越下层越大越慢），层间双向箭头直连：
 *   ↑ 读路径（蓝）: dram→l2 填充 · l2→l1 填充 · l1→reg 操作数流
 *   ↓ 写路径（橙）: l2→dram 写回（含脏替换，标次数）
 *   旁路弧线（右）: l2→reg C 微块载入（紫） · dram→l1 级联读（红）
 * 箭头标注 流量 / 实测带宽（含延迟压制）÷ 理论带宽 = 利用率，
 * 连线与文字按利用率着色（绿≥80% 橙 40-80% 红<40%）。
 * 回放中数值实时增长，收敛于模拟器统计。
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  const BW = global.MSim ? global.MSim.BW : { dram: 16, l2: 64, l1: 256, reg: 512 };
  const utilColor = (u) => (u >= 0.8 ? '#3fb950' : u >= 0.4 ? '#f0883e' : '#f85149');
  const fmtBw = (v) => (v >= 1 ? v.toFixed(1) : v.toFixed(2));

  class HierView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0;
      this.dpr = 1;
    }

    resize(w, h, dpr) {
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    draw(player, cfg) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!cfg) return;
      const links = player ? player.links : {};
      const L = (k) => links[k] || { bytes: 0, ns: 0, n: 0, dirty: 0 };
      const meas = (k) => { const l = links[k]; return l && l.ns ? l.bytes / l.ns : 0; };

      /* ---- 几何：居中堆叠，盒宽按容量比例递增（漏斗形） ---- */
      const cx = 128;
      const BOX = {
        reg: { y: 8, w: 84, accent: '#ffc95c' },
        l1: { y: 68, w: 116, accent: '#d2a8ff' },
        l2: { y: 128, w: 156, accent: '#58a6ff' },
        dram: { y: 188, w: 200, accent: '#f0883e' },
      };
      const bh = 38;
      for (const key of ['reg', 'l1', 'l2', 'dram']) {
        const b = BOX[key];
        ctx.fillStyle = key === 'dram' ? '#101820' : '#131b26';
        ctx.fillRect(cx - b.w / 2, b.y, b.w, bh);
        ctx.strokeStyle = '#2b3441';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - b.w / 2 + 0.5, b.y + 0.5, b.w - 1, bh - 1);
        ctx.fillStyle = b.accent;   // 层级色条：顶边标识层级
        ctx.fillRect(cx - b.w / 2, b.y, b.w, 2.5);
      }

      /* 盒内文字 */
      const hitPct = (h, m) => (h + m ? Math.round(100 * h / (h + m)) + '%' : '—');
      const boxText = (key, lines) => {
        const b = BOX[key];
        ctx.textAlign = 'center';
        ctx.fillStyle = '#dbe4ee';
        ctx.font = 'bold 11px ui-monospace, monospace';
        ctx.fillText(lines[0], cx, b.y + 15);
        ctx.fillStyle = '#8b98a9';
        ctx.font = '8.5px -apple-system, sans-serif';
        ctx.fillText(lines[1], cx, b.y + 27);
        if (lines[2]) {
          ctx.fillStyle = '#5b6675';
          ctx.fillText(lines[2], cx, b.y + 35);
        }
      };
      const pl = player || { l1Hit: 0, l1Miss: 0, l2Hit: 0, l2Miss: 0, dramR: 0, dramW: 0 };
      const nB = ((cfg.biBlocks || 1) * (cfg.bjBlocks || 1)) || 1;
      boxText('reg', ['REG · 寄存器', '累加与操作数']);
      if (nB > 1) {
        /* L1 独享语义：盒体按 block 分隔成 n 个彩色小格——每块一块物理缓存 */
        const b = BOX.l1;
        const iw = b.w - 6, ix = cx - iw / 2, iy = b.y + 15, ih = 14;
        const step = iw / nB, segW = Math.max(1, step - 0.8);
        for (let i = 0; i < nB; i++) {
          const c = U.BLOCK_COLORS[i % U.BLOCK_COLORS.length];
          const sx = ix + i * step;
          ctx.fillStyle = c + (nB > 16 ? '99' : '16');
          ctx.fillRect(sx, iy, segW, ih);
          if (nB <= 16) {
            ctx.strokeStyle = c + '77';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 0.5, iy + 0.5, segW - 1, ih - 1);
          }
          if (step >= 11) {
            ctx.fillStyle = c;
            ctx.font = 'bold 7.5px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText('B' + i, sx + segW / 2, iy + ih / 2 + 2.5);
          }
        }
        ctx.textAlign = 'center';
        ctx.fillStyle = '#dbe4ee';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.fillText('L1 ×' + nB + '（每 block 独享）', cx, b.y + 11);
        ctx.fillStyle = '#5b6675';
        ctx.font = '7.5px -apple-system, sans-serif';
        ctx.fillText(U.fmtBytes(cfg.l1Bytes) + '/块 · 合 ' + U.fmtBytes(cfg.l1Bytes * nB)
          + ' · 命中率 ' + hitPct(pl.l1Hit, pl.l1Miss), cx, b.y + bh - 2.5);
      } else {
        boxText('l1', ['L1 · ' + U.fmtBytes(cfg.l1Bytes), '命中率 ' + hitPct(pl.l1Hit, pl.l1Miss)]);
      }
      boxText('l2', ['L2 · ' + U.fmtBytes(cfg.l2Bytes), '命中率 ' + hitPct(pl.l2Hit, pl.l2Miss)]);
      boxText('dram', ['DRAM · 主存', '读 ' + U.fmtBytes(pl.dramR) + ' · 写 ' + U.fmtBytes(pl.dramW)]);

      /* ---- 层间箭头与标注 ----
       * gap 内：↑ 读（蓝）与 ↓ 写（橙）并排；标注两行挂右侧。
       * label(fn) 绘制两行：主行 + 实测/理论行，末尾接利用率色点。 */
      const arrow = (x, y1, y2, color, up) => {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        const head = up ? Math.min(y1, y2) : Math.max(y1, y2);
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, head);
        ctx.lineTo(x - 3.5, head + (up ? 5 : -5));
        ctx.lineTo(x + 3.5, head + (up ? 5 : -5));
        ctx.closePath();
        ctx.fill();
      };
      // gap 内标注：两行文本，util 以色点呈现
      const tag = (x, yMid, main, sub, util) => {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#c8d3e0';
        ctx.font = '8.5px ui-monospace, monospace';
        ctx.fillText(main, x, yMid - 3);
        ctx.fillStyle = '#8b98a9';
        ctx.fillText(sub, x, yMid + 7);
        ctx.fillStyle = utilColor(U.clamp(util, 0, 1));
        ctx.fillRect(x - 8, yMid - 9, 4, 4);   // 利用率色点
      };

      /* gap: REG ↔ L1 —— 操作数流（仅读） */
      {
        const b = L('l1>reg');
        const m = meas('l1>reg');
        const empty = b.bytes === 0;
        const color = empty ? '#333c47' : utilColor(U.clamp(m / BW.reg, 0, 1));
        arrow(cx - 8, 68, 46, color, true);
        tag(152, 57, (empty ? '— ' : '↑ 操作数流 ' + U.fmtBytes(b.bytes)),
          empty ? '无流量' : fmtBw(m) + '/' + BW.reg + 'B/ns', m / BW.reg);
      }
      /* gap: L1 ↔ L2 —— 读填充（仅读） */
      {
        const b = L('l2>l1');
        const m = meas('l2>l1');
        const empty = b.bytes === 0;
        const color = empty ? '#333c47' : utilColor(U.clamp(m / BW.l2, 0, 1));
        arrow(cx - 8, 128, 106, color, true);
        tag(152, 117, (empty ? '— ' : '↑ 读填充 ' + U.fmtBytes(b.bytes)),
          empty ? '无流量' : fmtBw(m) + '/' + BW.l2 + 'B/ns', m / BW.l2);
      }
      /* gap: L2 ↔ DRAM —— 读填充 ↑ 与 写回 ↓（含脏替换） */
      {
        const up = L('dram>l2'), dn = L('l2>dram');
        const mUp = meas('dram>l2'), mDn = meas('l2>dram');
        const upColor = up.bytes === 0 ? '#333c47' : utilColor(U.clamp(mUp / BW.dram, 0, 1));
        const dnColor = dn.bytes === 0 ? '#333c47' : utilColor(U.clamp(mDn / BW.dram, 0, 1));
        arrow(cx - 10, 188, 166, upColor, true);
        arrow(cx + 10, 166, 188, dnColor, false);
        tag(152, 177,
          '↑ 读 ' + U.fmtBytes(up.bytes) + ' · ' + fmtBw(mUp) + 'B/ns',
          '↓ 写 ' + U.fmtBytes(dn.bytes) + (dn.dirty ? ' · 脏替换' + dn.dirty : ''),
          Math.max(mUp / BW.dram, dn.bytes ? mDn / BW.dram : 0));
      }

      /* ---- 旁路弧线（右缘）：跨层链路 ---- */
      const arc = (fromKey, toKey, key, color, label) => {
        const b = L(key);
        const m = meas(key);
        const y1 = BOX[fromKey].y + bh / 2, y2 = BOX[toKey].y + bh / 2;
        const x1 = cx + BOX[fromKey].w / 2, x2 = cx + BOX[toKey].w / 2;
        const apex = 300;
        const empty = b.bytes === 0;
        const c = empty ? '#333c47' : color;
        const util = b.bytes && m ? m / (key === 'l2>reg' ? BW.l2 : BW.dram) : 0;
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(apex + 14, y1, apex, (y1 + y2) / 2);
        ctx.quadraticCurveTo(apex + 14, y2, x2 + 3, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2 + 3, y2);
        ctx.lineTo(x2 + 9, y2 - 3);
        ctx.lineTo(x2 + 9, y2 + 3);
        ctx.closePath();
        ctx.fillStyle = c;
        ctx.fill();
        const midY = (y1 + y2) / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = c;
        ctx.fillText(label + (empty ? ' —' : ''), apex - 12, midY - 3);
        ctx.fillStyle = '#8b98a9';
        ctx.fillText(empty ? '' : U.fmtBytes(b.bytes) + ' · ' + fmtBw(m) + 'B/ns', apex - 12, midY + 7);
        if (!empty && util) {
          ctx.fillStyle = utilColor(U.clamp(util, 0, 1));
          ctx.fillText('利用率 ' + Math.round(util * 100) + '%', apex - 12, midY + 17);
        }
      };
      arc('l2', 'reg', 'l2>reg', '#d2a8ff', 'C 微块载入');
      arc('dram', 'l1', 'dram>l1', '#f85149', '级联读');

      /* ---- 底部图例：利用率着色 ---- */
      const ly = this.h - 5;
      ctx.font = '8.5px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#5b6675';
      ctx.fillText('利用率（实测/理论带宽）', 8, ly);
      const leg = [['≥80%', '#3fb950'], ['40-80%', '#f0883e'], ['<40%', '#f85149']];
      let lx = 108;
      for (const [t, c] of leg) {
        ctx.fillStyle = c;
        ctx.fillRect(lx, ly - 7, 7, 7);
        ctx.fillStyle = '#5b6675';
        ctx.fillText(t, lx + 10, ly);
        lx += 10 + t.length * 5 + 14;   // 8.5px 字体约 5px/字符 + 间距
      }
    }
  }

  global.MHierView = HierView;
})(typeof window !== 'undefined' ? window : globalThis);