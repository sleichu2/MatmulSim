/* ============================================================
 * render-hier.js — 内存层次框图：链路流量与实测带宽
 *
 * 按层次展开的框图：寄存器 / L1 / L2 / DRAM 纵向堆叠，
 * 层间链路以连线+标注呈现：
 *   读路径（蓝）: dram→l2 填充 · l2→l1 填充 · l1→reg 操作数流
 *   旁路（紫）:   l2→reg C 微块载入
 *   写路径（橙）: l2→dram 写回（含脏替换，标次数）
 *   旁路（红）:   dram→l1 级联读
 * 每条链路标注 流量字节 / 实测带宽 / 利用率（实测 ÷ 理论）——
 * 实测带宽含固定延迟，小块事务被压制的程度由此直观可见。
 * 回放中数值实时增长，收敛于模拟器统计。
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  /* 链路定义：绘制顺序 = 纵向位置顺序。理论带宽 = 瓶颈侧常量。 */
  const LINKS = [
    { key: 'l1>reg', from: 'l1', to: 'reg', label: '操作数流', theory: 512, lane: 0 },
    { key: 'l2>reg', from: 'l2', to: 'reg', label: 'C 微块载入', theory: 64, lane: 1 },
    { key: 'l2>l1', from: 'l2', to: 'l1', label: '读填充', theory: 64, lane: 0 },
    { key: 'dram>l2', from: 'dram', to: 'l2', label: '读填充', theory: 16, lane: 0 },
    { key: 'l2>dram', from: 'l2', to: 'dram', label: '写回(含脏替换)', theory: 16, lane: 1 },
    { key: 'dram>l1', from: 'dram', to: 'l1', label: '级联读', theory: 16, lane: 2 },
  ];
  const LANE_X = [148, 226, 300]; // 各 lane 的竖线 x
  const utilColor = (u) => (u >= 0.8 ? '#3fb950' : u >= 0.4 ? '#f0883e' : '#f85149');
  const zeroTraffic = (L) => !L || L.bytes === 0;

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

      /* 四个存储层盒子（上→下：寄存器/L1/L2/DRAM） */
      const bx = 8, bw = 104, bh = 38, gap = 14;
      const yOf = (key) => {
        const order = ['reg', 'l1', 'l2', 'dram'];
        return 6 + order.indexOf(key) * (bh + gap);
      };
      const boxInfo = {
        reg: { name: 'REG', sub: '寄存器', sub2: '累加与操作数' },
        l1: { name: 'L1', sub: U.fmtBytes(cfg.l1Bytes), sub2: '命中 ' + (player ? player.l1Hit : 0) },
        l2: { name: 'L2', sub: U.fmtBytes(cfg.l2Bytes), sub2: '命中 ' + (player ? player.l2Hit : 0) },
        dram: { name: 'DRAM', sub: '主存', sub2: player ? ('读 ' + U.fmtBytes(player.dramR)) : '—' },
      };
      for (const key of ['reg', 'l1', 'l2', 'dram']) {
        const y = yOf(key);
        const info = boxInfo[key];
        ctx.fillStyle = key === 'dram' ? '#101820' : '#131b26';
        ctx.fillRect(bx, y, bw, bh);
        ctx.strokeStyle = '#2b3441';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = '#dbe4ee';
        ctx.font = 'bold 11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(info.name, bx + 7, y + 15);
        ctx.fillStyle = '#8b98a9';
        ctx.font = '8.5px -apple-system, sans-serif';
        ctx.fillText(info.sub, bx + 7, y + 27);
        ctx.fillText(info.sub2, bx + 7, y + 35);
      }

      /* 链路：elbow 连线（下层右缘 → lane 竖线 → 上层右缘）+ 双行标注 */
      ctx.font = '8.5px ui-monospace, monospace';
      for (const spec of LINKS) {
        const L = links[spec.key];
        const y1 = yOf(spec.from) + bh / 2;  // 下层盒中心（写路径则是上层）
        const y2 = yOf(spec.to) + bh / 2;
        const x1 = bx + bw;
        const laneX = LANE_X[spec.lane];
        const empty = zeroTraffic(L);
        const meas = L && L.ns ? L.bytes / L.ns : 0;
        const util = spec.theory ? meas / spec.theory : 0;
        const color = empty ? '#333c47' : utilColor(U.clamp(util, 0, 1));

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(laneX, y1);
        ctx.lineTo(laneX, y2);
        ctx.lineTo(x1 + 3, y2);
        ctx.stroke();
        // 箭头
        ctx.beginPath();
        ctx.moveTo(x1 + 3, y2);
        ctx.lineTo(x1 + 9, y2 - 3);
        ctx.lineTo(x1 + 9, y2 + 3);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        if (empty) {
          ctx.fillStyle = '#39424f';
          ctx.textAlign = 'left';
          ctx.fillText('— ' + spec.label, laneX + 5, (y1 + y2) / 2 + 3);
          continue;
        }
        const mid = (y1 + y2) / 2;
        const mb = U.fmtBytes(L.bytes);
        const mBw = meas >= 1 ? meas.toFixed(1) : meas.toFixed(2);        const pct = Math.round(U.clamp(util, 0, 9.9) * 100);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(spec.label + (spec.key === 'l2>dram' && L.dirty ? '·脏替换' + L.dirty : ''),
          laneX + 5, mid - 6);
        ctx.fillStyle = '#c8d3e0';
        ctx.fillText(mb + ' · ' + mBw + 'B/ns', laneX + 5, mid + 5);
        ctx.fillStyle = U.clamp(util, 0, 1) >= 0.8 ? '#7ee787' : '#5b6675';
        ctx.fillText('利用率 ' + pct + '%', laneX + 5, mid + 15);
      }
    }
  }

  global.MHierView = HierView;
})(typeof window !== 'undefined' ? window : globalThis);