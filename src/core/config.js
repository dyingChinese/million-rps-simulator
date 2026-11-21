/**
 * config.js — 全部可配置参数的唯一权威来源（对应《完整规则设计》参数表）
 *
 * 约定：
 *  - 该对象必须是「纯 JSON 可序列化」结构，因为它会被 postMessage 到 worker 线程，
 *    也会原样返回给浏览器 UI。
 *  - `createConfig(patch)` 深合并默认值；`normalizeConfig(cfg)` 做范围钳制与派生字段。
 *  - 参数编号与需求文档一致，便于对照。
 */

export const CONFIG_VERSION = 1;

/** 默认配置（按需求文档默认值；UI 中可切换预设） */
export const DEFAULT_CONFIG = {
  seed: 20241120,

  // ─────────── 基础参数 ───────────
  initialPopulation: 1_000_000, // 参数12 初始人数
  maxPopulation: 1_500_000, // 人口硬上限（性能保护，超出停止繁殖）
  initialWealth: 1000, // 参数1 初始资金
  maxDebt: 500, // 参数2 最大负债（资产 < -maxDebt 破产淘汰）
  roundCost: 10, // 参数3 单次猜拳成本
  betMultiplier: 1.0, // 参数11 赌注基础倍率
  maxAge: 1000, // 参数13 个体最大年龄（回合）

  // ─────────── 遗传 / 繁殖（参数6~10）───────────
  genetics: {
    reproWealthThreshold: 2000, // 参数6 繁殖资产门槛
    minReproAge: 216, // 参数7 最小繁殖年龄（按 maxAge 1000 回合≈83 年、1 回合≈1 月折算 = 18 岁成年）
    maxReproCount: 5, // 参数8 最大繁殖次数
    baseBirthCost: 500, // 参数9 基础生育成本（约为初始资金的一半，符合“生养一个孩子”的一次性支出量级）
    birthCostRatio: 0.05, // 生育成本 += 父母资产 × 该比例（规则只写“一定比例”，取 5%）
    mutationRate: 0.05, // 参数10 基因突变率
    reproChancePerRound: 0.02, // 符合条件者每回合尝试繁殖的概率（防止人口爆炸；1 回合≈1 月 → 约 2%/月）
    initialAsset: 0, // 新生个体初始资产
    debtLimitMutation: 0.1, // 后代负债上限 = 父母均值 × (1 ± 该系数)
  },

  // ─────────── 匹配机制 ───────────
  matching: {
    mode: 'random', // random | wealth | strategy
    wealthPct: 25, // 资产相近匹配：±25% 视为同一档
    strategyBins: 16, // 策略相近匹配：按策略坐标分桶数
  },

  // ─────────── 结束条件（参数4）───────────
  endCondition: {
    mode: 'C', // A: 首个资产达阈值 B: N% 个体资产超阈值 C: 固定回合 D: 存活低于 X% E: 连续 M 回合总资产无增长
    threshold: 100_000, // A / B 的资产阈值
    pct: 10, // B / D 的百分比
    rounds: 2000, // C 的回合数（同时也是 D/E 的安全上限）
    noGrowthRounds: 200, // E 的连续回合数
    maxRounds: 100_000, // 全局安全上限
  },

  // ─────────── 宏观调控（参数5）───────────
  // 经济平衡说明：按规则字面实现（成本是系统抽水、赌注只在个体间转移），系统天然通缩，
  // 仅靠对局无法让任何人资产超过初始值（胜方净收益 = 赌注 - 成本 ≈ 0）。
  // 因此默认开启「随机红利」作为货币投放：每 2 回合 50% 概率、30% 个体各获得
  // 140 元（名义值随通胀指数化），期望收入 ≈ 10.5/人/回合 ≈ 覆盖对局成本，
  // 使人口与经济长期稳定、繁殖门槛可达、财富重尾分布成立；关闭分红即得到纯通缩经济。
  // 另：自然死亡遗产默认由随机存活者继承（不蒸发），详见 docs/RULES.md。
  macro: {
    // 模式1 均富：每 60 回合（按 1 回合≈1 月 ≈ 5 年）对全体正资产抽 2% 再均分，
    // 约等于 0.4%/年的“财富税式”温和再分配（原 300 回合抽 5% 过于激进）。
    average: { enabled: true, startRound: 60, everyRounds: 60, takePct: 2 },
    redistribute: {
      enabled: false,
      startRound: 200,
      everyRounds: 200,
      topPct: 10,
      takePct: 15,
      bottomPct: 20,
    },
    // 模式3 随机灾难：每 300 回合（约 25 年）20% 概率发生，波及 5% 个体、资产缩水 10%，
    // 更接近现实中的“黑天鹅/自然灾害”，而不是周期性大范围洗劫。
    disaster: {
      enabled: false,
      startRound: 300,
      everyRounds: 300,
      probability: 0.2,
      affectedPct: 5,
      shrinkPct: 10,
    },
    dividend: {
      enabled: true,
      startRound: 5,
      everyRounds: 2,
      probability: 0.5,
      affectedPct: 30,
      amount: 140,
    },
    subsidy: {
      enabled: true,
      startRound: 1,
      everyRounds: 1,
      count: 2000, // 绝对人数（countPct<=0 时使用）
      countPct: 0.5, // 按存活人口比例抽取（%），>0 时优先于 count（保证不同人口规模下行为一致）
      amount: 20, // 低保金额（约初始资金的 2%/月，覆盖最穷 0.5%）
    }, // 保底机制
  },

  // ─────────── 通胀（参数14）───────────
  inflation: {
    rate: 0.0002, // 每回合成本通胀率
    dynamic: false, // 随总资产规模动态调整
    dynamicTarget: 1e10,
    maxFactor: 1000,
  },

  // ─────────── 借贷与利息（参数15）───────────
  interest: {
    // 1%/回合（按 1 回合≈1 月 ≈ 12.7%/年，属民间借贷/信用卡区间；高利贷阈值为其 2 倍）
    rate: 0.01,

    usuryThreshold: 0.5, // 负债超过 maxDebt×该比例后进入高利贷
    usuryMultiplier: 2.0, // 高利贷利率 ≈ 2%/回合 ≈ 26.8%/年
  },

  // ─────────── 天赋系统 ───────────
  talents: {
    enabled: true,
    inheritanceMutation: 0.03, // 后代产生新天赋突变的概率
    weights: {
      none: 60,
      lucky: 8,
      thrifty: 8,
      fertile: 8,
      fastLearner: 8,
      debtResistant: 8,
    },
    effects: {
      luckBonus: 0.01, // 幸运儿：胜率 +1%
      thriftyCostReduce: 0.1, // 节俭者：成本 -10%
      fertileBirthCostReduce: 0.3, // 生育达人：生育成本 -30%
      fastLearn: 0.5, // 学习能力强：策略调整速度 +50%
      debtLimitBonus: 0.2, // 负债抗性：最大负债 +20%
    },
  },

  // ─────────── 策略进化 ───────────
  learning: {
    enabled: true,
    lossTrigger: 3, // 每累计失败 N 次触发一次微调
    adjustStep: 0.02, // 单次降低权重
    imitateChance: 0.01, // 每回合模仿高资产对手的概率
    imitateThreshold: 1.5, // 对手资产 > 自身 × 该倍数才值得模仿
    imitateBlend: 0.15, // 模仿时向对方策略混合的比例
    reversalStreak: 8, // 连败达到该值后策略反转
    winStreakPenalty: { enabled: true, threshold: 8, chance: 0.08 }, // 连胜惩罚：达到阈值后每局有概率把结果翻转为负
  },

  // ─────────── 阶层划分 ───────────
  classes: {
    enabled: true,
    lowFactor: 0.5, // 底层：< 初始资金 × 0.5
    midFactor: 2, // 中层：[0.5, 2)
    highFactor: 10, // 上层：[2, 10)；顶层：≥10
  },

  // ─────────── 瘟疫模式 ───────────
  plague: {
    enabled: false,
    startRound: 300,
    everyRounds: 200,
    probability: 0.4,
    infectRate: 0.02,
    damagePct: 0.03, // 感染者每回合资产流失比例（对正资产）
    antibodyChance: 0.08,
    heritable: true,
    lowWealthExtraDeath: 0.02,
  },

  // ─────────── 资源有限模式 ───────────
  resourceLimited: {
    enabled: false,
    initialPool: 0,
    taxToPool: true, // 猜拳成本作为税收进入系统资金池
    welfareFromPool: true, // 福利/分红从资金池支取，池空则无法触发
  },

  // ─────────── 公会模式（进阶）───────────
  // 成员每回合向公会金库缴纳少量资产（风险共担资金）；成员濒临破产时金库出资兜底；
  // 金库资产决定公会等级，等级越高成员猜拳成本越低；公会之间会有团体对战（赢家金库获益）。
  guilds: {
    enabled: false, // 默认关闭（属进阶模式，可在参数面板开启）
    count: 32, // 公会数量
    joinChance: 0.5, // 初始个体 / 新生个体加入公会的概率
    recruitChance: 0.002, // 每回合非成员被公会招收的概率（"招收新成员"）
    contributeRate: 0.002, // 每回合成员将正资产的比例缴入金库（0.2%，实测 200k 人口 300 回合金库约占总财富 28%）
    coverRatio: 0.8, // 成员濒临破产时金库最多兜底债务缺口的比例
    expelBelowRatio: 0.9, // 成员资产低于 -负债上限×该比例 时被开除（"开除破产成员"）
    levelUpAssets: 500_000, // 公会金库每达到该值升 1 级（等级越高成员成本折扣越大；金库被兜底/团战消耗时等级可回落）
    maxLevel: 10,
    costDiscountPerLevel: 0.01, // 每级降低成员猜拳成本 1%（上限 maxLevel×该值）
    warChance: 0.02, // 每回合发生公会团体对战的概率
    warChampionCount: 3, // 团体战每公会出战人数
    warStake: 50, // 团体战每名出战者的基础赌注（从金库出）
  },

  // ─────────── 家族谱系 ───────────
  families: {
    enabled: true,
    count: 512, // 创始家族数量（初始人口随机分配家族）
  },

  // ─────────── 平衡性补充 ───────────
  balance: {
    newbieProtectRounds: 10, // 新手保护回合数
    assetSoftCap: { enabled: true, threshold: 100_000, decay: 0.85 }, // 资产上限软限制：超出部分收益递减
    redistribution: { enabled: false, toLastOpponents: 5 }, // 破产清算：剩余正资产分给最近 N 个对手
  },

  // ─────────── 性能 / 采样 / 可视化 ───────────
  performance: {
    snapshotIntervalMs: 90, // 快照最小间隔（毫秒）
    sampleSize: 65_536, // 传给前端的个体采样点数
    gridStrategy: { w: 192, h: 160 }, // 策略空间密度网格
    gridWealth: { w: 256, h: 128 }, // 财富天际线密度网格
    historyRounds: 2000, // 时间序列保留回合数
    topFamilies: 100, // 家族/公会 TopN（需求：资产前 100 家族、人数前 100 家族；前端默认显示前 10）
    eventLogSize: 30,
  },

  // ─────────── 并行计算 ───────────
  // 对局结算按 pair 区间切分到多个 worker 线程（SharedArrayBuffer，无锁）。
  // workers=0 表示自动：最多 4 个（给主线程/UI 留出核心）。
  // 注意：并行模式下属不同机器/不同 worker 数会得到不同随机序列（同机同配置下可复现）。
  parallel: {
    enabled: true,
    workers: 0,
    minPairs: 6000,
  },

  // ─────────── 运行控制 ───────────
  speed: {
    targetRoundsPerSec: 0, // 0 = 全速；>0 时按目标帧率限速
  },
};

