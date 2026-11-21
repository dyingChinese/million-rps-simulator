/**
 * genetics.js — 策略基因子系统
 *
 * 模块职责：
 *  1. 生成随机初始基因（建号）；
 *  2. 后代基因 = 父母基因混合 + 少量变异 + 按突变率随机扰动；
 *  3. 基因归一化/钳制、按概率出拳、策略三角坐标（供可视化与统计）。
 *
 * 基因布局（stride = GENE_STRIDE = 6，扁平存储，按 offset 访问，不创建对象）：
 *   [0] 出石头概率  [1] 出剪刀概率  [2] 出布概率
 *   [3] 风险偏好系数（赌注倍率倾向）
 *   [4] 保守阈值（资产低于该值 → 降低赌注）
 *   [5] 激进阈值（资产高于该值 → 提高赌注）
 *
 * 约束：
 *  - 0/1/2 归一化和为 1，且每个 ≥ 0.01；3 范围 [0.2, 3.0]；4 范围 [0, initialWealth×5]；
 *    5 范围 [initialWealth, initialWealth×50]（取值范围全部来自 docs/CONTRACTS.md §3）。
 *  - 出拳编码：MOVE_ROCK=0 / MOVE_SCISSORS=1 / MOVE_PAPER=2；胜负关系：0 胜 1、1 胜 2、2 胜 0。
 *  - 全部函数对 ArrayLike<number> + offset 工作，热路径零分配；随机性只用注入的 rng。
 *
 * @module genetics
 */

import { GENE_COUNT } from './store.js';

/** 每个基因的浮点跨度（6：三种拳概率 + 风险 + 保守阈值 + 激进阈值） */
export const GENE_STRIDE = GENE_COUNT;

/** 出拳编码：石头 */
export const MOVE_ROCK = 0;
/** 出拳编码：剪刀 */
export const MOVE_SCISSORS = 1;
/** 出拳编码：布 */
export const MOVE_PAPER = 2;

/** 三种拳概率的下界（契约：每个 ≥ 0.01） */
export const MIN_MOVE_PROB = 0.01;
/** 风险偏好下界 */
export const RISK_MIN = 0.2;
/** 风险偏好上界 */
export const RISK_MAX = 3.0;
/** 风险偏好默认（中性）值 */
export const RISK_DEFAULT = 1.0;
/** √3/2：策略三角中 y 轴（剪刀顶点）高度，x∈[0,1]，y∈[0,√3/2] */
export const SQRT3_2 = 0.8660254037844386;

/** 后代基因中策略概率的固有高斯扰动强度（突变率之外的“少量变异”） */
const INHERIT_STRATEGY_SIGMA = 0.02;
/** 后代基因中风险偏好的固有高斯扰动强度 */
const INHERIT_RISK_SIGMA = 0.05;

/**
 * 基因阈值基准：契约中 4/5 号基因的范围以 initialWealth 为基准。
 * initialWealth 非正时回退到 1，避免阈值区间退化成一个点。
 * @param {object} cfg 归一化配置
 * @returns {number} 基准资金
 */
function geneBase(cfg) {
  const base = cfg.initialWealth;
  return base > 0 ? base : 1;
}

/**
 * 随机初始化一个基因（建号用）。
 *
 * 三种拳概率在单纯形内均匀随机；风险偏好与两个阈值也**在契约允许范围内随机分布**
 * （同 seed 可复现，三拳随机逻辑不变）：
 *  - 风险偏好 ∈ [0.3, 2.5]（契约范围 [0.2, 3.0]）
 *  - 保守阈值 ∈ [0.2, 1.0] × initialWealth（契约范围 [0, 5] ×）
 *  - 激进阈值 ∈ [1.5, 5.0] × initialWealth（契约范围 [1, 50] ×）
 *
 * 为什么随机而不是取默认值：风险偏好只影响赌注大小、不改变期望收益，高风险个体
 * 赌注方差大 → 更容易暴富 / 破产；初始就有的个体差异让「破产淘汰、风险偏好自然选择、
 * 财富重尾分布」在演示中可见。此后仍由 inherit/mutate/策略学习继续演化。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置
 * @param {Float32Array|Float64Array|number[]} out 输出基因数组（长度足够）
 * @param {number} offset 起始下标（= slot × GENE_STRIDE）
 * @returns {void}
 */
