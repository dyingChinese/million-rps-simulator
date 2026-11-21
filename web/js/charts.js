/**
 * charts.js — Canvas2D 图表组件
 *
 * 约定：
 *  - 所有图表只提供 render(data)：由 panels 在 rAF 合批的 DOM 更新节拍（≥80ms）里调用，
 *    没有额外定时器，不会在帧与帧之间重绘。
 *  - 画布尺寸按 clientWidth/clientHeight × min(devicePixelRatio,2) 设置，兼顾清晰与性能；
 *  - 深色主题、等宽数字、细网格线；图表内文字字号 ≤10px，避免拥挤。
 *
 * 图表：资产直方图 / 洛伦兹曲线 / 时间序列（4 指标）/ 策略演化堆叠面积 / 阶层结构 / 追踪 sparkline。
 */

import { CLASS_COLORS, MOVE_COLORS } from './protocol.js';
import { fmtCompact, fmtPct, clamp } from './format.js';

const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
const GRID_COLOR = 'rgba(34,48,74,0.85)';
const AXIS_TEXT = 'rgba(143,163,191,0.85)';
const CURVE_COLORS = {
  population: '#54d3ff',
  wealth: '#f5b942',
  gini: '#42d392',
  births: '#42d392',
  deaths: '#ff5d73',
};

/** 适配画布尺寸（CSS 像素 × dpr），返回 CSS 尺寸 */
function fitCanvas(canvas, ctx) {
  const cw = Math.max(1, canvas.clientWidth || 0);
  const ch = Math.max(1, canvas.clientHeight || 0);
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const pw = Math.round(cw * dpr);
  const ph = Math.round(ch * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cw, h: ch };
}

/** 安全数值（NaN → 0） */
const safe = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 取整到 1/2/5 × 10^n 的“漂亮”上界 */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

/** 折线路径（跳过 NaN） */
function polyline(ctx, xs, ys, n) {
  let started = false;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
}

/* ────────────────────────────── 资产分布直方图 ────────────────────────────── */

export class HistogramChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** @param {{hist:Float32Array, mapping:object, median:number, p90:number}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 40 || h < 30) return;
    const hist = data && data.hist;
    const mapping = data && data.mapping;
    if (!hist || !hist.length || !mapping) return;

    const padL = 4;
    const padR = 6;
    const padT = 8;
    const padB = 14;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const bins = hist.length;

    let max = 0;
    for (let i = 0; i < bins; i++) if (hist[i] > max) max = hist[i];
    if (max <= 0) max = 1;
    const logMax = Math.log1p(max);

    // 纵向网格
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 1; g <= 2; g++) {
      const y = padT + (plotH * g) / 3;
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(w - padR, y + 0.5);
    }
    ctx.stroke();

    // 柱体（对数高度）
    const bw = plotW / bins;
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(84,211,255,0.95)');
    grad.addColorStop(0.55, 'rgba(70,150,255,0.55)');
    grad.addColorStop(1, 'rgba(84,211,255,0.10)');
    ctx.fillStyle = grad;
    for (let i = 0; i < bins; i++) {
      const v = hist[i];
      if (v <= 0) continue;
      const bh = (Math.log1p(v) / logMax) * plotH;
      const x = padL + i * bw;
      ctx.fillRect(x, padT + plotH - bh, Math.max(1, bw - 0.6), bh);
    }

    // 基线
    ctx.strokeStyle = 'rgba(34,48,74,1)';
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(w - padR, padT + plotH + 0.5);
    ctx.stroke();

    // 中位数 / P90 竖线
    const marks = [
      { asset: data.median, color: 'rgba(245,185,66,0.9)', label: '中位' },
      { asset: data.p90, color: 'rgba(66,211,146,0.9)', label: 'P90' },
    ];
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = 'top';
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (!Number.isFinite(m.asset)) continue;
      const x = padL + mapping.toY(m.asset) * plotW;
      if (x < padL || x > w - padR) continue;
      ctx.strokeStyle = m.color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, padT);
      ctx.lineTo(x + 0.5, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.textAlign = x > w - 46 ? 'right' : 'left';
      ctx.fillText(m.label, x + (x > w - 46 ? -3 : 3), padT + 1);
    }

    // 横轴刻度（对数财富轴，用映射反推资产标签）
    ctx.fillStyle = AXIS_TEXT;
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = 'top';
    const ticks = [
      { y: 0, text: fmtCompact(mapping.fromY(0)) },
      { y: 0.5, text: fmtCompact(mapping.fromY(0.5)) },
      { y: 1, text: fmtCompact(mapping.fromY(1)) },
    ];
    for (let i = 0; i < ticks.length; i++) {
      const x = padL + ticks[i].y * plotW;
      ctx.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center';
      ctx.fillText(ticks[i].text, x, padT + plotH + 3);
    }
  }
}

