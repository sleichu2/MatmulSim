/* ============================================================
 * render-charts.js — 事件流时间线 + Roofline 模型
 *
 * 时间线: 将事件流按序分桶，堆叠显示各类事件(计算/DRAM/L2/L1/
 * 寄存器/其他)的时间占比，红色游标指示回放位置。
 * Roofline: 对数坐标下画出带宽墙(斜率=DRAM带宽)与峰值墙，
 * 标注三种理论工作点(无分块/当前分块/强制缺失下限)与实际回放点。
 * ============================================================ */
(function (global) {
  'use strict';
  const U = global.MUtil;

  /* ---------- 时间线 ---------- */
  class TimelineView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0;
      this.dpr = 1;
      this.player = null;
      this.bins = [];
    }
    resize(w, h, dpr) {
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    bind(player) {
      this.player = player;
      const NB = 200;
      const len = player.events.length;
      const per = Math.max(1, Math.ceil(len / NB));
      const bins = [];
      for (let s = 0; s < len; s += per) {
        const e = Math.min(len, s + per);
        const acc = { compute: 0, dram: 0, l2: 0, l1: 0, reg: 0, other: 0 };
        for (let i = s; i < e; i++) {
          const ev = player.events[i];
          const d = player.dwellOf(ev);
          let cat;
          if (ev.type === 'compute') cat = 'compute';
          else if (ev.type === 'xfer') cat = (ev.from === 'dram' || ev.to === 'dram') ? 'dram' : 'l2';
          else if (ev.type === 'reg') cat = 'reg';
          else cat = 'other';
          acc[cat] += d;
        }
        bins.push(acc);
      }
      this.bins = bins;
    }
    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!this.player || !this.bins.length) return;
      const STACK = [
        ['dram', '#f0883e'], ['l2', '#58a6ff'], ['l1', '#d2a8ff'],
        ['reg', '#8b98a9'], ['compute', '#3fb950'], ['other', '#2d333b'],
      ];
      let maxT = 1;
      for (const b of this.bins) {
        let t = 0;
        for (const [k] of STACK) t += b[k];
        if (t > maxT) maxT = t;
      }
      const bw = this.w / this.bins.length;
      const plotH = this.h - 12;
      for (let i = 0; i < this.bins.length; i++) {
        const b = this.bins[i];
        let y = 10 + plotH;
        for (const [k, c] of STACK) {
          const hh = plotH * (b[k] / maxT);
          if (hh > 0.2) {
            ctx.fillStyle = c;
            ctx.fillRect(i * bw, y - hh, Math.max(0.5, bw - 0.5), hh);
          }
          y -= hh;
        }
      }
      // 游标
      const cx = this.player.progress * this.w;
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, this.h - 10);
      ctx.stroke();
      ctx.fillStyle = '#5b6675';
      ctx.font = '8px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('◀ 事件流 · 每桶=' + Math.max(1, Math.ceil(this.player.events.length / 200)) + ' 事件', 2, this.h - 2);
    }
  }

  /* ---------- Roofline ---------- */
  class RooflineView {
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
    draw(cfg, analysis, live) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!cfg) return;
      const PEAK = global.MSim.PEAK, DRAM = global.MSim.BW.dram;
      const padL = 36, padR = 8, padT = 8, padB = 22;
      const pw = this.w - padL - padR, ph = this.h - padT - padB;
      const x0 = 0.06, x1 = 60, y0 = 1, y1 = 100;
      const lx = (v) => padL + (Math.log10(v) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0)) * pw;
      const ly = (v) => padT + ph - (Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) * ph;

      // 网格 + 轴
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (const v of [0.1, 0.5, 1, 5, 10, 50]) {
        ctx.beginPath(); ctx.moveTo(lx(v), padT); ctx.lineTo(lx(v), padT + ph); ctx.stroke();
      }
      for (const v of [2, 10, 50]) {
        ctx.beginPath(); ctx.moveTo(padL, ly(v)); ctx.lineTo(padL + pw, ly(v)); ctx.stroke();
      }
      ctx.fillStyle = '#5b6675';
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const v of [0.1, 0.5, 1, 5, 10, 50]) ctx.fillText(v, lx(v), padT + ph + 3);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of [2, 10, 50]) ctx.fillText(v, padL - 3, ly(v));
      ctx.fillStyle = '#8b98a9';
      ctx.font = '9px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('算术强度 (FLOP/B)', padL + pw / 2, this.h - 9);

      // 屋脊线: gf = min(PEAK, DRAM_GB/s * ai)
      const ridge = (ai) => Math.min(PEAK, DRAM * ai);
      ctx.strokeStyle = 'rgba(88,166,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const ai = x0 * Math.pow(x1 / x0, i / 60);
        const gf = ridge(ai);
        const X = lx(ai), Y = ly(gf);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(63,185,80,0.7)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, ly(PEAK));
      ctx.lineTo(padL + pw, ly(PEAK));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#58a6ff';
      ctx.font = '8px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('带宽墙 ' + DRAM + 'GB/s', padL + 4, ly(Math.min(PEAK, DRAM * x1)) - 8);
      ctx.fillStyle = '#3fb950';
      ctx.fillText('峰值 ' + PEAK + ' GFLOPS', padL + 4, ly(PEAK) - 8);

      // 理论工作点
      const pt = (a, color, label, hollow) => {
        if (a.gf < y0 || a.ai < x0) return;
        ctx.beginPath();
        ctx.arc(lx(a.ai), ly(a.gf), 3.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        if (!hollow) ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '8px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(label, lx(a.ai) + 6, ly(a.gf) + 3);
      };
      if (analysis) {
        pt(analysis.naive, '#f85149', '无分块(2MNK 搬运)');
        pt(analysis.cur, '#58a6ff', '当前分块(理论)');
        pt(analysis.ideal, '#3fb950', '理论上限(强制缺失)', true);
      }
      // 实际回放点
      if (live && live.gf > 0.5 && live.ai > 0.03) {
        const pulse = 2.6 + 1.6 * Math.sin((global.performance ? performance.now() : Date.now()) / 200);
        ctx.beginPath();
        ctx.arc(lx(live.ai), ly(live.gf), pulse, 0, Math.PI * 2);
        ctx.fillStyle = '#e6edf3';
        ctx.fill();
        ctx.fillStyle = '#e6edf3';
        ctx.font = '8px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('实际回放', lx(live.ai) + 6, ly(live.gf) + 3);
      }
    }
  }

  global.MTimelineView = TimelineView;
  global.MRooflineView = RooflineView;
})(typeof window !== 'undefined' ? window : globalThis);