export function randomGenome(rng, cfg, out, offset) {
  const base = geneBase(cfg);
  let p0 = rng.float();
  let p1 = rng.float();
  let p2 = rng.float();
  let sum = p0 + p1 + p2;
  if (!(sum > 0)) {
    p0 = 1 / 3;
    p1 = 1 / 3;
    p2 = 1 / 3;
    sum = 1;
  }
  const span = 1 - 3 * MIN_MOVE_PROB;
  out[offset] = MIN_MOVE_PROB + span * (p0 / sum);
  out[offset + 1] = MIN_MOVE_PROB + span * (p1 / sum);
  out[offset + 2] = MIN_MOVE_PROB + span * (p2 / sum);
  out[offset + 3] = 0.3 + rng.float() * 2.2; // 风险偏好 [0.3, 2.5]，契约允许 [0.2, 3.0]
  out[offset + 4] = base * (0.2 + rng.float() * 0.8); // 保守阈值 [0.2, 1.0]×初始资金
  out[offset + 5] = base * (1.5 + rng.float() * 3.5); // 激进阈值 [1.5, 5.0]×初始资金
}

/**
 * 修正并归一化策略概率、钳制风险/阈值范围（原地修改）。
 *
 * 归一化策略：先去掉非法值（NaN/负数）并按和归一；若任一概率低于 MIN_MOVE_PROB，
 * 再做一次「保下界映射」p_i = MIN + (1-3MIN)·p_i（映射后和仍为 1、每项 ≥ MIN）。
 * 已经合法的基因保持原样（幂等），避免遗传时无意义地反复缩放。
 *
 * @param {object} cfg 归一化配置
 * @param {Float32Array|Float64Array|number[]} genome 基因数组
 * @param {number} offset 起始下标
 * @returns {void}
 */
export function normalizeGenome(cfg, genome, offset) {
  const base = geneBase(cfg);
  let p0 = genome[offset];
  let p1 = genome[offset + 1];
  let p2 = genome[offset + 2];
  if (!Number.isFinite(p0) || p0 < 0) p0 = 0;
  if (!Number.isFinite(p1) || p1 < 0) p1 = 0;
  if (!Number.isFinite(p2) || p2 < 0) p2 = 0;
  let sum = p0 + p1 + p2;
  if (!(sum > 0)) {
    p0 = 1 / 3;
    p1 = 1 / 3;
    p2 = 1 / 3;
  } else {
    p0 /= sum;
    p1 /= sum;
    p2 /= sum;
  }
  if (p0 < MIN_MOVE_PROB || p1 < MIN_MOVE_PROB || p2 < MIN_MOVE_PROB) {
    const span = 1 - 3 * MIN_MOVE_PROB;
    p0 = MIN_MOVE_PROB + span * p0;
    p1 = MIN_MOVE_PROB + span * p1;
    p2 = MIN_MOVE_PROB + span * p2;
  }
  genome[offset] = p0;
  genome[offset + 1] = p1;
  genome[offset + 2] = p2;

  let risk = genome[offset + 3];
  if (!Number.isFinite(risk)) risk = RISK_DEFAULT;
  genome[offset + 3] = risk < RISK_MIN ? RISK_MIN : risk > RISK_MAX ? RISK_MAX : risk;

  let conservative = genome[offset + 4];
  if (!Number.isFinite(conservative)) conservative = base * 0.5;
  const consMax = base * 5;
  genome[offset + 4] = conservative < 0 ? 0 : conservative > consMax ? consMax : conservative;

  let aggressive = genome[offset + 5];
  if (!Number.isFinite(aggressive)) aggressive = base * 2;
  const aggrMax = base * 50;
  genome[offset + 5] = aggressive < base ? base : aggressive > aggrMax ? aggrMax : aggressive;
}

/**
 * 按 cfg.genetics.mutationRate 对基因的任一维度做一次随机扰动（原地）。
 *
 * 是否发生突变由本函数内部按突变率掷骰决定；突变卷中一个维度后统一归一化/钳制。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置
 * @param {Float32Array|Float64Array|number[]} genome 基因数组
 * @param {number} offset 起始下标
 * @returns {boolean} 是否发生了突变
 */