/* ────────────────────────────── 洛伦兹曲线 ────────────────────────────── */

export class LorenzChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** @param {{lorenz:number[], gini:number}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 40 || h < 30) return;
    const lorenz = data && data.lorenz;
    if (!lorenz || lorenz.length < 4) return;
    const padL = 22;
    const padR = 8;
    const padT = 8;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const n = Math.floor(lorenz.length / 2);

    // 网格
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 1; g <= 3; g++) {
      const y = padT + (plotH * g) / 4;
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(w - padR, y + 0.5);
      const x = padL + (plotW * g) / 4;
      ctx.moveTo(x + 0.5, padT);
      ctx.lineTo(x + 0.5, padT + plotH);
    }
    ctx.stroke();

    // 45° 参考线
    ctx.strokeStyle = 'rgba(95,115,145,0.7)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT);
    ctx.stroke();
    ctx.setLineDash([]);

    // 洛伦兹曲线
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = padL + clamp(safe(lorenz[i * 2]), 0, 1) * plotW;
      ys[i] = padT + plotH - clamp(safe(lorenz[i * 2 + 1]), 0, 1) * plotH;
    }
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(84,211,255,0.28)');
    grad.addColorStop(1, 'rgba(84,211,255,0.01)');
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    polyline(ctx, xs, ys, n);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    polyline(ctx, xs, ys, n);
    ctx.strokeStyle = 'rgba(84,211,255,0.95)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 基尼数值
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(245,185,66,0.95)';
    ctx.fillText('基尼 GINI ' + safe(data.gini).toFixed(3), padL + 2, padT + 2);

    // 轴标签
    ctx.fillStyle = AXIS_TEXT;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', padL - 3, padT + plotH + 1);
    ctx.fillText('100%', padL - 3, padT + 9);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('人口累计占比 →', padL + plotW / 2, padT + plotH + 4);
  }
}

/* ────────────────────────────── 时间序列（双指标/多指标） ────────────────────────────── */

const METRIC_DEFS = {
  population: { label: '存活人口', keys: ['alive'], colors: [CURVE_COLORS.population], unit: 'count' },
  wealth: { label: '总资产', keys: ['totalWealth'], colors: [CURVE_COLORS.wealth], unit: 'wealth' },
  flows: { label: '出生 / 死亡', keys: ['births', 'deaths'], colors: [CURVE_COLORS.births, CURVE_COLORS.deaths], unit: 'count' },
  gini: { label: '基尼系数', keys: ['gini'], colors: [CURVE_COLORS.gini], unit: 'ratio' },
};