/** 预设：不同人口规模 */
export const PRESETS = {
  demo: {
    label: '演示 5 万',
    initialPopulation: 50_000,
    maxPopulation: 150_000,
    families: { count: 256 },
    endCondition: { mode: 'C', rounds: 3000 },
  },
  standard: {
    label: '标准 20 万',
    initialPopulation: 200_000,
    maxPopulation: 500_000,
    families: { count: 512 },
    endCondition: { mode: 'C', rounds: 3000 },
  },
  million: {
    label: '百万 100 万',
    initialPopulation: 1_000_000,
    maxPopulation: 1_500_000,
    families: { count: 512 },
    endCondition: { mode: 'C', rounds: 2000 },
  },
  stress: {
    label: '压力 200 万',
    initialPopulation: 2_000_000,
    maxPopulation: 3_000_000,
    families: { count: 512 },
    endCondition: { mode: 'C', rounds: 2000 },
  },
};

/**
 * 深合并（仅普通对象），数组直接替换。
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const bv = out[key];
    const pv = patch[key];
    if (pv === undefined) continue;
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = mergeConfig(bv, pv);
    } else {
      out[key] = pv;
    }
  }
  return out;
}

/** @param {object} [patch] @returns {object} 完整配置对象 */
export function createConfig(patch) {
  const cfg = mergeConfig(structuredCloneConfig(DEFAULT_CONFIG), patch);
  return normalizeConfig(cfg);
}

