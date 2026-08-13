/* ============================================================
 * util.js — 通用工具：随机数、插值、颜色映射、格式化
 * 以 IIFE + 全局命名空间组织（经典脚本，file:// 可直接运行）
 * ============================================================ */
(function (global) {
  'use strict';

  /** mulberry32 — 确定性伪随机数发生器（可复现的演示数据） */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpRGB(c1, c2, t) {
    return [lerp(c1[0], c2[0], t) | 0, lerp(c1[1], c2[1], t) | 0, lerp(c1[2], c2[2], t) | 0];
  }
  function css(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  /** 数值 → 发散色（负=蓝，正=橙，0=深底），用于矩阵单元格 */
  function valueColor(v) {
    const t = clamp(Math.abs(v), 0, 1);
    const pos = [249, 115, 22], neg = [56, 189, 248], base = [18, 24, 34];
    return css(lerpRGB(base, v >= 0 ? pos : neg, 0.12 + 0.88 * t));
  }

  const HEAT_STOPS = [[14, 26, 43], [29, 78, 216], [34, 211, 238], [250, 204, 21], [239, 68, 68]];
  /** 热度 0..1 → 冷→热色（近似 viridis） */
  function heatColor(f) {
    f = clamp(f, 0, 1) * (HEAT_STOPS.length - 1);
    const i = Math.min(HEAT_STOPS.length - 2, Math.floor(f));
    return css(lerpRGB(HEAT_STOPS[i], HEAT_STOPS[i + 1], f - i));
  }

  /** 数字缩写（K/M/G） */
  function fmt(n, d) {
    d = d == null ? 1 : d;
    if (!isFinite(n)) return '∞';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(d) + 'G';
    if (a >= 1e6) return (n / 1e6).toFixed(d) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(d) + 'K';
    return n.toFixed(d);
  }
  function fmtBytes(b) {
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + 'MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + 'KB';
    return Math.round(b) + 'B';
  }
  function fmtNs(ns) {
    if (ns >= 1e6) return (ns / 1e6).toFixed(2) + 'ms';
    if (ns >= 1e3) return (ns / 1e3).toFixed(1) + 'µs';
    return ns.toFixed(0) + 'ns';
  }

  global.MUtil = { mulberry32, clamp, lerp, lerpRGB, css, valueColor, heatColor, fmt, fmtBytes, fmtNs };
})(typeof window !== 'undefined' ? window : globalThis);
