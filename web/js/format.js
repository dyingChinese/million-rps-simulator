/**
 * format.js — 数字 / 百分比 / 中文单位格式化
 *
 * 单一职责：把裸数据变成界面上紧凑、等宽对齐的中文数字串。
 * 规则（UI-SPEC §4）：
 *   |v| < 1e4  → 原值（最多 1 位小数）
 *   |v| ≥ 1e4  → x.xx 万
 *   |v| ≥ 1e8  → x.xx 亿
 * 对 null / undefined / NaN / Infinity 一律返回 '—'，保证 UI 上不出现 "NaN"。
 */

export const DASH = '—';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 去掉小数末尾多余的 0：'12.30' → '12.3'，'12.00' → '12'（至少保留 minFrac 位） */
export function trimNum(s, minFrac = 0) {
  if (typeof s !== 'string') return DASH;
  const dot = s.indexOf('.');
  if (dot < 0) return s;
  let end = s.length;
  while (end > dot + 1 && s.charCodeAt(end - 1) === 48 /* '0' */) end--;
  // 需要至少保留 minFrac 位小数时补回来
  if (end - dot - 1 < minFrac) end = Math.min(s.length, dot + 1 + minFrac);
  // 只有孤立小数点时直接去掉小数点（如 '100.' → '100'）
  if (end - 1 === dot) end = dot;
  const out = s.slice(0, end);
  return out || '0';
}

/**
 * 通用数字格式化：万 / 亿单位。
 * @param {number} v
 * @param {number} [digits=2] 万/亿单位下保留的小数位
 */
export function fmtNum(v, digits = 2) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e8) return trimNum((v / 1e8).toFixed(digits)) + ' 亿';
  if (a >= 1e4) return trimNum((v / 1e4).toFixed(digits)) + ' 万';
  if (Number.isInteger(v)) return String(v);
  return trimNum(v.toFixed(Math.abs(v) < 10 ? 2 : 1));
}

/** 计数（整数）：≥1 万时用万/亿，否则取整 */
export function fmtInt(v) {
  if (!isNum(v)) return DASH;
  if (Math.abs(v) >= 1e4) return fmtNum(v, 2);
  return String(Math.round(v));
}

/** 坐标轴 / 小空间用的更紧凑数字 */
export function fmtAxis(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e8) return trimNum((v / 1e8).toFixed(1)) + '亿';
  if (a >= 1e4) return trimNum((v / 1e4).toFixed(1)) + '万';
  if (a >= 1000) return String(Math.round(v));
  if (a >= 10) return String(Math.round(v));
  return trimNum(v.toFixed(1));
}

/** 带符号数字（事件金额、涨跌） */
export function fmtSigned(v, digits = 2) {
  if (!isNum(v)) return DASH;
  if (v > 0) return '+' + fmtNum(v, digits);
  if (v < 0) return '-' + fmtNum(-v, digits);
  return '0';
}

/** 比例（0..1）→ 百分比 */
export function fmtPct(v, digits = 1) {
  if (!isNum(v)) return DASH;
  const p = v * 100;
  return trimNum(p.toFixed(digits)) + '%';
}

/** 已经是百分数的值（0..100）→ 百分比 */
export function fmtPctValue(v, digits = 1) {
  if (!isNum(v)) return DASH;
  return trimNum(v.toFixed(digits)) + '%';
}

/** 毫秒 */
export function fmtMs(v, digits = 1) {
  if (!isNum(v)) return DASH;
  if (v >= 100) return v.toFixed(0) + ' ms';
  return v.toFixed(digits) + ' ms';
}

/** 字节 → KB / MB */
export function fmtBytes(bytes) {
  if (!isNum(bytes)) return DASH;
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

/** 回合/秒 */
export function fmtSpeed(rps) {
  if (!isNum(rps)) return DASH;
  if (rps >= 100) return rps.toFixed(0) + ' 回合/秒';
  return rps.toFixed(1) + ' 回合/秒';
}

/** 时间戳 → HH:MM:SS */
export function fmtTime(ts) {
  if (!isNum(ts) || ts <= 0) return '--:--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 运行时长（毫秒）→ 1h 02m / 3m 12s */
export function fmtUptime(ms) {
  if (!isNum(ms) || ms < 0) return DASH;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

/** 策略熵：0..ln3≈1.0986 */
export function fmtEntropy(v) {
  if (!isNum(v)) return DASH;
  return v.toFixed(3) + ' / 1.099';
}

/** 年龄（回合） */
export function fmtAge(v) {
  if (!isNum(v)) return DASH;
  return Math.round(v) + ' 回合';
}

/** 大数缩写（无单位，用于极小的图内标签） */
export function fmtCompact(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e8) return trimNum((v / 1e8).toFixed(1)) + '亿';
  if (a >= 1e4) return trimNum((v / 1e4).toFixed(1)) + '万';
  if (a >= 1e3) return trimNum((v / 1e3).toFixed(1)) + 'k';
  return String(Math.round(v));
}

/** 0..1 限制 */
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
