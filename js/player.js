/* ============================================================
 * player.js — 事件轨迹回放控制器
 *
 * 逐个处理 trace 事件，维护可视化所需的全部运行状态：
 *  - C 的部分和（真实累加，最终收敛到参考结果）
 *  - 每个单元格的 MAC 次数（访问热度）
 *  - 内存层次的驻留镜像（与模拟器 LRU 一致）
 *  - 运行计数器（FLOPs、各层搬运字节、命中/未中、校验误差）
 *
 * 回放节奏：每个事件有固定「驻留时长」（按类型加权），
 * 除以速度即墙钟时间 → 总播放时长确定、可预测。
 * ============================================================ */
(function (global) {
  'use strict';

  // 每个事件类型的回放驻留时长 (ms, 1× 速度)
  // 搬运类事件按字节数缩放：小搬运(缓存行级)快、大搬运(面板级)慢
  const DWELL = {
    compute: 16, reg: 8, hit: 3, evict: 4, oversize: 20,
  };

  class Player {
    constructor(result) {
      this.result = result;
      this.events = result.events;
      this.cfg = result.cfg;
      this.A = result.A;
      this.B = result.B;
      this.refC = result.refC || null;
      this.M = result.cfg.M;
      this.N = result.cfg.N;
      this.K = result.cfg.K;
      this.reset();
    }

    reset() {
      this.cursor = 0;
      this.simT = 0;
      this.C = new Float64Array(this.M * this.N);   // 部分和（真实累加）
      this.heat = new Float64Array(this.M * this.N); // 每格 MAC 次数
      this.cur = null;        // 最近一次 compute 事件（当前微内核位置）
      this.regC = null;       // 最近一次寄存器 C 微块载入
      this.memL2 = new Map(); // 驻留镜像: id -> {panel, bytes}
      this.memL1 = new Map();
      this.dramR = 0; this.dramW = 0; this.l2B = 0; this.regB = 0; this.flops = 0;
      this.l2Hit = 0; this.l2Miss = 0; this.l1Hit = 0; this.l1Miss = 0;
      this.evicts = 0; this.oversize = 0;
      this.maxErr = null; this.errDone = false;
      this.lastEv = null;
      this.isEnd = this.events.length === 0;
      this.dirty = [];          // 需要重绘的 C 单元格 [ri, ci]
      this.fullRepaint = true;
    }

    dwellOf(ev) {
      switch (ev.type) {
        case 'compute': return DWELL.compute;
        case 'reg': return DWELL.reg;
        case 'hit': return DWELL.hit;
        case 'evict': return DWELL.evict;
        case 'oversize': return DWELL.oversize;
        case 'xfer': {
          const base = global.MUtil.clamp((ev.bytes || 64) * 0.06, 12, 40);
          if (ev.to === 'l2') return base + 6;   // DRAM→L2 面板
          if (ev.from === 'dram') return base + 4; // 级联缺失 DRAM→L1
          if (ev.to === 'dram') return base;      // 写回
          return base;                            // L2→L1
        }
        default: return 10;
      }
    }

    processEvent(ev) {
      this.simT = ev.t;
      this.lastEv = ev;
      switch (ev.type) {
        case 'compute': {
          const { i, j, k, mr, nr } = ev;
          this.cur = ev;
          for (let ii = 0; ii < mr; ii++) {
            const ai = i + ii;
            const aVal = this.A[ai * this.K + k];
            for (let jj = 0; jj < nr; jj++) {
              const ci = ai * this.N + j + jj;
              this.C[ci] += aVal * this.B[k * this.N + j + jj];
              this.heat[ci]++;
              if (this.dirty.length < 4096) this.dirty.push([ai, j + jj]);
              else this.fullRepaint = true;
              if (this.heat[ci] === this.K && this.refC) {
                const e = Math.abs(this.C[ci] - this.refC[ci]);
                if (this.maxErr === null || e > this.maxErr) this.maxErr = e;
                this.errDone = true;
              }
            }
          }
          this.flops += ev.flops;
          this.regB += ev.regBytes;
          break;
        }
        case 'reg':
          if (ev.panel === 'C') this.regC = ev;
          this.regB += ev.bytes;
          break;
        case 'xfer':
          if (ev.from === 'dram') this.dramR += ev.bytes;
          if (ev.from === 'l2' && ev.to === 'dram') { this.dramW += ev.bytes; this.memL2.delete(ev.id); }
          if (ev.to === 'l2' && !ev.oversize) this.memL2.set(ev.id, { panel: ev.panel, bytes: ev.bytes });
          if (ev.to === 'l1') { this.memL1.set(ev.id, { panel: ev.panel, bytes: ev.bytes }); this.l1Miss++; }
          if (ev.from === 'l2' && ev.to === 'l1') this.l2B += ev.bytes;
          if (ev.from === 'dram' && ev.to === 'l2' && ev.miss) this.l2Miss++;
          if (ev.from === 'dram' && ev.to === 'l1') this.l2Miss++; // 级联缺失计为 L2 未命中
          if (ev.oversize) this.oversize++;
          break;
        case 'hit':
          if (ev.level === 'l2') this.l2Hit++; else this.l1Hit++;
          break;
        case 'evict':
          this.evicts++;
          (ev.level === 'l2' ? this.memL2 : this.memL1).delete(ev.id);
          break;
        case 'oversize':
          this.oversize++;
          if (ev.miss) { if (ev.level === 'l2') this.l2Miss++; else this.l1Miss++; }
          break;
      }
      this.cursor++;
      if (this.cursor >= this.events.length) this.isEnd = true;
    }

    /** 按真实帧时间推进回放；返回处理的事件数 */
    advance(dtMs, speed, onEvent) {
      if (this.isEnd) return 0;
      let budget = dtMs;
      let n = 0;
      const t0 = (global.performance && performance.now) ? performance.now() : Date.now();
      while (!this.isEnd && budget > 0) {
        const ev = this.events[this.cursor];
        const dwell = Math.max(1, this.dwellOf(ev) / speed);
        if (dwell > budget) break;
        budget -= dwell;
        this.processEvent(ev);
        if (onEvent) onEvent(ev, dwell);
        n++;
        if (n % 64 === 0 && ((global.performance && performance.now) ? performance.now() : Date.now()) - t0 > 12) break;
      }
      return n;
    }

    /** 单步：mode = event | k | block | tile */
    step(mode, onEvent) {
      if (this.isEnd) return 0;
      const get = () => {
        if (!this.cur) return null;
        if (mode === 'k') return this.cur.i + ':' + this.cur.j + ':' + this.cur.k;
        if (mode === 'block') return this.cur.i + ':' + this.cur.j;
        return this.cur.k2; // tile
      };
      const before = get();
      let n = 0;
      while (!this.isEnd && n < 500000) {
        const ev = this.events[this.cursor];
        const d = this.dwellOf(ev);
        this.processEvent(ev);
        if (onEvent) onEvent(ev, d);
        n++;
        if (mode === 'event' || (this.cur && get() !== before)) break;
      }
      return n;
    }

    /** 直接处理完所有剩余事件 */
    seekEnd(onEvent) {
      while (!this.isEnd) {
        const ev = this.events[this.cursor];
        const d = Math.min(this.dwellOf(ev), 8);
        this.processEvent(ev);
        if (onEvent) onEvent(ev, d);
      }
    }

    get progress() { return this.events.length ? this.cursor / this.events.length : 1; }

    /** 运行中的算术强度与速率（用于 Roofline 动态点） */
    get liveAI() { return this.flops / Math.max(8, this.dramR + this.dramW); }
    get liveGF() { return this.flops / Math.max(1, this.simT); }
  }

  global.MPlayer = Player;
})(typeof window !== 'undefined' ? window : globalThis);