function structuredCloneConfig(o) {
  // Node 18+ 支持 structuredClone；这里用 JSON 往返保证无函数/原型
  return JSON.parse(JSON.stringify(o));
}

/** 应用预设（返回 patch，供 createConfig 使用） */
export function presetPatch(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`未知预设: ${name}（可选: ${Object.keys(PRESETS).join(', ')}）`);
  const { label, ...patch } = p;
  return patch;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

/**
 * 范围钳制 + 派生字段。
 * 返回新对象（不修改入参），并挂载只读派生信息 `_derived`。
 * @param {object} input
 * @returns {object}
 */
export function normalizeConfig(input) {
  const cfg = mergeConfig(structuredCloneConfig(DEFAULT_CONFIG), input);
  cfg.seed = Math.floor(num(cfg.seed, 20241120)) >>> 0;
  cfg.initialPopulation = clamp(Math.round(num(cfg.initialPopulation, 1_000_000)), 2, 5_000_000);
  cfg.maxPopulation = clamp(Math.round(num(cfg.maxPopulation, cfg.initialPopulation * 2)), cfg.initialPopulation, 5_000_000);
  cfg.initialWealth = num(cfg.initialWealth, 1000);
  cfg.maxDebt = Math.max(0, num(cfg.maxDebt, 500));
  cfg.roundCost = Math.max(0, num(cfg.roundCost, 10));
  cfg.betMultiplier = clamp(num(cfg.betMultiplier, 1), 0, 20);
  cfg.maxAge = Math.max(1, Math.round(num(cfg.maxAge, 1000)));

  const g = cfg.genetics;
  g.reproWealthThreshold = num(g.reproWealthThreshold, 2000);
  g.minReproAge = Math.max(0, Math.round(num(g.minReproAge, 50)));
  g.maxReproCount = Math.max(0, Math.round(num(g.maxReproCount, 5)));
  g.baseBirthCost = Math.max(0, num(g.baseBirthCost, 500));
  g.birthCostRatio = clamp(num(g.birthCostRatio, 0.1), 0, 1);
  g.mutationRate = clamp(num(g.mutationRate, 0.05), 0, 1);
  g.reproChancePerRound = clamp(num(g.reproChancePerRound, 0.02), 0, 1);
  g.initialAsset = num(g.initialAsset, 0);
  g.debtLimitMutation = clamp(num(g.debtLimitMutation, 0.1), 0, 1);

  cfg.matching.mode = ['random', 'wealth', 'strategy'].includes(cfg.matching.mode) ? cfg.matching.mode : 'random';
  cfg.matching.wealthPct = clamp(num(cfg.matching.wealthPct, 25), 1, 100);
  cfg.matching.strategyBins = clamp(Math.round(num(cfg.matching.strategyBins, 16)), 4, 64);

  const ec = cfg.endCondition;
  ec.mode = ['A', 'B', 'C', 'D', 'E'].includes(ec.mode) ? ec.mode : 'C';
  ec.threshold = num(ec.threshold, 100_000);
  ec.pct = clamp(num(ec.pct, 10), 0.01, 100);
  ec.rounds = Math.max(1, Math.round(num(ec.rounds, 2000)));
  ec.noGrowthRounds = Math.max(1, Math.round(num(ec.noGrowthRounds, 200)));
  ec.maxRounds = Math.max(1, Math.round(num(ec.maxRounds, 100_000)));

  const m = cfg.macro;
  for (const key of ['average', 'redistribute', 'disaster', 'dividend', 'subsidy']) {
    const e = m[key];
    if (!e) continue;
    e.enabled = !!e.enabled;
    e.startRound = Math.max(1, Math.round(num(e.startRound, 1)));
    e.everyRounds = Math.max(1, Math.round(num(e.everyRounds, 100)));
  }
  m.average.takePct = clamp(num(m.average.takePct, 10), 0, 100);
  m.redistribute.topPct = clamp(num(m.redistribute.topPct, 10), 0, 100);
  m.redistribute.takePct = clamp(num(m.redistribute.takePct, 30), 0, 100);
  m.redistribute.bottomPct = clamp(num(m.redistribute.bottomPct, 20), 0, 100);
  m.disaster.probability = clamp(num(m.disaster.probability, 0.35), 0, 1);
  m.disaster.affectedPct = clamp(num(m.disaster.affectedPct, 20), 0, 100);
  m.disaster.shrinkPct = clamp(num(m.disaster.shrinkPct, 30), 0, 100);
  m.dividend.probability = clamp(num(m.dividend.probability, 0.35), 0, 1);
  m.dividend.affectedPct = clamp(num(m.dividend.affectedPct, 10), 0, 100);
  m.dividend.amount = Math.max(0, num(m.dividend.amount, 500));
  m.subsidy.count = Math.max(0, Math.round(num(m.subsidy.count, 2000)));
  m.subsidy.countPct = clamp(num(m.subsidy.countPct, 0.2), 0, 100);
  m.subsidy.amount = Math.max(0, num(m.subsidy.amount, 30));

  cfg.inflation.rate = Math.max(0, num(cfg.inflation.rate, 0.0002));
  cfg.inflation.dynamic = !!cfg.inflation.dynamic;
  cfg.inflation.dynamicTarget = Math.max(1, num(cfg.inflation.dynamicTarget, 1e10));
  cfg.inflation.maxFactor = Math.max(1, num(cfg.inflation.maxFactor, 1000));

  cfg.interest.rate = clamp(num(cfg.interest.rate, 0.01), 0, 1);
  cfg.interest.usuryThreshold = clamp(num(cfg.interest.usuryThreshold, 0.5), 0, 1);
  cfg.interest.usuryMultiplier = clamp(num(cfg.interest.usuryMultiplier, 2), 1, 10);

  cfg.talents.enabled = !!cfg.talents.enabled;
  cfg.talents.inheritanceMutation = clamp(num(cfg.talents.inheritanceMutation, 0.03), 0, 1);
  for (const k of ['lucky', 'thrifty', 'fertile', 'fastLearner', 'debtResistant']) {
    if (typeof cfg.talents.weights[k] !== 'number') cfg.talents.weights[k] = 0;
  }
  if (typeof cfg.talents.weights.none !== 'number') cfg.talents.weights.none = 0;
  const eff = cfg.talents.effects;
  eff.luckBonus = clamp(num(eff.luckBonus, 0.01), 0, 1);
  eff.thriftyCostReduce = clamp(num(eff.thriftyCostReduce, 0.1), 0, 1);
  eff.fertileBirthCostReduce = clamp(num(eff.fertileBirthCostReduce, 0.3), 0, 1);
  eff.fastLearn = clamp(num(eff.fastLearn, 0.5), 0, 10);
  eff.debtLimitBonus = clamp(num(eff.debtLimitBonus, 0.2), 0, 10);

  const l = cfg.learning;
  l.enabled = !!l.enabled;
  l.lossTrigger = Math.max(1, Math.round(num(l.lossTrigger, 3)));
  l.adjustStep = clamp(num(l.adjustStep, 0.02), 0, 0.5);
  l.imitateChance = clamp(num(l.imitateChance, 0.01), 0, 1);
  l.imitateThreshold = Math.max(1, num(l.imitateThreshold, 1.5));
  l.imitateBlend = clamp(num(l.imitateBlend, 0.15), 0, 1);
  l.reversalStreak = Math.max(1, Math.round(num(l.reversalStreak, 8)));
  l.winStreakPenalty.enabled = !!l.winStreakPenalty.enabled;
  l.winStreakPenalty.threshold = Math.max(1, Math.round(num(l.winStreakPenalty.threshold, 8)));
  l.winStreakPenalty.chance = clamp(num(l.winStreakPenalty.chance, 0.08), 0, 1);

  cfg.classes.enabled = !!cfg.classes.enabled;
  cfg.classes.lowFactor = Math.max(0, num(cfg.classes.lowFactor, 0.5));
  cfg.classes.midFactor = Math.max(cfg.classes.lowFactor, num(cfg.classes.midFactor, 2));
  cfg.classes.highFactor = Math.max(cfg.classes.midFactor, num(cfg.classes.highFactor, 10));

  const p = cfg.plague;
  p.enabled = !!p.enabled;
  p.startRound = Math.max(1, Math.round(num(p.startRound, 300)));
  p.everyRounds = Math.max(1, Math.round(num(p.everyRounds, 200)));
  p.probability = clamp(num(p.probability, 0.4), 0, 1);
  p.infectRate = clamp(num(p.infectRate, 0.02), 0, 1);
  p.damagePct = clamp(num(p.damagePct, 0.03), 0, 1);
  p.antibodyChance = clamp(num(p.antibodyChance, 0.08), 0, 1);
  p.heritable = !!p.heritable;
  p.lowWealthExtraDeath = clamp(num(p.lowWealthExtraDeath, 0.02), 0, 1);

  const rl = cfg.resourceLimited;
  rl.enabled = !!rl.enabled;
  rl.initialPool = num(rl.initialPool, 0);
  rl.taxToPool = !!rl.taxToPool;
  rl.welfareFromPool = !!rl.welfareFromPool;

  const gd = cfg.guilds;
  gd.enabled = !!gd.enabled;
  gd.count = clamp(Math.round(num(gd.count, 32)), 1, 256);
  gd.joinChance = clamp(num(gd.joinChance, 0.5), 0, 1);
  gd.recruitChance = clamp(num(gd.recruitChance, 0.002), 0, 1);
  gd.contributeRate = clamp(num(gd.contributeRate, 0.01), 0, 1);
  gd.coverRatio = clamp(num(gd.coverRatio, 0.8), 0, 1);
  gd.expelBelowRatio = clamp(num(gd.expelBelowRatio, 0.9), 0, 2);
  gd.levelUpAssets = Math.max(1, num(gd.levelUpAssets, 1_000_000));
  gd.maxLevel = clamp(Math.round(num(gd.maxLevel, 10)), 1, 50);
  gd.costDiscountPerLevel = clamp(num(gd.costDiscountPerLevel, 0.01), 0, 0.2);
  gd.warChance = clamp(num(gd.warChance, 0.02), 0, 1);
  gd.warChampionCount = clamp(Math.round(num(gd.warChampionCount, 3)), 1, 20);
  gd.warStake = Math.max(0, num(gd.warStake, 50));

  cfg.families.enabled = !!cfg.families.enabled;
  cfg.families.count = clamp(Math.round(num(cfg.families.count, 512)), 1, 4096);

  const b = cfg.balance;
  b.newbieProtectRounds = Math.max(0, Math.round(num(b.newbieProtectRounds, 10)));
  b.assetSoftCap.enabled = !!b.assetSoftCap.enabled;
  b.assetSoftCap.threshold = Math.max(1, num(b.assetSoftCap.threshold, 100_000));
  b.assetSoftCap.decay = clamp(num(b.assetSoftCap.decay, 0.85), 0, 1);
  b.redistribution.enabled = !!b.redistribution.enabled;
  b.redistribution.toLastOpponents = clamp(Math.round(num(b.redistribution.toLastOpponents, 5)), 0, 32);

  const perf = cfg.performance;
  perf.snapshotIntervalMs = clamp(Math.round(num(perf.snapshotIntervalMs, 90)), 16, 2000);
  perf.sampleSize = clamp(Math.round(num(perf.sampleSize, 65_536)), 0, 262_144);
  perf.gridStrategy.w = clamp(Math.round(num(perf.gridStrategy.w, 192)), 16, 512);
  perf.gridStrategy.h = clamp(Math.round(num(perf.gridStrategy.h, 160)), 16, 512);
  perf.gridWealth.w = clamp(Math.round(num(perf.gridWealth.w, 256)), 16, 512);
  perf.gridWealth.h = clamp(Math.round(num(perf.gridWealth.h, 128)), 16, 512);
  perf.historyRounds = clamp(Math.round(num(perf.historyRounds, 2000)), 60, 20_000);
  perf.topFamilies = clamp(Math.round(num(perf.topFamilies, 20)), 1, 100);
  perf.eventLogSize = clamp(Math.round(num(perf.eventLogSize, 30)), 1, 200);

  cfg.speed.targetRoundsPerSec = Math.max(0, num(cfg.speed.targetRoundsPerSec, 0));

  cfg.parallel.enabled = !!cfg.parallel.enabled;
  cfg.parallel.workers = clamp(Math.round(num(cfg.parallel.workers, 0)), 0, 16);
  cfg.parallel.minPairs = clamp(Math.round(num(cfg.parallel.minPairs, 6000)), 100, 2_000_000);

  // ── 派生信息 ──
  cfg._derived = {
    classThresholds: [
      cfg.initialWealth * cfg.classes.lowFactor,
      cfg.initialWealth * cfg.classes.midFactor,
      cfg.initialWealth * cfg.classes.highFactor,
    ],
    initialCapacity: Math.ceil(cfg.initialPopulation * 1.15),
    version: CONFIG_VERSION,
  };
  return cfg;
}

/** 阶层名称 */
export const CLASS_NAMES = ['底层', '中层', '上层', '顶层'];
export const CLASS_COLORS = ['#5b6b8c', '#3fa7d6', '#f5b942', '#ff5d73'];

/**
 * 按资产划分阶层（0=底层 1=中层 2=上层 3=顶层）。
 * 阈值来自 cfg._derived.classThresholds；负资产归入底层。
 * @param {object} cfg
 * @param {number} asset
 * @returns {number} 0..3
 */
export function classOf(cfg, asset) {
  const t = cfg._derived.classThresholds;
  if (asset >= t[2]) return 3;
  if (asset >= t[1]) return 2;
  if (asset >= t[0]) return 1;
  return 0;
}

/** 天赋名称 / 颜色（talents.js 会复用） */
export const TALENT_NAMES = ['无', '幸运儿', '节俭者', '生育达人', '学习天才', '负债抗性'];
export const TALENT_COLORS = ['#7f8c9b', '#f7d343', '#42d392', '#ff9f43', '#5b8cff', '#c56cf0'];