export class TimeSeriesChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.metric = 'population';
  }

  setMetric(metric) {
    if (METRIC_DEFS[metric]) this.metric = metric;
  }

  getMetric() {
    return this.metric;
  }

  /** @param {{series:object}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 40 || h < 30) return;
    const series = data && data.series;
    if (!series) return;
    const def = METRIC_DEFS[this.metric] || METRIC_DEFS.population;
    const len = (series[def.keys[0]] || []).length;
    if (len < 2) {
      ctx.fillStyle = AXIS_TEXT;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待时间序列数据…', w / 2, h / 2);
      return;
    }
    const padL = 4;
    const padR = 4;
    const padT = 12;
    const padB = 12;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // 数值范围
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < def.keys.length; k++) {
      const list = series[def.keys[k]] || [];
      for (let i = 0; i < list.length; i++) {
        const v = safe(list[i]);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    if (max === min) {
      max = min + Math.abs(min) * 0.1 + 1;
    }
    let lo = min;
    let hi = max;
    if (def.unit === 'ratio') {
      lo = 0;
      hi = 1;
    } else if (def.unit === 'count') {
      const pad = (max - min) * 0.12 || max * 0.05 || 1;
      lo = Math.max(0, min - pad);
      hi = max + pad;
    } else {
      lo = Math.min(0, min);
      hi = max * 1.06 || 1;
    }
    hi = niceMax(hi);
    if (hi <= lo) hi = lo + 1;

    // 网格
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 1; g <= 3; g++) {
      const y = padT + (plotH * g) / 3;
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(w - padR, y + 0.5);
    }
    ctx.stroke();

    // 曲线
    const xs = new Float32Array(len);
    for (let i = 0; i < len; i++) xs[i] = padL + (i / (len - 1)) * plotW;
    const ys = new Float32Array(len);
    for (let k = 0; k < def.keys.length; k++) {
      const list = series[def.keys[k]] || [];
      const n = Math.min(len, list.length);
      for (let i = 0; i < n; i++) {
        const v = safe(list[i]);
        ys[i] = padT + plotH - ((v - lo) / (hi - lo)) * plotH;
      }
      // 面积填充仅单指标
      if (def.keys.length === 1) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, hexAlpha(def.colors[0], 0.25));
        grad.addColorStop(1, hexAlpha(def.colors[0], 0.02));
        ctx.beginPath();
        ctx.moveTo(xs[0], padT + plotH);
        for (let i = 0; i < n; i++) ctx.lineTo(xs[i], ys[i]);
        ctx.lineTo(xs[n - 1], padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      polyline(ctx, xs, ys, n);
      ctx.strokeStyle = def.colors[k];
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 图例（左上角）
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const legend = def.keys.length === 1
      ? [{ text: def.label, color: def.colors[0] }]
      : [{ text: '出生', color: def.colors[0] }, { text: '死亡', color: def.colors[1] }];
    let lx = w - padR - 2;
    for (let i = legend.length - 1; i >= 0; i--) {
      ctx.fillStyle = legend[i].color;
      const tw = ctx.measureText(legend[i].text).width;
      ctx.fillText(legend[i].text, lx, padT - 10);
      ctx.fillRect(lx - tw - 7, padT - 6.5, 4, 4);
      lx -= tw + 14;
    }

    // 纵轴最大/最小标签
    ctx.fillStyle = AXIS_TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtAxisValue(hi, def.unit), padL + 1, padT + 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtAxisValue(lo, def.unit), padL + 1, padT + plotH - 1);

    // 横轴：起止回合
    const rounds = series.round || [];
    if (rounds.length > 1) {
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(String(rounds[0]), padL, padT + plotH + 2);
      ctx.textAlign = 'right';
      ctx.fillText(String(rounds[rounds.length - 1]), w - padR, padT + plotH + 2);
    }
  }
}

function fmtAxisValue(v, unit) {
  if (unit === 'ratio') return safe(v).toFixed(2);
  return fmtCompact(v);
}

/** '#54d3ff' + alpha → rgba() */
function hexAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ────────────────────────────── 策略演化堆叠面积 ────────────────────────────── */

export class StackedAreaChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** @param {{series:object}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 40 || h < 20) return;
    const series = data && data.series;
    if (!series) return;
    const keys = ['rock', 'scissors', 'paper'];
    const len = (series[keys[0]] || []).length;
    if (len < 2) {
      ctx.fillStyle = AXIS_TEXT;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待策略演化数据…', w / 2, h / 2);
      return;
    }
    const padB = 10;
    const plotH = h - padB;
    const x0 = 0;
    const plotW = w;

    // 每列归一化（防御服务端主导占比之和≠1）
    const ys = [new Float32Array(len), new Float32Array(len), new Float32Array(len)];
    for (let i = 0; i < len; i++) {
      const a = Math.max(0, safe((series.rock || [])[i]));
      const b = Math.max(0, safe((series.scissors || [])[i]));
      const c = Math.max(0, safe((series.paper || [])[i]));
      const sum = a + b + c || 1;
      ys[0][i] = a / sum;
      ys[1][i] = b / sum;
      ys[2][i] = c / sum;
    }
    // 自下而上堆叠：石、剪、布
    const xs = new Float32Array(len);
    for (let i = 0; i < len; i++) xs[i] = x0 + (i / (len - 1)) * plotW;
    let base = new Float32Array(len); // 当前累计高度（0..1）
    for (let k = 0; k < 3; k++) {
      const top = new Float32Array(len);
      for (let i = 0; i < len; i++) top[i] = base[i] + ys[k][i];
      ctx.beginPath();
      ctx.moveTo(xs[0], plotH - base[0] * plotH);
      for (let i = 0; i < len; i++) ctx.lineTo(xs[i], plotH - top[i] * plotH);
      for (let i = len - 1; i >= 0; i--) ctx.lineTo(xs[i], plotH - base[i] * plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, plotH);
      grad.addColorStop(0, hexAlpha(MOVE_COLORS[k], 0.62));
      grad.addColorStop(1, hexAlpha(MOVE_COLORS[k], 0.30));
      ctx.fillStyle = grad;
      ctx.fill();
      // 分界线
      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const y = plotH - top[i] * plotH;
        if (i === 0) ctx.moveTo(xs[i], y);
        else ctx.lineTo(xs[i], y);
      }
      ctx.strokeStyle = hexAlpha(MOVE_COLORS[k], 0.75);
      ctx.lineWidth = 1;
      ctx.stroke();
      base = top;
    }
    // 100% 线
    ctx.strokeStyle = 'rgba(34,48,74,1)';
    ctx.beginPath();
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();
    // 纵轴首尾标签（100% / 0）
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = AXIS_TEXT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('100%', w - 2, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText('0', w - 2, plotH - 1);
  }
}

