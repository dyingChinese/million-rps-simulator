/**
 * talents.js — 天赋子系统
 *
 * 模块职责：
 *  1. 定义 6 种天赋的编码（必须与 store.js / config.js 中的顺序严格一致）；
 *  2. 提供「建号时加权抽签」与「后代父母继承 + 小概率突变」两种天赋生成方式；
 *  3. 提供天赋效果系数查询（成本 / 胜率 / 生育成本 / 学习速度 / 负债上限）。
 *
 * 约定：
 *  - 本模块所有函数都是无状态纯函数，随机性只来自注入的 `rng` 实例；
 *  - 天赋开关与全部数值参数只从 `cfg.talents` 读取，不在本模块硬编码业务数值；
 *  - 天赋系统关闭（cfg.talents.enabled === false）时，抽签恒为「无」、效果恒为中性值。
 *
 * @module talents
 */

import {
  TALENT_NONE as STORE_TALENT_NONE,
  TALENT_LUCKY as STORE_TALENT_LUCKY,
  TALENT_THRIFTY as STORE_TALENT_THRIFTY,
  TALENT_FERTILE as STORE_TALENT_FERTILE,
  TALENT_FAST_LEARNER as STORE_TALENT_FAST_LEARNER,
  TALENT_DEBT_RESISTANT as STORE_TALENT_DEBT_RESISTANT,
  TALENT_COUNT as STORE_TALENT_COUNT,
} from './store.js';
import { TALENT_NAMES as CONFIG_TALENT_NAMES } from './config.js';

/**
 * 天赋常量表（与 store.js 中的 TALENT_* 完全一致，避免两处硬编码漂移）。
 * @readonly
 */
export const TALENT = {
  NONE: STORE_TALENT_NONE,
  LUCKY: STORE_TALENT_LUCKY,
  THRIFTY: STORE_TALENT_THRIFTY,
  FERTILE: STORE_TALENT_FERTILE,
  FAST_LEARNER: STORE_TALENT_FAST_LEARNER,
  DEBT_RESISTANT: STORE_TALENT_DEBT_RESISTANT,
};

/** 天赋总数（6）。 */
export const TALENT_COUNT = STORE_TALENT_COUNT;

/** 天赋中文名（复用 config.js 的权威数组，保证与设置面板/图例一致）。 */
export const TALENT_NAMES = CONFIG_TALENT_NAMES;

/**
 * 从 cfg.talents.weights 加权随机抽取一个天赋。
 *
 * 权重键与天赋编码一一对应：none/lucky/thrifty/fertile/fastLearner/debtResistant → 0..5。
 * 天赋系统关闭、或权重全为 0 时返回 TALENT.NONE；负权重按 0 处理（防御配置被手改）。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置（createConfig 结果）
 * @returns {number} 天赋编码 0..5
 */
export function rollTalent(rng, cfg) {
  const t = cfg.talents;
  if (!t.enabled) return TALENT.NONE;
  const w = t.weights;
  const none = w.none > 0 ? w.none : 0;
  const lucky = w.lucky > 0 ? w.lucky : 0;
  const thrifty = w.thrifty > 0 ? w.thrifty : 0;
  const fertile = w.fertile > 0 ? w.fertile : 0;
  const learner = w.fastLearner > 0 ? w.fastLearner : 0;
  const debt = w.debtResistant > 0 ? w.debtResistant : 0;
  const total = none + lucky + thrifty + fertile + learner + debt;
  if (!(total > 0)) return TALENT.NONE;
  let r = rng.float() * total;
  r -= none;
  if (r < 0) return TALENT.NONE;
  r -= lucky;
  if (r < 0) return TALENT.LUCKY;
  r -= thrifty;
  if (r < 0) return TALENT.THRIFTY;
  r -= fertile;
  if (r < 0) return TALENT.FERTILE;
  r -= learner;
  if (r < 0) return TALENT.FAST_LEARNER;
  return TALENT.DEBT_RESISTANT;
}

/**
 * 后代天赋：有 cfg.talents.inheritanceMutation 概率突变为随机天赋，
 * 否则从父母之一继承（各 50%）。
 *
 * 注意：概率为 0 时不会消耗随机数（rng.chance(0) 也返回 false，这里直接短路以保持
 * 随机流干净），保证「关闭突变」等配置下同 seed 结果稳定。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {number} talentA 父方天赋编码
 * @param {number} talentB 母方天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 后代天赋编码 0..5
 */
export function inheritTalent(rng, talentA, talentB, cfg) {
  const t = cfg.talents;
  if (!t.enabled) return TALENT.NONE;
  const mut = t.inheritanceMutation;
  if (mut > 0 && rng.float() < mut) return rollTalent(rng, cfg);
  return rng.float() < 0.5 ? talentA : talentB;
}

/**
 * 猜拳成本系数（个体每次猜拳成本 = 基础成本 × 该系数）。
 * 节俭者 → 1 - thriftyCostReduce；其它/未启用 → 1（中性）。
 *
 * @param {number} talent 天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 成本系数
 */
export function costFactor(talent, cfg) {
  const t = cfg.talents;
  if (!t.enabled || talent !== TALENT.THRIFTY) return 1;
  return 1 - t.effects.thriftyCostReduce;
}

/**
 * 胜率加成（加到基础胜率上）。
 * 幸运儿 → luckBonus；其它/未启用 → 0（中性）。
 *
 * @param {number} talent 天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 胜率加成（0 ~ 1）
 */
export function winBonus(talent, cfg) {
  const t = cfg.talents;
  if (!t.enabled || talent !== TALENT.LUCKY) return 0;
  return t.effects.luckBonus;
}

/**
 * 生育成本系数（生育成本 = 基础生育成本/额外成本 × 该系数）。
 * 生育达人 → 1 - fertileBirthCostReduce；其它/未启用 → 1（中性）。
 *
 * @param {number} talent 天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 生育成本系数
 */
export function birthCostFactor(talent, cfg) {
  const t = cfg.talents;
  if (!t.enabled || talent !== TALENT.FERTILE) return 1;
  return 1 - t.effects.fertileBirthCostReduce;
}

/**
 * 学习速度系数（策略微调/模仿幅度 × 该系数）。
 * 学习天才 → 1 + fastLearn；其它/未启用 → 1（中性）。
 *
 * @param {number} talent 天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 学习速度系数
 */
export function learnFactor(talent, cfg) {
  const t = cfg.talents;
  if (!t.enabled || talent !== TALENT.FAST_LEARNER) return 1;
  return 1 + t.effects.fastLearn;
}

/**
 * 负债上限系数（个体负债上限 = 基础上限 × 该系数）。
 * 负债抗性 → 1 + debtLimitBonus；其它/未启用 → 1（中性）。
 *
 * @param {number} talent 天赋编码
 * @param {object} cfg 归一化配置
 * @returns {number} 负债上限系数
 */
export function debtLimitFactor(talent, cfg) {
  const t = cfg.talents;
  if (!t.enabled || talent !== TALENT.DEBT_RESISTANT) return 1;
  return 1 + t.effects.debtLimitBonus;
}

/**
 * 天赋中文展示名；越界编码回退为「无」。
 *
 * @param {number} talent 天赋编码
 * @returns {string} 中文名
 */
export function talentName(talent) {
  const name = TALENT_NAMES[talent];
  return name === undefined ? TALENT_NAMES[0] : name;
}