export function mutateGenome(rng, cfg, genome, offset) {
  const rate = cfg.genetics.mutationRate;
  if (!(rate > 0) || rng.float() >= rate) return false;
  const dim = rng.int(GENE_STRIDE);
  const base = geneBase(cfg);
  switch (dim) {
    case 0:
    case 1:
    case 2:
      // 某一拳概率轻微扰动，随后统一归一化
      genome[offset + dim] += rng.gauss() * 0.05;
      break;
    case 3:
      genome[offset + 3] += rng.gauss() * 0.2;
      break;
    case 4:
      genome[offset + 4] += rng.gauss() * base * 0.25;
      break;
    default:
      genome[offset + 5] += rng.gauss() * base;
      break;
  }
  normalizeGenome(cfg, genome, offset);
  return true;
}

/**
 * 生成后代基因（原地写入 out[outOff..outOff+5]）。
 *
 * 规则（契约 §3）：
 *  - 策略概率 = 父母均值 + 少量高斯变异（这里 σ=0.02，再归一化）；
 *  - 风险偏好 = 父母加权平均（各 50%）+ 轻微扰动；
 *  - 保守/激进阈值 = 父母中间值；
 *  - 最后按 cfg.genetics.mutationRate 触发一次额外突变。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {ArrayLike<number>} parentA 父方基因数组
 * @param {number} aOff 父方基因起始下标
 * @param {ArrayLike<number>} parentB 母方基因数组
 * @param {number} bOff 母方基因起始下标
 * @param {object} cfg 归一化配置
 * @param {Float32Array|Float64Array|number[]} out 子代基因数组
 * @param {number} outOff 子代基因起始下标
 * @returns {void}
 */
export function inheritGenome(rng, parentA, aOff, parentB, bOff, cfg, out, outOff) {
  out[outOff] = (parentA[aOff] + parentB[bOff]) * 0.5 + rng.gauss() * INHERIT_STRATEGY_SIGMA;
  out[outOff + 1] =
    (parentA[aOff + 1] + parentB[bOff + 1]) * 0.5 + rng.gauss() * INHERIT_STRATEGY_SIGMA;
  out[outOff + 2] =
    (parentA[aOff + 2] + parentB[bOff + 2]) * 0.5 + rng.gauss() * INHERIT_STRATEGY_SIGMA;
  out[outOff + 3] = (parentA[aOff + 3] + parentB[bOff + 3]) * 0.5 + rng.gauss() * INHERIT_RISK_SIGMA;
  out[outOff + 4] = (parentA[aOff + 4] + parentB[bOff + 4]) * 0.5;
  out[outOff + 5] = (parentA[aOff + 5] + parentB[bOff + 5]) * 0.5;
  normalizeGenome(cfg, out, outOff);
  mutateGenome(rng, cfg, out, outOff);
}

/**
 * 按基因概率出拳。基因已归一化，最后一次抽样兜底为布。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {ArrayLike<number>} genome 基因数组
 * @param {number} offset 起始下标
 * @returns {number} MOVE_ROCK / MOVE_SCISSORS / MOVE_PAPER
 */
export function pickMove(rng, genome, offset) {
  const r = rng.float();
  const pRock = genome[offset];
  if (r < pRock) return MOVE_ROCK;
  if (r < pRock + genome[offset + 1]) return MOVE_SCISSORS;
  return MOVE_PAPER;
}

/**
 * 计算策略三角坐标（供可视化/统计分析）：
 *   x = p_布 + 0.5·p_剪刀 ∈ [0,1]
 *   y = p_剪刀·(√3/2) ∈ [0, 0.866]
 *
 * @param {ArrayLike<number>} genome 基因数组
 * @param {number} offset 起始下标
 * @param {Float32Array|Float64Array|number[]} out2 长度为 2 的输出数组（原地写入）
 * @returns {void}
 */
export function strategyPoint(genome, offset, out2) {
  const pScissors = genome[offset + 1];
  out2[0] = genome[offset + 2] + 0.5 * pScissors;
  out2[1] = pScissors * SQRT3_2;
}
