/**
 * rng.js — 高性能、可复现的伪随机数发生器（xoshiro128** 变体）
 *
 * 模拟器唯一随机源。所有模块都必须通过注入的 Rng 实例获取随机数，
 * 以保证「相同 seed ⇒ 完全相同的历史轨迹」（单元测试依赖这一点）。
 */

/** 用 splitmix32 把一个 32 位种子扩散为 4 个状态字。 */
function splitmix32(state) {
  let s = state >>> 0;
  return function next() {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Rng {
  /**
   * @param {number|string} [seed=20241120]
   */
  constructor(seed = 20241120) {
    const s = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
    this.seed = s;
    const mix = splitmix32(s ^ 0xa5a5a5a5);
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    // 丢弃前若干个输出，避免低种子相关性
    for (let i = 0; i < 8; i++) this.nextU32();
    this._spare = 0;
    this._hasSpare = false;
    this.calls = 0;
  }

  /** @returns {number} 无符号 32 位随机整数（xoshiro128** 标准实现） */
  nextU32() {
    this.calls++;
    let s0 = this.s0;
    let s1 = this.s1;
    let s2 = this.s2;
    let s3 = this.s3;
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11) >>> 0;
    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
    return result;
  }

  /** @returns {number} [0, 1) 浮点数（32 位精度，热路径用） */
  float() {
    return this.nextU32() / 4294967296;
  }

  /** @returns {number} [0, 1) 双精度浮点数（53 位精度，低频用） */
  float53() {
    const a = this.nextU32() >>> 5; // 27 bits
    const b = this.nextU32() >>> 6; // 26 bits
    return (a * 67108864 + b) / 9007199254740992;
  }

  /**
   * @param {number} n 正整数
   * @returns {number} [0, n)
   */
  int(n) {
    // 先除后乘，避免 nextU32*n 超出 IEEE754 精确整数范围（n 可达数百万）
    return ((this.nextU32() / 4294967296) * n) | 0;
  }

  /**
   * @param {number} lo 含
   * @param {number} hi 不含
   * @returns {number}
   */
  range(lo, hi) {
    return lo + (hi - lo) * this.float();
  }

  /** @param {number} p 概率 [0,1] @returns {boolean} */
  chance(p) {
    return this.float() < p;
  }

  /** 标准正态分布（Box-Muller），用于基因变异。 */
  gauss() {
    if (this._hasSpare) {
      this._hasSpare = false;
      return this._spare;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.float();
    while (v === 0) v = this.float();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    this._spare = mag * Math.sin(2.0 * Math.PI * v);
    this._hasSpare = true;
    return mag * Math.cos(2.0 * Math.PI * v);
  }

  /** @template T @param {T[]} arr @returns {T} */
  pick(arr) {
    return arr[this.int(arr.length)];
  }

  /** 原地洗牌（Fisher-Yates）。 @template T @param {T[]|Int32Array} arr */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** 取当前状态，便于测试序列化/恢复。 */
  getState() {
    return {
      seed: this.seed,
      s0: this.s0,
      s1: this.s1,
      s2: this.s2,
      s3: this.s3,
      spare: this._spare,
      hasSpare: this._hasSpare,
    };
  }

  setState(st) {
    this.seed = st.seed;
    this.s0 = st.s0;
    this.s1 = st.s1;
    this.s2 = st.s2;
    this.s3 = st.s3;
    this._spare = st.spare;
    this._hasSpare = st.hasSpare;
    return this;
  }
}

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) | 0;
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 个体 ID 的稳定散列 → 固定的“泳道”坐标 [0,1)。
 * 可视化中每个个体占据固定横坐标，纵坐标随资产变化，形成“财富天际线”。
 * @param {number} id
 * @param {number} lanes
 * @returns {number} [0,1)
 */
export function hashLane(id, lanes) {
  let x = (id + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % lanes) / lanes;
}
