/**
 * test/systems.test.js — 模拟核心子系统单元测试（talents / genetics / events / families）
 *
 * 运行：node --test test/systems.test.js
 *
 * 覆盖：
 *  - 确定性：同 seed 同结果（基因、事件、压力场景整体轨迹）；
 *  - 概率归一：策略基因和为 1、每项 ≥ 0.01，风险/阈值在契约范围内；
 *  - 天赋遗传：父母继承 / 突变 / 效果系数 / 关闭开关时的中性值；
 *  - 事件记账不变量：created - destroyed 恒等于本函数造成的总资产变化；
 *  - 调度语义：宏观调控按 startRound + everyRounds 触发，概率型事件每周期掷一次骰子；
 *  - 瘟疫完整周期（激活/感染/资产损伤/抗体/低资产死亡）；
 *  - 资源有限模式下资金池不足时的缩减/跳过；
 *  - 事件模块不扩容、不重建 aliveList、只通过 aliveList 遍历；
 *  - 家族聚合正确性与 20 万个体性能；
 *  - events 在 500 个体 × 200 回合压力测试下无异常且逐回合记账守恒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createConfig, TALENT_NAMES as CONFIG_TALENT_NAMES } from '../src/core/config.js';
import { Rng } from '../src/core/rng.js';
import { AgentStore } from '../src/core/store.js';
import {
  TALENT,
  TALENT_COUNT,
  TALENT_NAMES,
  rollTalent,
  inheritTalent,
  costFactor,
  winBonus,
  birthCostFactor,
  learnFactor,
  debtLimitFactor,
  talentName,
} from '../src/core/talents.js';
import {
  GENE_STRIDE,
  MOVE_ROCK,
  MOVE_SCISSORS,
  MOVE_PAPER,
  randomGenome,
  inheritGenome,
  mutateGenome,
  normalizeGenome,
  pickMove,
  strategyPoint,
} from '../src/core/genetics.js';
import { createEventSystem, tickEvents, triggerManual } from '../src/core/events.js';
import {
  FAMILY_NAMES,
  createFamilySystem,
  familyForFounder,
  familyName,
  aggregateFamilies,
} from '../src/core/families.js';

// ────────────────────────────── 测试工具 ──────────────────────────────

/** 相对误差断言 */
function assertClose(actual, expected, eps, msg) {
  const tol = eps * Math.max(1, Math.abs(expected));
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${msg || ''} 期望 ${expected}，实际 ${actual}（容差 ${tol}）`
  );
}

/** 统计 store 中指定 slot 列表的资产总和（事件记账不变量用） */
function totalAssets(store, list, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += store.assets[list[i]];
  return sum;
}

/**
 * 构造小规模 AgentStore：n 个存活个体，默认资产 1000 / 负债上限 cfg.maxDebt。
 * @param {number} n
 * @param {object} cfg
 * @param {(store:AgentStore, slot:number, i:number)=>void} [init]
 */
function makeStore(n, cfg, init) {
  const store = new AgentStore(Math.max(4, n), cfg);
  for (let i = 0; i < n; i++) {
    const s = store.alloc(0);
    store.assets[s] = 1000;
    store.debtLimit[s] = cfg.maxDebt;
    store.costAffinity[s] = 1;
    store.familyId[s] = i % cfg.families.count;
    store.generation[s] = 0;
    if (init) init(store, s, i);
  }
  store.rebuildAliveList();
  return store;
}

/**
 * 构造 tickEvents 需要的引擎上下文（字段与 CONTRACTS.md §4 一致）。
 * @param {object} cfg
 * @param {Rng} rng
 * @param {AgentStore} store
 * @param {number} round
 */
function makeCtx(cfg, rng, store, round) {
  const aliveCount = store.aliveCount;
  const aliveList = store.aliveList;
  return {
    cfg,
    rng,
    round,
    aliveList,
    aliveCount,
    cost: cfg.roundCost,
    totalWealth: totalAssets(store, aliveList, aliveCount),
    pool: { amount: cfg.resourceLimited.initialPool || 0, created: 0, destroyed: 0 },
  };
}

/**
 * 关闭全部宏观调控的配置 patch，避免 DEFAULT_CONFIG 的默认事件（如默认开启的分红/保底）
 * 干扰只关心某个子系统的测试。
 * @type {object}
 */
const QUIET_MACRO = {
  average: { enabled: false },
  redistribute: { enabled: false },
  disaster: { enabled: false },
  dividend: { enabled: false },
  subsidy: { enabled: false },
};

// ────────────────────────────── 天赋 talents ──────────────────────────────

test('talents: 常量与中文名和 config.js 严格一致', () => {
  assert.equal(TALENT_COUNT, 6);
  assert.equal(TALENT.NONE, 0);
  assert.equal(TALENT.LUCKY, 1);
  assert.equal(TALENT.THRIFTY, 2);
  assert.equal(TALENT.FERTILE, 3);
  assert.equal(TALENT.FAST_LEARNER, 4);
  assert.equal(TALENT.DEBT_RESISTANT, 5);
  assert.equal(TALENT_NAMES.length, 6);
  assert.deepEqual(TALENT_NAMES, CONFIG_TALENT_NAMES);
  for (let i = 0; i < TALENT_COUNT; i++) assert.equal(talentName(i), CONFIG_TALENT_NAMES[i]);
  assert.equal(talentName(99), '无');
  assert.equal(talentName(-1), '无');
});

test('talents: rollTalent 按权重抽签（关闭时恒为 0）', () => {
  const off = createConfig({ talents: { enabled: false } });
  const rngOff = new Rng(7);
  for (let i = 0; i < 500; i++) assert.equal(rollTalent(rngOff, off), TALENT.NONE);

  // 只把权重给节俭者：必然抽到 2
  const onlyThrifty = createConfig({
    talents: { weights: { none: 0, lucky: 0, thrifty: 5, fertile: 0, fastLearner: 0, debtResistant: 0 } },
  });
  const rngOne = new Rng(8);
  for (let i = 0; i < 200; i++) assert.equal(rollTalent(rngOne, onlyThrifty), TALENT.THRIFTY);

  // 权重全 0：退回 NONE
  const zero = createConfig({
    talents: { weights: { none: 0, lucky: 0, thrifty: 0, fertile: 0, fastLearner: 0, debtResistant: 0 } },
  });
  assert.equal(rollTalent(new Rng(9), zero), TALENT.NONE);

  // 默认权重：大批量抽样占比接近 60/8/8/8/8/8（容差宽松）
  const cfg = createConfig({ initialPopulation: 100 });
  const rng = new Rng(2024);
  const counts = [0, 0, 0, 0, 0, 0];
  const draws = 20000;
  for (let i = 0; i < draws; i++) counts[rollTalent(rng, cfg)]++;
  assertClose(counts[0] / draws, 0.6, 0.02, '无天赋占比');
  for (let k = 1; k < 6; k++) assertClose(counts[k] / draws, 0.08, 0.01, `天赋 ${k} 占比`);
});

test('talents: inheritTalent 继承父母 / 突变 / 关闭开关', () => {
  const cfg = createConfig({ initialPopulation: 100, talents: { inheritanceMutation: 0 } });
  const rng = new Rng(11);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = inheritTalent(rng, TALENT.LUCKY, TALENT.FERTILE, cfg);
    assert.ok(t === TALENT.LUCKY || t === TALENT.FERTILE, `非法继承结果 ${t}`);
    seen.add(t);
  }
  assert.equal(seen.size, 2, '两个父母天赋都应出现');

  // 突变率 100% 且只有幸运儿有概率：后代恒为幸运儿
  const mutateAll = createConfig({
    initialPopulation: 100,
    talents: {
      inheritanceMutation: 1,
      weights: { none: 0, lucky: 100, thrifty: 0, fertile: 0, fastLearner: 0, debtResistant: 0 },
    },
  });
  const rngM = new Rng(12);
  for (let i = 0; i < 200; i++) {
    assert.equal(inheritTalent(rngM, TALENT.NONE, TALENT.FERTILE, mutateAll), TALENT.LUCKY);
  }

  // 天赋系统关闭：恒为 NONE
  const off = createConfig({ talents: { enabled: false } });
  const rngOff = new Rng(13);
  for (let i = 0; i < 100; i++) assert.equal(inheritTalent(rngOff, TALENT.LUCKY, TALENT.FERTILE, off), TALENT.NONE);
});

test('talents: 效果系数与中性值 / 关闭时全部中性', () => {
  const cfg = createConfig({ initialPopulation: 100 });
  assertClose(costFactor(TALENT.THRIFTY, cfg), 0.9, 1e-12, '节俭者成本系数');
  for (const t of [0, 1, 3, 4, 5]) assert.equal(costFactor(t, cfg), 1);
  assertClose(winBonus(TALENT.LUCKY, cfg), 0.01, 1e-12, '幸运儿胜率加成');
  for (const t of [0, 2, 3, 4, 5]) assert.equal(winBonus(t, cfg), 0);
  assertClose(birthCostFactor(TALENT.FERTILE, cfg), 0.7, 1e-12, '生育达人生育成本系数');
  assert.equal(birthCostFactor(0, cfg), 1);
  assertClose(learnFactor(TALENT.FAST_LEARNER, cfg), 1.5, 1e-12, '学习天才学习系数');
  assert.equal(learnFactor(0, cfg), 1);
  assertClose(debtLimitFactor(TALENT.DEBT_RESISTANT, cfg), 1.2, 1e-12, '负债抗性负债系数');
  assert.equal(debtLimitFactor(0, cfg), 1);

  // 参数热更新后效果跟随配置
  const custom = createConfig({
    initialPopulation: 100,
    talents: { effects: { luckBonus: 0.05, thriftyCostReduce: 0.25, fertileBirthCostReduce: 0.5 } },
  });
  assertClose(costFactor(TALENT.THRIFTY, custom), 0.75, 1e-12, '自定义节俭系数');
  assertClose(winBonus(TALENT.LUCKY, custom), 0.05, 1e-12, '自定义幸运加成');
  assertClose(birthCostFactor(TALENT.FERTILE, custom), 0.5, 1e-12, '自定义生育系数');

  // 关闭天赋系统：全部中性
  const off = createConfig({ talents: { enabled: false } });
  assert.equal(costFactor(TALENT.THRIFTY, off), 1);
  assert.equal(winBonus(TALENT.LUCKY, off), 0);
  assert.equal(birthCostFactor(TALENT.FERTILE, off), 1);
  assert.equal(learnFactor(TALENT.FAST_LEARNER, off), 1);
  assert.equal(debtLimitFactor(TALENT.DEBT_RESISTANT, off), 1);
});

// ────────────────────────────── 遗传 genetics ──────────────────────────────

test('genetics: randomGenome 合法、范围正确且同 seed 可复现', () => {
  const cfg = createConfig({ initialPopulation: 100 });
  const N = 500;
  const a = new Float32Array(GENE_STRIDE * N);
  const rngA = new Rng(321);
  for (let i = 0; i < N; i++) randomGenome(rngA, cfg, a, i * GENE_STRIDE);

  const b = new Float32Array(GENE_STRIDE * N);
  const rngB = new Rng(321);
  for (let i = 0; i < N; i++) randomGenome(rngB, cfg, b, i * GENE_STRIDE);
  assert.deepEqual(Array.from(a), Array.from(b), '同 seed 应生成完全相同的初始基因');

  const iw = cfg.initialWealth;
  let riskMin = Infinity;
  let riskMax = -Infinity;
  let consMin = Infinity;
  let consMax = -Infinity;
  let aggrMin = Infinity;
  let aggrMax = -Infinity;
  for (let i = 0; i < N; i++) {
    const off = i * GENE_STRIDE;
    const sum = a[off] + a[off + 1] + a[off + 2];
    assertClose(sum, 1, 1e-5, `第 ${i} 个基因策略概率和`);
    assert.ok(a[off] >= 0.0099 && a[off + 1] >= 0.0099 && a[off + 2] >= 0.0099, '每个概率 ≥ 0.01');
    const risk = a[off + 3];
    const cons = a[off + 4];
    const aggr = a[off + 5];
    // 风险偏好 / 阈值初始即随机分布（契约允许范围内）
    assert.ok(risk >= 0.3 && risk <= 2.5, `风险偏好 ${risk} 应在 [0.3, 2.5]`);
    assert.ok(risk >= 0.2 && risk <= 3.0, `风险偏好 ${risk} 应在契约范围 [0.2, 3.0]`);
    assert.ok(cons >= iw * 0.2 && cons <= iw * 1.0, `保守阈值 ${cons} 应在 [0.2, 1.0]×初始资金`);
    assert.ok(cons >= 0 && cons <= iw * 5, '保守阈值应在契约范围 [0, 5×]');
    assert.ok(aggr >= iw * 1.5 && aggr <= iw * 5.0, `激进阈值 ${aggr} 应在 [1.5, 5]×初始资金`);
    assert.ok(aggr >= iw && aggr <= iw * 50, '激进阈值应在契约范围 [1, 50×]');
    if (risk < riskMin) riskMin = risk;
    if (risk > riskMax) riskMax = risk;
    if (cons < consMin) consMin = cons;
    if (cons > consMax) consMax = cons;
    if (aggr < aggrMin) aggrMin = aggr;
    if (aggr > aggrMax) aggrMax = aggr;
  }
  // 初始基因必须有显著个体差异（否则破产淘汰/风险偏好演化不可见）
  assert.ok(riskMax - riskMin > 1.0, `风险偏好应有显著个体差异（min=${riskMin}, max=${riskMax}）`);
  assert.ok(consMax - consMin > iw * 0.3, `保守阈值应有显著个体差异（min=${consMin}, max=${consMax}）`);
  assert.ok(aggrMax - aggrMin > iw * 1.5, `激进阈值应有显著个体差异（min=${aggrMin}, max=${aggrMax}）`);

  // 不同 seed 应不同
  const c = new Float32Array(GENE_STRIDE * N);
  const rngC = new Rng(322);
  for (let i = 0; i < N; i++) randomGenome(rngC, cfg, c, i * GENE_STRIDE);
  assert.notDeepEqual(Array.from(a), Array.from(c), '不同 seed 应产生不同基因');
});

test('genetics: normalizeGenome 修正非法值、钳制范围且对合法基因幂等', () => {
  const cfg = createConfig({ initialPopulation: 100 });
  const bad = new Float32Array([0.5, -1, NaN, 99, -5, 1e12]);
  normalizeGenome(cfg, bad, 0);
  const sum = bad[0] + bad[1] + bad[2];
  assertClose(sum, 1, 1e-5, '修正后策略概率和');
  assert.ok(bad[0] >= 0.0099 && bad[1] >= 0.0099 && bad[2] >= 0.0099, '修正后每个概率 ≥ 0.01');
  assert.equal(bad[3], 3, '风险偏好上限 3.0');
  assert.equal(bad[4], 0, '保守阈值下限 0');
  assert.equal(bad[5], cfg.initialWealth * 50, '激进阈值上限 50×初始资金');

  const nanDefaults = new Float32Array([0.5, 0.3, 0.2, NaN, NaN, NaN]);
  normalizeGenome(cfg, nanDefaults, 0);
  assert.equal(nanDefaults[3], 1, '非法风险偏好回退默认 1.0');
  assert.equal(nanDefaults[4], cfg.initialWealth * 0.5, '非法保守阈值回退默认');
  assert.equal(nanDefaults[5], cfg.initialWealth * 2, '非法激进阈值回退默认');

  const valid = new Float64Array([0.2, 0.3, 0.5, 1.5, 800, 3000]);
  const before = Array.from(valid);
  normalizeGenome(cfg, valid, 0);
  for (let k = 0; k < 6; k++) assertClose(valid[k], before[k], 1e-12, `合法基因第 ${k} 维应保持不变`);

  // 三概率全 0 → 均匀分布
  const zeros = new Float64Array([0, 0, 0, 1, 500, 2000]);
  normalizeGenome(cfg, zeros, 0);
  assertClose(zeros[0], 1 / 3, 1e-6, '全 0 应退化为均匀');
  assertClose(zeros[1], 1 / 3, 1e-6);
  assertClose(zeros[2], 1 / 3, 1e-6);
});

test('genetics: inheritGenome 父母均值 + 少量变异，且同 seed 可复现', () => {
  const cfg = createConfig({ initialPopulation: 100, genetics: { mutationRate: 0 } });
  const pa = new Float32Array([0.1, 0.2, 0.7, 1.0, 500, 2000]);
  const pb = new Float32Array([0.3, 0.3, 0.4, 2.0, 1000, 4000]);

  const child1 = new Float32Array(6);
  inheritGenome(new Rng(55), pa, 0, pb, 0, cfg, child1, 0);
  const child2 = new Float32Array(6);
  inheritGenome(new Rng(55), pa, 0, pb, 0, cfg, child2, 0);
  assert.deepEqual(Array.from(child1), Array.from(child2), '同 seed 后代基因应相同');

  // 策略概率 ≈ 父母均值（含 σ=0.02 高斯扰动）
  assertClose(child1[0], 0.2, 0.08, '子代石头概率');
  assertClose(child1[1], 0.25, 0.08, '子代剪刀概率');
  assertClose(child1[2], 0.55, 0.08, '子代布概率');
  assertClose(child1[3], 1.5, 0.2, '子代风险偏好 = 父母均值');
  assertClose(child1[4], 750, 1e-6, '子代保守阈值 = 父母中间值');
  assertClose(child1[5], 3000, 1e-6, '子代激进阈值 = 父母中间值');
  const sum = child1[0] + child1[1] + child1[2];
  assertClose(sum, 1, 1e-5, '子代策略概率和');

  // 突变率 100%：子代仍然合法（突变只做一次随机扰动）
  const mutCfg = createConfig({ initialPopulation: 100, genetics: { mutationRate: 1 } });
  const child3 = new Float32Array(6);
  inheritGenome(new Rng(56), pa, 0, pb, 0, mutCfg, child3, 0);
  const s3 = child3[0] + child3[1] + child3[2];
  assertClose(s3, 1, 1e-5, '突变后策略概率和');
  assert.ok(child3[3] >= 0.2 && child3[3] <= 3, '突变后风险偏好仍在范围');
  assert.ok(child3[4] >= 0 && child3[4] <= cfg.initialWealth * 5, '突变后保守阈值仍在范围');
  assert.ok(child3[5] >= cfg.initialWealth && child3[5] <= cfg.initialWealth * 50, '突变后激进阈值仍在范围');
});

test('genetics: mutateGenome 按突变率返回布尔且结果合法', () => {
  const cfg0 = createConfig({ initialPopulation: 100, genetics: { mutationRate: 0 } });
  const g = new Float32Array([0.3, 0.3, 0.4, 1, 500, 2000]);
  const rng0 = new Rng(77);
  for (let i = 0; i < 200; i++) assert.equal(mutateGenome(rng0, cfg0, g, 0), false, '突变率 0 不应突变');

  const cfg1 = createConfig({ initialPopulation: 100, genetics: { mutationRate: 1 } });
  const rng1 = new Rng(78);
  const h = new Float32Array([0.3, 0.3, 0.4, 1, 500, 2000]);
  for (let i = 0; i < 200; i++) {
    assert.equal(mutateGenome(rng1, cfg1, h, 0), true, '突变率 1 必须突变');
    assertClose(h[0] + h[1] + h[2], 1, 1e-5, '突变后策略概率和');
    assert.ok(h[0] >= 0.0099 && h[1] >= 0.0099 && h[2] >= 0.0099, '突变后每个概率 ≥ 0.01');
    assert.ok(h[3] >= 0.2 && h[3] <= 3, '突变后风险偏好范围');
  }
});

test('genetics: pickMove 按概率出拳（纯策略与分布）', () => {
  const rng = new Rng(99);
  const gRock = new Float32Array([1, 0, 0, 1, 500, 2000]);
  const gScissors = new Float32Array([0, 1, 0, 1, 500, 2000]);
  const gPaper = new Float32Array([0, 0, 1, 1, 500, 2000]);
  for (let i = 0; i < 100; i++) {
    assert.equal(pickMove(rng, gRock, 0), MOVE_ROCK);
    assert.equal(pickMove(rng, gScissors, 0), MOVE_SCISSORS);
    assert.equal(pickMove(rng, gPaper, 0), MOVE_PAPER);
  }

  const mixed = new Float32Array([0.5, 0.25, 0.25, 1, 500, 2000]);
  const draws = 20000;
  const counts = [0, 0, 0];
  for (let i = 0; i < draws; i++) counts[pickMove(rng, mixed, 0)]++;
  assertClose(counts[MOVE_ROCK] / draws, 0.5, 0.03, '石头占比');
  assertClose(counts[MOVE_SCISSORS] / draws, 0.25, 0.03, '剪刀占比');
  assertClose(counts[MOVE_PAPER] / draws, 0.25, 0.03, '布占比');
});

test('genetics: strategyPoint 三角坐标映射正确', () => {
  const out = new Float64Array(2);
  const g = new Float32Array([0.25, 0.25, 0.5, 1, 500, 2000]);
  strategyPoint(g, 0, out);
  assertClose(out[0], 0.625, 1e-12, 'x = p_布 + 0.5·p_剪');
  assertClose(out[1], 0.25 * 0.8660254037844386, 1e-12, 'y = p_剪·(√3/2)');

  const rockOnly = new Float32Array([1, 0, 0, 1, 500, 2000]);
  strategyPoint(rockOnly, 0, out);
  assertClose(out[0], 0, 1e-12, '纯石头 x');
  assertClose(out[1], 0, 1e-12, '纯石头 y');

  const paperOnly = new Float32Array([0, 0, 1, 1, 500, 2000]);
  strategyPoint(paperOnly, 0, out);
  assertClose(out[0], 1, 1e-12, '纯布 x');
  assertClose(out[1], 0, 1e-12, '纯布 y');

  const scissorsOnly = new Float32Array([0, 1, 0, 1, 500, 2000]);
  strategyPoint(scissorsOnly, 0, out);
  assertClose(out[0], 0.5, 1e-12, '纯剪刀 x');
  assertClose(out[1], 0.8660254037844386, 1e-12, '纯剪刀 y 顶点');
});

// ────────────────────────────── 家族 families ──────────────────────────────

test('families: 姓氏表 ≥64 且互不重复', () => {
  assert.ok(FAMILY_NAMES.length >= 64, `姓氏数量 ${FAMILY_NAMES.length} 应 ≥ 64`);
  assert.equal(new Set(FAMILY_NAMES).size, FAMILY_NAMES.length, '姓氏表不应有重复');
});

test('families: createFamilySystem 命名 / 家族分配', () => {
  const cfg = createConfig({ initialPopulation: 100, families: { count: 8 } });
  const sys = createFamilySystem(cfg);
  assert.equal(sys.count, 8);
  assert.equal(sys.founderNames.length, 8);
  assert.equal(sys.founderNames[0], '赵家');
  assert.equal(sys.founderNames[1], '钱家');
  assert.equal(familyName(sys, 0), '赵家');
  assert.equal(familyName(sys, 7), '王家');
  assert.equal(familyName(sys, 8), '未知家族');
  assert.equal(familyName(sys, -1), '未知家族');

  // 超过姓氏表长度时用「X家N支」区分
  const big = createFamilySystem(createConfig({ initialPopulation: 100, families: { count: 150 } }));
  assert.equal(big.count, 150);
  assert.equal(big.founderNames.length, 150);
  assert.equal(big.founderNames[128], '赵家2支');
  assert.equal(big.founderNames[129], '钱家2支');
  assert.equal(new Set(big.founderNames).size, 150, '150 个家族展示名应互不重复');

  const rng = new Rng(31);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const f = familyForFounder(sys, rng);
    assert.ok(Number.isInteger(f) && f >= 0 && f < 8, `非法家族 ID ${f}`);
    seen.add(f);
  }
  assert.ok(seen.size > 1, '创始家族分配应随机分散');
});

test('families: aggregateFamilies 聚合与 TopN 排序正确', () => {
  const cfg = createConfig({
    initialPopulation: 100,
    families: { count: 4 },
    performance: { topFamilies: 3 },
  });
  const sys = createFamilySystem(cfg);
  const store = new AgentStore(16, cfg);
  /** @type {Array<{f:number,a:number,g:number,n:number}>} */
  const rows = [
    { f: 0, a: 1000, g: 1, n: 1 },
    { f: 0, a: 500, g: 2, n: 2 },
    { f: 0, a: 500, g: 5, n: 3 },
    { f: 1, a: 5000, g: 8, n: 4 },
    { f: 1, a: 4000, g: 9, n: 5 },
    { f: 2, a: 300, g: 2, n: 6 },
  ];
  for (const r of rows) {
    const s = store.alloc(0);
    store.assets[s] = r.a;
    store.familyId[s] = r.f;
    store.generation[s] = r.g;
    store.id[s] = r.n;
  }
  store.rebuildAliveList();
  const res = aggregateFamilies(store, sys, store.aliveList, store.aliveCount, cfg);

  assert.equal(res.familyCount, 4, '家族总数');
  assert.equal(res.totalMembers, 6, '存活成员总数');
  assert.equal(res.topWealth.length, 3);
  assert.equal(res.topSize.length, 3);
  assert.equal(res.topGeneration.length, 3);

  // 财富榜：f1(9000) > f0(2000) > f2(300)
  assert.deepEqual(res.topWealth.map((x) => x.id), [1, 0, 2]);
  assert.equal(res.topWealth[0].wealth, 9000);
  assert.equal(res.topWealth[0].members, 2);
  assertClose(res.topWealth[0].avgWealth, 4500, 1e-12, 'f1 平均资产');
  assert.equal(res.topWealth[0].generation, 9);
  assert.equal(res.topWealth[1].wealth, 2000);
  assert.equal(res.topWealth[1].members, 3);
  assertClose(res.topWealth[1].avgWealth, 2000 / 3, 1e-12, 'f0 平均资产');
  assert.equal(res.topWealth[1].generation, 5);
  assert.equal(res.topWealth[0].name, '钱家');

  // 规模榜：f0(3) > f1(2) > f2(1)
  assert.deepEqual(res.topSize.map((x) => x.id), [0, 1, 2]);
  assert.deepEqual(res.topSize.map((x) => x.members), [3, 2, 1]);

  // 代数榜：f1(9) > f0(5) > f2(2)
  assert.deepEqual(res.topGeneration.map((x) => x.id), [1, 0, 2]);
  assert.deepEqual(res.topGeneration.map((x) => x.generation), [9, 5, 2]);

  // topFamilies 热更新：限制为 2
  const cfg2 = createConfig({
    initialPopulation: 100,
    families: { count: 4 },
    performance: { topFamilies: 2 },
  });
  const res2 = aggregateFamilies(store, sys, store.aliveList, store.aliveCount, cfg2);
  assert.equal(res2.topWealth.length, 2);
  assert.equal(res2.topSize.length, 2);
  assert.equal(res2.topGeneration.length, 2);

  // 空列表（0 存活）不应异常
  const empty = aggregateFamilies(store, sys, store.aliveList, 0, cfg);
  assert.deepEqual(empty.topWealth, []);
  assert.equal(empty.totalMembers, 0);
});

test('families: aggregateFamilies 20 万个体耗时 < 20ms 目标（断言宽松阈值）', () => {
  const cfg = createConfig({
    initialPopulation: 1000,
    families: { count: 512 },
    performance: { topFamilies: 20 },
  });
  const sys = createFamilySystem(cfg);
  const n = 200000;
  const store = new AgentStore(n, cfg);
  store.count = n;
  const rng = new Rng(4242);
  for (let s = 0; s < n; s++) {
    store.id[s] = s + 1;
    store.alive[s] = 1;
    store.assets[s] = rng.range(-500, 50000);
    store.familyId[s] = rng.int(cfg.families.count);
    store.generation[s] = rng.int(30);
  }
  store.rebuildAliveList();

  // 预热一次（JIT）
  aggregateFamilies(store, sys, store.aliveList, store.aliveCount, cfg);

  const times = [];
  let res = null;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    res = aggregateFamilies(store, sys, store.aliveList, store.aliveCount, cfg);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const best = times[0];
  const median = times[1];
  // 目标 < 20ms；这里断言一个宽松阈值（慢机器/CI 也能过）
  assert.ok(best < 50, `aggregateFamilies 20 万个体最优耗时 ${best.toFixed(2)}ms 应 < 50ms`);
  assert.equal(res.totalMembers, n);
  assert.equal(res.familyCount, 512);
  assert.equal(res.topWealth.length, 20);
  for (let i = 1; i < res.topWealth.length; i++) {
    assert.ok(res.topWealth[i - 1].wealth >= res.topWealth[i].wealth, 'topWealth 应按财富降序');
  }
  console.log(
    `[perf] families.aggregateFamilies 20 万个体：最优 ${best.toFixed(2)}ms / 中位 ${median.toFixed(2)}ms`
  );
});

// ────────────────────────────── 事件 events ──────────────────────────────

test('events: createEventSystem 状态结构与契约字段', () => {
  const cfg = createConfig({ initialPopulation: 100 });
  const state = createEventSystem(cfg);
  assert.ok(state.plague && typeof state.plague === 'object');
  assert.equal(state.plague.active, false);
  assert.equal(state.plague.roundsLeft, 0);
  for (const k of ['average', 'redistribute', 'disaster', 'dividend', 'subsidy', 'plague']) {
    assert.ok(Number.isFinite(state.lastFire[k]), `lastFire.${k} 应为数字`);
  }
  assert.equal(state.counters.created, 0);
  assert.equal(state.counters.destroyed, 0);
  assert.equal(state.counters.deaths, 0);
  assert.equal(state.samples.length, 20000, '分位数采样缓冲长度应为 20000');
});

test('events: disaster 核销资产且 created-destroyed 与总资产变化一致', () => {
  const cfg = createConfig({
    initialPopulation: 200,
    macro: { disaster: { enabled: true, affectedPct: 100, shrinkPct: 30, probability: 1 } },
  });
  const store = makeStore(200, cfg);
  const rng = new Rng(501);
  const ctx = makeCtx(cfg, rng, store, 7);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);

  const report = triggerManual(store, state, ctx, 'disaster');
  const after = totalAssets(store, store.aliveList, store.aliveCount);

  assert.equal(report.deaths, 0);
  assert.equal(report.created, 0);
  assertClose(report.destroyed, 60000, 1e-9, '灾难核销总额');
  assertClose(after - before, report.created - report.destroyed, 1e-9, '资产变化 = created - destroyed');
  assertClose(store.assets[0], 700, 1e-9, '灾难后单个资产');
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].type, 'macro.disaster');
  assert.equal(report.events[0].round, 7);
  assertClose(report.events[0].delta, -60000, 1e-9, '事件 delta');
  assertClose(ctx.pool.destroyed, 60000, 1e-9, '资金池累计核销');
  assert.equal(state.counters.destroyed, 60000);
});

test('events: dividend 创造资产且 created-destroyed 与总资产变化一致', () => {
  const cfg = createConfig({
    initialPopulation: 200,
    macro: { dividend: { enabled: true, affectedPct: 100, amount: 50, probability: 1 } },
  });
  const store = makeStore(200, cfg);
  const rng = new Rng(502);
  const ctx = makeCtx(cfg, rng, store, 9);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const report = triggerManual(store, state, ctx, 'dividend');
  const after = totalAssets(store, store.aliveList, store.aliveCount);

  assert.equal(report.destroyed, 0);
  assertClose(report.created, 10000, 1e-9, '分红投放总额');
  assertClose(after - before, report.created - report.destroyed, 1e-9, '资产变化 = created - destroyed');
  assertClose(store.assets[0], 1050, 1e-9, '分红后单个资产');
  assert.equal(report.events[0].type, 'macro.dividend');
  assertClose(ctx.pool.created, 10000, 1e-9, '资金池累计创造');
});

test('events: dividend 按比例不放回抽样（命中人数精确、每人至多一次、跳过墓碑）', () => {
  const cfg = createConfig({
    initialPopulation: 1000,
    macro: { dividend: { enabled: true, affectedPct: 10, amount: 7, probability: 1 } },
  });
  // n=1000, p=10% → k=100 命中者（命中人数精确 = round(n×p)）
  const store = makeStore(1000, cfg);
  const ctx = makeCtx(cfg, new Rng(605), store, 1);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const rep = triggerManual(store, createEventSystem(cfg), ctx, 'dividend');
  let winners = 0;
  for (let i = 0; i < 1000; i++) {
    if (store.assets[i] > 1000) {
      winners++;
      assertClose(store.assets[i], 1007, 1e-9, '每人至多命中一次（金额只加一次）');
    }
  }
  assert.equal(winners, 100, '命中人数应精确等于 round(n×affectedPct/100)');
  assertClose(rep.created, 100 * 7, 1e-9, 'created = k × amount');
  assertClose(totalAssets(store, store.aliveList, store.aliveCount) - before, rep.created, 1e-9, '记账守恒');

  // 同 seed 可复现：同样输入应命中同一批个体
  const storeB = makeStore(1000, cfg);
  triggerManual(storeB, createEventSystem(cfg), makeCtx(cfg, new Rng(605), storeB, 1), 'dividend');
  assert.deepEqual(
    Array.from(storeB.assets.subarray(0, 1000)),
    Array.from(store.assets.subarray(0, 1000)),
    '同 seed 的抽样结果应完全一致'
  );

  // 墓碑跳过并继续补抽：把 aliveList 前 50 个位置对应的 slot 标记为死亡（模拟引擎尚未重建表）
  const storeC = makeStore(1000, cfg);
  for (let i = 0; i < 50; i++) storeC.alive[storeC.aliveList[i]] = 0;
  const repC = triggerManual(storeC, createEventSystem(cfg), makeCtx(cfg, new Rng(606), storeC, 1), 'dividend');
  for (let i = 0; i < 50; i++) assert.equal(storeC.assets[i], 1000, '墓碑不应获得分红');
  let winnersC = 0;
  for (let i = 50; i < 1000; i++) if (storeC.assets[i] > 1000) winnersC++;
  assert.equal(winnersC, 100, '跳过墓碑后应继续补抽满 k 人');
  assertClose(repC.created, 100 * 7, 1e-9, '墓碑场景 created 仍为 k×amount');

  // affectedPct = 0：不触发、不产生事件
  const cfgZero = createConfig({
    initialPopulation: 100,
    macro: { dividend: { enabled: true, affectedPct: 0, amount: 7, probability: 1 } },
  });
  const storeD = makeStore(100, cfgZero);
  const repD = triggerManual(storeD, createEventSystem(cfgZero), makeCtx(cfgZero, new Rng(607), storeD, 1), 'dividend');
  assert.equal(repD.created, 0);
  assert.equal(repD.events.length, 0);
});

test('events: dividend 大样本路径（n>65536）几何间隔抽样，命中人数仍为精确 k', () => {
  const cfg = createConfig({
    initialPopulation: 200000,
    macro: { dividend: { enabled: true, affectedPct: 10, amount: 7, probability: 1 } },
  });
  const n = 100000; // > SMALL_SAMPLING_MAX(65536)，走大样本几何间隔抽样路径
  const store = makeStore(n, cfg); // 每人资产 1000
  const ctx = makeCtx(cfg, new Rng(611), store, 1);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const rep = triggerManual(store, createEventSystem(cfg), ctx, 'dividend');
  const k = Math.round((n * 10) / 100);
  let winners = 0;
  for (let i = 0; i < n; i++) {
    if (store.assets[i] !== 1000) {
      winners++;
      assertClose(store.assets[i], 1007, 1e-9, '每人至多命中一次');
    }
  }
  assert.equal(winners, k, '大样本路径命中人数也应为精确 k');
  assertClose(rep.created, k * 7, 1e-9, 'created = k × amount');
  assertClose(
    totalAssets(store, store.aliveList, store.aliveCount) - before,
    rep.created - rep.destroyed,
    1e-9,
    '大样本路径记账守恒'
  );

  // 同 seed 可复现（几何间隔抽样只消耗 ctx.rng）
  const storeB = makeStore(n, cfg);
  triggerManual(storeB, createEventSystem(cfg), makeCtx(cfg, new Rng(611), storeB, 1), 'dividend');
  assert.deepEqual(
    Array.from(storeB.assets.subarray(0, n)),
    Array.from(store.assets.subarray(0, n)),
    '同 seed 的大样本抽样结果应完全一致'
  );
});

test('events: average 均衡调控总量守恒（先收池再均分）', () => {
  const cfg = createConfig({ initialPopulation: 100, macro: { average: { takePct: 50 } } });
  const store = makeStore(4, cfg, (st, s, i) => {
    st.assets[s] = [100, 300, 500, 700][i];
  });
  const rng = new Rng(503);
  const ctx = makeCtx(cfg, rng, store, 11);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const report = triggerManual(store, state, ctx, 'average');
  const after = totalAssets(store, store.aliveList, store.aliveCount);

  // 收 50% 正资产：池子 50+150+250+350=800 → 每人均分 200
  assert.deepEqual([0, 1, 2, 3].map((i) => store.assets[i]), [250, 350, 450, 550]);
  assertClose(after, before, 1e-9, '均衡调控应总量守恒');
  assert.equal(report.created, 0);
  assert.equal(report.destroyed, 0);
  assert.equal(report.events[0].type, 'macro.average');
  assert.equal(report.events[0].delta, 0);
});

test('events: redistribute 向最富征收并均分给最穷（总量守恒）', () => {
  const cfg = createConfig({
    initialPopulation: 100,
    macro: { redistribute: { enabled: true, topPct: 10, bottomPct: 20, takePct: 30 } },
  });
  const store = makeStore(10, cfg, (st, s, i) => {
    st.assets[s] = (i + 1) * 100; // 100,200,...,1000
  });
  const rng = new Rng(504);
  const ctx = makeCtx(cfg, rng, store, 12);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const report = triggerManual(store, state, ctx, 'redistribute');
  const after = totalAssets(store, store.aliveList, store.aliveCount);

  // 小样本时全量排序：qTop=p90=900，qBottom=p20=200
  // 只向 1000 征收 30%=300，均分给 100/200 各 150
  assertClose(store.assets[0], 250, 1e-9, '最穷个体 +150');
  assertClose(store.assets[1], 350, 1e-9, '次穷个体 +150');
  assertClose(store.assets[9], 700, 1e-9, '最富个体 -300');
  assertClose(store.assets[2], 300, 1e-9, '中位个体不受影响');
  assertClose(after, before, 1e-9, '再分配应总量守恒');
  assert.equal(report.created, 0);
  assert.equal(report.destroyed, 0);
  assert.equal(report.events[0].type, 'macro.redistribute');
});

test('events: subsidy 保底补助只发给最穷的 count 人', () => {
  const cfg = createConfig({
    initialPopulation: 100,
    macro: { subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 5, amount: 10, countPct: 0 } },
  });
  const store = makeStore(20, cfg, (st, s, i) => {
    st.assets[s] = (i + 1) * 100; // 100..2000
  });
  const rng = new Rng(505);
  const ctx = makeCtx(cfg, rng, store, 1);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const report = triggerManual(store, state, ctx, 'subsidy');
  const after = totalAssets(store, store.aliveList, store.aliveCount);

  // 最穷 5 人（100..500）各 +10
  for (let i = 0; i < 5; i++) assertClose(store.assets[i], (i + 1) * 100 + 10, 1e-9, `第 ${i} 个应获补助`);
  for (let i = 5; i < 20; i++) assertClose(store.assets[i], (i + 1) * 100, 1e-9, `第 ${i} 个不应获补助`);
  assertClose(after - before, report.created - report.destroyed, 1e-9, '资产变化 = created - destroyed');
  assertClose(report.created, 50, 1e-9, '补助投放总额');
  assert.equal(report.destroyed, 0);
  assert.equal(report.events[0].type, 'macro.subsidy');
});

test('events: subsidy countPct 按人口比例取人数（10000 人 × 0.2% = 20 人）', () => {
  const cfg = createConfig({
    initialPopulation: 10000,
    // count=2000 是绝对口径；countPct=0.2 时按人口比例覆盖，应忽略 2000、只发 10000×0.2%=20 人
    macro: { subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 2000, countPct: 0.2, amount: 10 } },
  });
  const n = 10000;
  const store = makeStore(n, cfg); // 每人资产 1000
  const rng = new Rng(608);
  const ctx = makeCtx(cfg, rng, store, 1);
  const state = createEventSystem(cfg);
  const before = totalAssets(store, store.aliveList, store.aliveCount);
  const report = triggerManual(store, state, ctx, 'subsidy');

  let winners = 0;
  for (let i = 0; i < n; i++) {
    if (store.assets[i] !== 1000) {
      winners++;
      assertClose(store.assets[i], 1010, 1e-9, '命中者每人 +10');
    }
  }
  assert.equal(winners, 20, 'countPct=0.2 在 10000 人口下应恰好发 20 人');
  assertClose(report.created, 20 * 10, 1e-9, 'created = 20 × amount');
  assertClose(
    totalAssets(store, store.aliveList, store.aliveCount) - before,
    report.created - report.destroyed,
    1e-9,
    '按比例保底的记账守恒'
  );
  assert.ok(report.events[0].detail.includes('20'), '事件文案应包含最终人数 20');

  // 覆盖人数公式抽查：1M→2000、200k→400、50k→100
  const expectCount = (pop) => Math.max(1, Math.min(pop, Math.round((pop * 0.2) / 100)));
  assert.equal(expectCount(1000000), 2000);
  assert.equal(expectCount(200000), 400);
  assert.equal(expectCount(50000), 100);
});

test('events: 资源有限模式资金池不足时缩减（保底）或跳过（分红）', () => {
  // ── 保底：池子 20 元，需要发 5×10=50 → 每人缩减为 4 元
  const cfgSub = createConfig({
    initialPopulation: 100,
    macro: { subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 5, amount: 10, countPct: 0 } },
    resourceLimited: { enabled: true, welfareFromPool: true, taxToPool: true, initialPool: 20 },
  });
  const storeSub = makeStore(20, cfgSub, (st, s, i) => {
    st.assets[s] = (i + 1) * 100;
  });
  const ctxSub = makeCtx(cfgSub, new Rng(506), storeSub, 1);
  ctxSub.pool.amount = 20;
  const stateSub = createEventSystem(cfgSub);
  const beforeSub = totalAssets(storeSub, storeSub.aliveList, storeSub.aliveCount);
  const repSub = triggerManual(storeSub, stateSub, ctxSub, 'subsidy');
  const afterSub = totalAssets(storeSub, storeSub.aliveList, storeSub.aliveCount);
  assertClose(repSub.created, 20, 1e-9, '池子不足时应只投放池内资金');
  assertClose(ctxSub.pool.amount, 0, 1e-9, '资金池应被抽空');
  assertClose(afterSub - beforeSub, repSub.created - repSub.destroyed, 1e-9, '资产变化 = created - destroyed');
  for (let i = 0; i < 5; i++) assertClose(storeSub.assets[i], (i + 1) * 100 + 4, 1e-9, '缩减后的补助额');

  // ── 分红：池子只有 100，amount=50，10 人中只能发 2 人
  const cfgDiv = createConfig({
    initialPopulation: 100,
    macro: { dividend: { enabled: true, affectedPct: 100, amount: 50, probability: 1 } },
    resourceLimited: { enabled: true, welfareFromPool: true, taxToPool: true, initialPool: 100 },
  });
  const storeDiv = makeStore(10, cfgDiv, (st, s) => {
    st.assets[s] = 1000;
  });
  const ctxDiv = makeCtx(cfgDiv, new Rng(507), storeDiv, 2);
  ctxDiv.pool.amount = 100;
  const stateDiv = createEventSystem(cfgDiv);
  const repDiv = triggerManual(storeDiv, stateDiv, ctxDiv, 'dividend');
  assertClose(repDiv.created, 100, 1e-9, '池子只够发 2 份分红');
  assertClose(ctxDiv.pool.amount, 0, 1e-9, '资金池应被抽空');
  let richCount = 0;
  for (let i = 0; i < 10; i++) if (storeDiv.assets[i] > 1000) richCount++;
  assert.equal(richCount, 2, '应只有 2 人拿到分红');

  // ── 池子为空：整件事跳过，不产生事件、不改资产
  const storeEmpty = makeStore(10, cfgDiv, (st, s) => {
    st.assets[s] = 1000;
  });
  const ctxEmpty = makeCtx(cfgDiv, new Rng(508), storeEmpty, 3);
  ctxEmpty.pool.amount = 0;
  const stateEmpty = createEventSystem(cfgDiv);
  const repEmpty = triggerManual(storeEmpty, stateEmpty, ctxEmpty, 'dividend');
  assert.equal(repEmpty.created, 0);
  assert.equal(repEmpty.events.length, 0);
  for (let i = 0; i < 10; i++) assert.equal(storeEmpty.assets[i], 1000);
});

test('events: 分红/保底的名义金额按通胀指数化（随 ctx.cost 缩放）', () => {
  // ── 分红：成本 = 2×基础成本 → 名义金额翻倍 ──
  const cfgDiv = createConfig({
    initialPopulation: 100,
    macro: { dividend: { enabled: true, affectedPct: 100, amount: 50, probability: 1 } },
  });
  const storeDiv = makeStore(10, cfgDiv, (st, s) => {
    st.assets[s] = 1000;
  });
  const ctxDiv = makeCtx(cfgDiv, new Rng(601), storeDiv, 1);
  ctxDiv.cost = cfgDiv.roundCost * 2;
  const repDiv = triggerManual(storeDiv, createEventSystem(cfgDiv), ctxDiv, 'dividend');
  assertClose(repDiv.created, 10 * 50 * 2, 1e-9, '成本翻倍时分红名义金额应同步翻倍');
  for (let i = 0; i < 10; i++) assertClose(storeDiv.assets[i], 1100, 1e-9, '每人获得 100（=50×2）');
  assert.ok(repDiv.events[0].detail.includes('100'), '事件文案应使用缩放后的金额');

  // ctx.cost 无效/为 0 时回退到基础成本（scale = 1）
  const storeDiv2 = makeStore(10, cfgDiv, (st, s) => {
    st.assets[s] = 1000;
  });
  const ctxDiv2 = makeCtx(cfgDiv, new Rng(602), storeDiv2, 1);
  ctxDiv2.cost = 0;
  const repDiv2 = triggerManual(storeDiv2, createEventSystem(cfgDiv), ctxDiv2, 'dividend');
  assertClose(repDiv2.created, 10 * 50, 1e-9, 'ctx.cost 无效时 scale 回退为 1');

  // ── 保底：成本 = 1.5×基础成本 → 每人 10×1.5 = 15 ──
  const cfgSub = createConfig({
    initialPopulation: 100,
    macro: { subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 5, amount: 10, countPct: 0 } },
  });
  const storeSub = makeStore(20, cfgSub, (st, s, i) => {
    st.assets[s] = (i + 1) * 100;
  });
  const ctxSub = makeCtx(cfgSub, new Rng(603), storeSub, 1);
  ctxSub.cost = cfgSub.roundCost * 1.5;
  const repSub = triggerManual(storeSub, createEventSystem(cfgSub), ctxSub, 'subsidy');
  assertClose(repSub.created, 5 * 15, 1e-9, '保底名义金额应随成本缩放');
  for (let i = 0; i < 5; i++) assertClose(storeSub.assets[i], (i + 1) * 100 + 15, 1e-9, `最穷第 ${i} 人应获 15`);
  for (let i = 5; i < 20; i++) assertClose(storeSub.assets[i], (i + 1) * 100, 1e-9, '非补助对象金额不变');
});

test('events: 1500 回合通胀场景——福利金额随成本同步放大且逐回合记账守恒', () => {
  const cfg = createConfig({
    initialPopulation: 200,
    macro: {
      average: { enabled: false },
      redistribute: { enabled: false },
      disaster: { enabled: false },
      dividend: { enabled: true, startRound: 5, everyRounds: 5, probability: 1, affectedPct: 100, amount: 50 },
      subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 200, amount: 5, countPct: 0 },
    },
  });
  const store = makeStore(200, cfg, (st, s) => {
    st.assets[s] = 1000;
  });
  const rng = new Rng(604);
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  const initialTotal = totalAssets(store, store.aliveList, store.aliveCount);
  const ROUNDS = 1500;
  const rate = cfg.inflation.rate; // 0.0002
  let inflation = 1;
  let createdTotal = 0;
  let destroyedTotal = 0;
  let dividendEarly = -1;
  let dividendLate = -1;
  for (let round = 1; round <= ROUNDS; round++) {
    // 与引擎 _updateInflation 同步：inflationFactor = Π(1 + rate)
    inflation *= 1 + rate;
    ctx.round = round;
    ctx.cost = cfg.roundCost * inflation;
    const before = totalAssets(store, store.aliveList, store.aliveCount);
    const report = tickEvents(store, state, ctx);
    const after = totalAssets(store, store.aliveList, store.aliveCount);
    let dividendDelta = 0;
    for (const ev of report.events) {
      if (ev.type === 'macro.dividend') dividendDelta += ev.delta;
    }
    // 保底：count=200 覆盖全体 → 每人 5×scale；分红：每 5 回合全体各得 50×scale
    const scale = inflation; // ctx.cost / roundCost
    const expectedCreated = 200 * 5 * scale + (round % 5 === 0 ? 200 * 50 * scale : 0);
    assertClose(report.created, expectedCreated, 1e-9, `第 ${round} 回合福利益名义金额应按通胀缩放`);
    assertClose(after - before, report.created - report.destroyed, 1e-9, `第 ${round} 回合记账守恒`);
    if (round === 5) dividendEarly = dividendDelta;
    if (round === ROUNDS) dividendLate = dividendDelta;
    createdTotal += report.created;
    destroyedTotal += report.destroyed;
  }
  const finalTotal = totalAssets(store, store.aliveList, store.aliveCount);
  assertClose(finalTotal, initialTotal + createdTotal - destroyedTotal, 1e-6, '1500 回合全局总资产守恒');

  const scale1500 = Math.pow(1 + rate, ROUNDS);
  assertClose(scale1500, 1.3498, 1e-3, '1500 回合累计通胀应≈1.35');
  assertClose(dividendEarly, 200 * 50 * Math.pow(1 + rate, 5), 1e-9, '第 5 回合分红按 scale≈1.001 发放');
  assertClose(dividendLate, 200 * 50 * scale1500, 1e-9, '第 1500 回合分红按 scale≈1.3498 发放');
  assert.ok(dividendLate > dividendEarly * 1.34, '晚期分红名义值应比早期高约 34%');
  console.log(
    `[perf] events 通胀场景 1500 回合：created ${createdTotal.toFixed(0)}，scale(1500)≈${scale1500.toFixed(4)}`
  );
});

test('events: tickEvents 按 startRound + everyRounds 调度（概率事件必中）', () => {
  const cfg = createConfig({
    initialPopulation: 200,
    macro: {
      ...QUIET_MACRO,
      average: { enabled: true, startRound: 10, everyRounds: 10, takePct: 10 },
      disaster: { enabled: true, startRound: 5, everyRounds: 5, probability: 1, affectedPct: 10, shrinkPct: 10 },
    },
  });
  const store = makeStore(200, cfg);
  const rng = new Rng(509);
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  const avgRounds = [];
  const disasterRounds = [];
  for (let round = 1; round <= 30; round++) {
    ctx.round = round;
    ctx.totalWealth = totalAssets(store, store.aliveList, store.aliveCount);
    const report = tickEvents(store, state, ctx);
    for (const ev of report.events) {
      if (ev.type === 'macro.average') avgRounds.push(ev.round);
      if (ev.type === 'macro.disaster') disasterRounds.push(ev.round);
    }
  }
  assert.deepEqual(avgRounds, [10, 20, 30], '均衡调控应在 10/20/30 回合触发');
  assert.deepEqual(disasterRounds, [5, 10, 15, 20, 25, 30], '灾难应在每 5 回合的整点触发');

  // 关闭开关后不再触发
  const cfgOff = createConfig({
    initialPopulation: 200,
    macro: { ...QUIET_MACRO },
  });
  const stateOff = createEventSystem(cfgOff);
  const ctxOff = makeCtx(cfgOff, new Rng(510), store, 1);
  let offCount = 0;
  for (let round = 1; round <= 40; round++) {
    ctxOff.round = round;
    offCount += tickEvents(store, stateOff, ctxOff).events.length;
  }
  assert.equal(offCount, 0, '全部关闭时不应产生任何事件');
});

test('events: 瘟疫完整周期（激活/感染/资产损伤/结束）且逐回合记账守恒', () => {
  const cfg = createConfig({
    initialPopulation: 10,
    plague: {
      enabled: true,
      startRound: 1,
      everyRounds: 5,
      probability: 1,
      infectRate: 1,
      damagePct: 0.1,
      antibodyChance: 0,
      lowWealthExtraDeath: 0,
    },
    macro: { ...QUIET_MACRO },
  });
  const store = makeStore(10, cfg, (st, s) => {
    st.assets[s] = 1000;
  });
  const rng = new Rng(511);
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  /** @type {Array<object>} */
  const reports = [];
  /** @type {boolean[]} 每回合结束后的瘟疫激活状态 */
  const activeFlags = [];
  for (let round = 1; round <= 6; round++) {
    ctx.round = round;
    ctx.aliveCount = store.aliveCount;
    const before = totalAssets(store, store.aliveList, store.aliveCount);
    const report = tickEvents(store, state, ctx);
    const after = totalAssets(store, store.aliveList, store.aliveCount);
    assertClose(
      after - before,
      report.created - report.destroyed,
      1e-9,
      `第 ${round} 回合资产变化应等于 created-destroyed`
    );
    reports.push(report);
    activeFlags.push(state.plague.active);
  }

  // 第 1 回合：激活（尚无感染）
  assert.equal(reports[0].events.length, 1);
  assert.equal(reports[0].events[0].type, 'plague.start');
  assert.equal(reports[0].newInfections, 0);
  assert.deepEqual(activeFlags, [true, true, true, true, true, false], '瘟疫应在第 1 回合激活、第 6 回合结束');

  // 第 2 回合：全部被感染，但本回合不结算损伤
  assert.equal(reports[1].newInfections, 10);
  assert.equal(reports[1].destroyed, 0);
  for (let i = 0; i < 10; i++) assert.equal(store.infected[i], 1, '所有人应被感染');

  // 第 3~6 回合：每回合正资产流失 10%
  assertClose(reports[2].destroyed, 1000, 1e-9, '第 3 回合损伤总额');
  assertClose(reports[3].destroyed, 900, 1e-9, '第 4 回合损伤总额');
  assertClose(reports[4].destroyed, 810, 1e-9, '第 5 回合损伤总额');
  assertClose(reports[5].destroyed, 729, 1e-9, '第 6 回合损伤总额');
  assert.equal(reports[5].events.some((ev) => ev.type === 'plague.end'), true, '第 6 回合应结束瘟疫');
  assert.equal(state.plague.active, false);
  assertClose(store.assets[0], 1000 * 0.9 * 0.9 * 0.9 * 0.9, 1e-9, '最终资产');
});

test('events: 瘟疫抗体使感染者免疫且后续不再损伤', () => {
  const cfg = createConfig({
    initialPopulation: 10,
    plague: {
      enabled: true,
      startRound: 1,
      everyRounds: 5,
      probability: 1,
      infectRate: 1,
      damagePct: 0.1,
      antibodyChance: 1,
      lowWealthExtraDeath: 0,
    },
    macro: { ...QUIET_MACRO },
  });
  const store = makeStore(10, cfg, (st, s) => {
    st.assets[s] = 1000;
  });
  const rng = new Rng(512);
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  let report = null;
  for (let round = 1; round <= 4; round++) {
    ctx.round = round;
    report = tickEvents(store, state, ctx);
  }
  // 第 3 回合：受损后全员产生抗体 → 第 4 回合无损伤
  assert.equal(report.destroyed, 0, '全部免疫后不再损失资产');
  for (let i = 0; i < 10; i++) assert.equal(store.immunity[i], 1, '应全员获得抗体');
  for (let i = 0; i < 10; i++) assert.equal(store.infected[i], 0, '产生抗体后应痊愈');
});

test('events: 瘟疫低资产死亡只标记 alive=0 并写 deadSlots，不 freeSlot、不改资产、不重建 aliveList', () => {
  const cfg = createConfig({
    initialPopulation: 50,
    plague: { enabled: false, lowWealthExtraDeath: 1, damagePct: 0, infectRate: 0, antibodyChance: 0 },
    macro: { ...QUIET_MACRO },
  });
  const store = makeStore(50, cfg, (st, s) => {
    st.assets[s] = 100; // 100 < 负债上限 500 × 0.5 → 满足死亡条件，且带正资产
    st.debtLimit[s] = 500;
    st.infected[s] = 1; // 预先感染
    st.frozen[s] = 1; // 死亡时应确保解除冻结
  });
  const rng = new Rng(513);
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  triggerManual(store, state, ctx, 'plague'); // 手动激活（忽略 enabled 开关）
  assert.equal(state.plague.active, true);
  assert.deepEqual(triggerManual(store, state, ctx, 'plague').deadSlots, [], '手动触发瘟疫本身不产生死亡');

  const capacityBefore = store.capacity;
  const listCopy = Int32Array.from(store.aliveList.subarray(0, store.aliveCount));
  const aliveCountBefore = store.aliveCount;
  const assetsBefore = Float64Array.from(store.assets.subarray(0, store.count));
  const freeCountBefore = store.freeCount;

  ctx.round = 2;
  const report = tickEvents(store, state, ctx);

  assert.equal(report.deaths, 50, '50 名低资产感染者应全部死亡');
  assert.equal(state.counters.plagueDeaths, 50);
  assert.equal(report.deadSlots.length, 50, 'deadSlots 应汇总全部死亡槽位');
  const seen = new Set();
  for (const s of report.deadSlots) {
    assert.ok(Number.isInteger(s) && s >= 0 && s < store.count, `非法槽位号 ${s}`);
    assert.ok(!seen.has(s), 'deadSlots 不应有重复槽位');
    seen.add(s);
    assert.equal(store.alive[s], 0, '死亡个体 alive 标记应为 0');
    assert.equal(store.frozen[s], 0, '死亡个体 frozen 应清零');
  }
  // 事件模块不回收槽位、不扩容、不重建 aliveList
  assert.equal(store.freeCount, freeCountBefore, '事件模块不得调用 freeSlot（槽位交给引擎统一回收）');
  assert.equal(store.capacity, capacityBefore, '事件模块不得扩容');
  assert.deepEqual(Array.from(store.aliveList.subarray(0, store.aliveCount)), Array.from(listCopy));
  assert.equal(store.aliveCount, aliveCountBefore, '事件模块不得重建 aliveList');
  // 死者资产原样保留（不蒸发、不清零），由引擎 _processDeaths 统一核销/分配
  for (let s = 0; s < store.count; s++) assert.equal(store.assets[s], assetsBefore[s], `槽位 ${s} 的资产不应被事件模块改动`);
  assert.equal(report.destroyed, 0, '死亡本身不产生 destroyed（资产由引擎清算时记账）');
  for (const s of report.deadSlots) assert.equal(store.assets[s], 100, '死者剩余资产应保留给引擎');

  // 模拟引擎统一清算：核销死者资产（正资产记 destroyed/负资产记 created）并回收槽位
  let estate = 0;
  for (const s of report.deadSlots) {
    if (store.assets[s] > 0) estate += store.assets[s];
    store.assets[s] = 0;
    store.freeSlot(s);
  }
  assert.equal(estate, 50 * 100, '引擎可清算的遗产总额 = 死者剩余资产');
  assert.equal(store.freeCount, freeCountBefore + 50, '引擎回收后 freeCount 应增加 50');

  // 引擎随后重建 aliveList
  assert.equal(store.rebuildAliveList(), 0);
  assert.equal(store.aliveCount, 0);
});

test('events: 空存活返回空报告 / 未知手动类型抛错', () => {
  const cfg = createConfig({ initialPopulation: 100 });
  const store = new AgentStore(8, cfg); // 不分配 → aliveCount = 0
  const rng = new Rng(514);
  const ctx = makeCtx(cfg, rng, store, 1);
  const state = createEventSystem(cfg);
  const report = tickEvents(store, state, ctx);
  assert.deepEqual(report.events, []);
  assert.deepEqual(report.deadSlots, [], '无死亡时 deadSlots 应为空数组');
  assert.equal(report.created, 0);
  assert.equal(report.destroyed, 0);
  assert.equal(report.deaths, 0);

  assert.throws(() => triggerManual(store, state, ctx, 'unknown'), /未知宏观调控类型/);
});

// ────────────────────── 事件压力测试：500 个体 × 200 回合 ──────────────────────

/** 构造压力测试配置：所有宏观调控 + 瘟疫全部开启（快节奏） */
function stressConfig() {
  return createConfig({
    initialPopulation: 500,
    families: { count: 32 },
    macro: {
      average: { enabled: true, startRound: 5, everyRounds: 7, takePct: 8 },
      redistribute: { enabled: true, startRound: 10, everyRounds: 13, topPct: 10, takePct: 25, bottomPct: 20 },
      disaster: { enabled: true, startRound: 7, everyRounds: 11, probability: 0.5, affectedPct: 20, shrinkPct: 10 },
      dividend: { enabled: true, startRound: 8, everyRounds: 12, probability: 0.5, affectedPct: 10, amount: 50 },
      subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 25, amount: 5, countPct: 0 },
    },
    plague: {
      enabled: true,
      startRound: 30,
      everyRounds: 20,
      probability: 1,
      infectRate: 0.05,
      damagePct: 0.02,
      antibodyChance: 0.02,
      lowWealthExtraDeath: 0.02,
    },
  });
}

/**
 * 运行压力场景：每回合先做一段随机经济波动，再调 tickEvents，
 * 并断言该回合 created - destroyed 与总资产变化一致。
 * @param {number} seed 随机种子
 * @param {number} [population=500] 存活个体数（任务要求 500~2000）
 * @returns {{digest:string,rounds:number,eventCount:number,created:number,destroyed:number,deaths:number,deadSlotsTotal:number,engineCreated:number,engineDestroyed:number,elapsedMs:number}}
 */
function runStressScenario(seed, population = 500) {
  const cfg = stressConfig();
  const rng = new Rng(seed);
  const store = makeStore(population, cfg, (st, s) => {
    st.assets[s] = rng.range(600, 1400);
  });
  const state = createEventSystem(cfg);
  const ctx = makeCtx(cfg, rng, store, 1);
  const eventLog = [];
  const capacityBefore = store.capacity;
  const initialTotal = totalAssets(store, store.aliveList, store.aliveCount);
  let created = 0;
  let destroyed = 0;
  let deaths = 0;
  let deadSlotsTotal = 0;
  let engineCreated = 0; // 模拟引擎清算死亡槽位时债务豁免（created）
  let engineDestroyed = 0; // 模拟引擎清算死亡槽位时遗产核销（destroyed）
  let driftSum = 0; // 模拟经济活动注入/抽走的总和，用于全局守恒断言
  const rounds = 200;
  const t0 = performance.now();

  for (let round = 1; round <= rounds; round++) {
    store.rebuildAliveList();
    ctx.round = round;
    ctx.aliveCount = store.aliveCount;
    // 模拟引擎的每回合经济活动（随机输赢/成本波动）
    const n = store.aliveCount;
    for (let i = 0; i < n; i++) {
      const delta = rng.range(-30, 30);
      store.assets[store.aliveList[i]] += delta;
      driftSum += delta;
    }

    const before = totalAssets(store, store.aliveList, n);
    ctx.totalWealth = before;
    const report = tickEvents(store, state, ctx);
    const after = totalAssets(store, store.aliveList, n);

    assert.ok(report.events.length <= cfg.performance.eventLogSize, '事件条数不得超过 eventLogSize');
    for (const ev of report.events) {
      assert.equal(ev.round, round, '事件回合号必须等于当前回合');
      assert.equal(typeof ev.type, 'string');
      assert.ok(Number.isFinite(ev.delta), '事件 delta 必须是有限数');
      eventLog.push(ev.type);
    }
    assertClose(
      after - before,
      report.created - report.destroyed,
      1e-6,
      `第 ${round} 回合事件资产记账应守恒`
    );
    created += report.created;
    destroyed += report.destroyed;
    deaths += report.deaths;
    assert.ok(Number.isFinite(report.created) && report.created >= 0);
    assert.ok(Number.isFinite(report.destroyed) && report.destroyed >= 0);
    assert.ok(Number.isInteger(report.deaths) && report.deaths >= 0);

    // ── 死亡槽位（引擎统一清算口径）──
    // 事件模块只标记 alive=0 并把槽位写进 report.deadSlots；资产核销/豁免/槽位回收由引擎负责。
    const dead = report.deadSlots;
    assert.ok(Array.isArray(dead), 'report.deadSlots 应为普通数组');
    assert.equal(dead.length, report.deaths, 'deadSlots 数量应等于 deaths');
    const seenDead = new Set();
    for (let k = 0; k < dead.length; k++) {
      const s = dead[k];
      assert.ok(Number.isInteger(s) && s >= 0 && s < store.count, `deadSlots 槽位号非法：${s}`);
      assert.ok(!seenDead.has(s), '同一回合 deadSlots 不应有重复槽位');
      seenDead.add(s);
      assert.equal(store.alive[s], 0, 'deadSlots 中的槽位应已标记死亡');
      assert.equal(store.frozen[s], 0, '死亡槽位 frozen 应为 0');
      // 模拟引擎 _processDeaths：正资产记 destroyed（遗产核销），负资产记 created（债务豁免）
      const deadAsset = store.assets[s];
      if (deadAsset > 0) engineDestroyed += deadAsset;
      else if (deadAsset < 0) engineCreated += -deadAsset;
      store.assets[s] = 0;
      store.freeSlot(s);
      deadSlotsTotal++;
    }
  }
  const elapsedMs = performance.now() - t0;

  // 事件模块不得扩容、不得破坏 aliveList 结构
  assert.equal(store.capacity, capacityBefore, '事件模块不得扩容');
  assert.equal(store.rebuildAliveList(), store.aliveCount, 'rebuildAliveList 返回值应与 aliveCount 一致');
  const aliveCount = store.aliveCount;
  assert.ok(aliveCount > 0, '200 回合后不应全员灭绝');
  const seenAlive = new Set();
  for (let i = 0; i < aliveCount; i++) {
    const s = store.aliveList[i];
    assert.equal(store.alive[s], 1, 'aliveList 中的槽位必须存活');
    assert.ok(!seenAlive.has(s), 'aliveList 不得有重复槽位');
    seenAlive.add(s);
  }
  let aliveFlags = 0;
  for (let s = 0; s < store.count; s++) if (store.alive[s]) aliveFlags++;
  assert.equal(aliveFlags, aliveCount, 'alive 标记总数应与 aliveCount 一致');

  // ── 全局总资产守恒（含「事件只标记死亡、引擎统一清算」口径）──
  // 初始总资产 + 经济波动 + 事件注入 - 事件蒸发 + 引擎清算注入 - 引擎清算蒸发 === 最终存活总资产
  const finalAliveTotal = totalAssets(store, store.aliveList, store.aliveCount);
  const expectedTotal = initialTotal + driftSum + created - destroyed + engineCreated - engineDestroyed;
  assertClose(finalAliveTotal, expectedTotal, 1e-6, '全局总资产守恒（含死亡槽位引擎清算口径）');
  assert.equal(deadSlotsTotal, deaths, 'deadSlots 累计数量应等于 deaths 累计');
  assert.equal(store.freeCount, deadSlotsTotal, '所有死亡槽位都应被引擎清算回收（freeCount = 累计死亡数）');
  assert.ok(engineDestroyed >= 0 && engineCreated >= 0);
  for (let s = 0; s < store.count; s++) {
    if (store.alive[s] === 0) assert.equal(store.assets[s], 0, '已清算的死亡槽位资产应已清零');
  }

  // 资金池累计记账应与 counters 同步
  assertClose(state.counters.created, ctx.pool.created, 1e-9, 'counters.created 与池子记账一致');
  assertClose(state.counters.destroyed, ctx.pool.destroyed, 1e-9, 'counters.destroyed 与池子记账一致');
  assertClose(state.counters.deaths, deaths, 1e-9, 'counters.deaths 与 report 累计一致');

  // 确认多种事件确实被触发（避免测试空转）
  const types = new Set(eventLog);
  assert.ok(types.has('macro.average'), '应触发均衡调控');
  assert.ok(types.has('macro.redistribute'), '应触发再分配');
  assert.ok(types.has('macro.disaster'), '应触发随机灾难');
  assert.ok(types.has('macro.dividend'), '应触发随机分红');
  assert.ok(types.has('macro.subsidy'), '应触发保底补助');
  assert.ok(types.has('plague.start'), '应触发瘟疫爆发');

  const digest = JSON.stringify({
    assets: Array.from(store.assets.subarray(0, store.count)),
    aliveFlags: Array.from(store.alive.subarray(0, store.count)),
    counters: state.counters,
    eventLog,
    aliveCount,
    created,
    destroyed,
    deaths,
    deadSlotsTotal,
    engineCreated,
    engineDestroyed,
  });
  return {
    digest,
    rounds,
    eventCount: eventLog.length,
    created,
    destroyed,
    deaths,
    deadSlotsTotal,
    engineCreated,
    engineDestroyed,
    elapsedMs,
  };
}

test('events: 500 个体 × 200 回合压力测试——无异常、逐回合记账守恒、同 seed 可复现', () => {
  const a = runStressScenario(20241120);
  const b = runStressScenario(20241120);
  assert.equal(a.digest, b.digest, '同 seed 的压力场景必须完全可复现');
  const c = runStressScenario(987654321);
  assert.notEqual(a.digest, c.digest, '不同 seed 应产生不同轨迹');

  assert.ok(a.elapsedMs < 8000, `200 回合压力测试耗时 ${a.elapsedMs.toFixed(1)}ms 应 < 8s`);
  console.log(
    `[perf] events 压力 500 个体 × 200 回合：${a.elapsedMs.toFixed(1)}ms，` +
      `事件 ${a.eventCount} 条，created ${a.created.toFixed(0)}，destroyed ${a.destroyed.toFixed(0)}，` +
      `deaths ${a.deaths}（deadSlots ${a.deadSlotsTotal}），引擎清算 created ${a.engineCreated.toFixed(0)} / destroyed ${a.engineDestroyed.toFixed(0)}`
  );
});

test('events: 2000 个体 × 200 回合压力测试（上限规模）无异常且记账守恒', () => {
  const r = runStressScenario(424242, 2000);
  assert.ok(r.elapsedMs < 8000, `2000 个体 200 回合耗时 ${r.elapsedMs.toFixed(1)}ms 应 < 8s`);
  assert.ok(r.eventCount > 0, '应有事件触发');
  assert.ok(r.deadSlotsTotal > 0, '2000 个体 200 回合内应出现瘟疫死亡以覆盖 deadSlots 路径');
  console.log(
    `[perf] events 压力 2000 个体 × 200 回合：${r.elapsedMs.toFixed(1)}ms，` +
      `事件 ${r.eventCount} 条，created ${r.created.toFixed(0)}，destroyed ${r.destroyed.toFixed(0)}，` +
      `deaths ${r.deaths}（deadSlots ${r.deadSlotsTotal}）`
  );
});