/* ────────────────────────────── 阶层结构（双横条） ────────────────────────────── */

export class ClassBarsChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** @param {{classes:Array, classColors?:string[]}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 60 || h < 26) return;
    const classes = (data && data.classes) || [];
    const colors = (data && data.classColors) || CLASS_COLORS;
    const rows = [
      { label: '人口', key: 'share', values: classes.map((c) => clamp(safe(c.share), 0, 1)) },
      { label: '资产', key: 'wealthShare', values: classes.map((c) => clamp(safe(c.wealthShare), 0, 1)) },
    ];
    const labelW = 24;
    const barX = labelW + 4;
    const barW = w - barX - 2;
    const barH = Math.min(13, (h - 8) / 2 - 4);
    const gap = 6;
    const startY = (h - (barH * 2 + gap)) / 2;

    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < 2; r++) {
      const y = startY + r * (barH + gap);
      ctx.fillStyle = AXIS_TEXT;
      ctx.fillText(rows[r].label, 0, y + barH / 2);
      // 归一化（防止误差导致总和不等于 1）
      const vals = rows[r].values;
      const sum = vals.reduce((a, b) => a + b, 0) || 1;
      let x = barX;
      for (let i = 0; i < vals.length; i++) {
        const segW = (vals[i] / sum) * barW;
        if (segW <= 0) continue;
        ctx.fillStyle = hexAlpha(colors[i] || '#5b6b8c', r === 0 ? 0.85 : 0.55);
        ctx.fillRect(x, y, Math.max(1, segW - 0.5), barH);
        // 段内百分比
        if (segW > 30) {
          ctx.fillStyle = 'rgba(8,11,18,0.85)';
          ctx.font = `9px ${MONO}`;
          ctx.textAlign = 'center';
          ctx.fillText(Math.round((vals[i] / sum) * 100) + '%', x + segW / 2, y + barH / 2);
          ctx.textAlign = 'left';
        }
        x += segW;
      }
      // 外框
      ctx.strokeStyle = 'rgba(34,48,74,0.9)';
      ctx.strokeRect(barX + 0.5, y + 0.5, barW - 1, barH - 1);
    }
  }
}

/* ────────────────────────────── 追踪个体 sparkline ────────────────────────────── */

export class Sparkline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** @param {{history:number[][], positive?:boolean}} data */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    if (w < 20 || h < 12) return;
    const history = (data && data.history) || [];
    const n = history.length;
    if (n < 2) {
      ctx.strokeStyle = 'rgba(34,48,74,0.8)';
      ctx.beginPath();
      ctx.moveTo(0, h - 1);
      ctx.lineTo(w, h - 1);
      ctx.stroke();
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = safe(history[i] && history[i][1]);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max === min) {
      max = min + 1;
    }
    const plotH = h - 4;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (i / (n - 1)) * w;
      ys[i] = 2 + plotH - ((safe(history[i][1]) - min) / (max - min)) * plotH;
    }
    const last = safe(history[n - 1][1]);
    const color = last >= 0 ? 'rgba(84,211,255,0.95)' : 'rgba(255,93,115,0.95)';
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexAlpha(last >= 0 ? '#54d3ff' : '#ff5d73', 0.30));
    grad.addColorStop(1, 'rgba(84,211,255,0.01)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    polyline(ctx, xs, ys, n);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 末点
    ctx.beginPath();
    ctx.arc(xs[n - 1], ys[n - 1], 1.8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}
