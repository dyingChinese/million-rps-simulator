/**
 * mock.js — ?mock=1 时的本地合成帧源
 *
 * 目标：**无需后端**即可完整驱动所有面板 / WebGL 视图 / 图表，
 * 并且与真实快照 schema 完全一致（同样的 JSON 字段 + 同样的 sections 二进制布局）。
 * 数据通过 protocol.encodeFrame 编码成真实二进制帧，再走与真实模式**完全相同**的解析路径，
 * 因此 mock 模式同时也是协议解析的活体测试。
 *
 * 演化是缓慢的：策略概率随时间在三角空间内旋转，资产做带噪声的随机游走，
 * 阶层/基尼/家族排行随之漂移。
 */

import {
  encodeFrame,
  createWealthMapping,
  CLASS_NAMES,
  TALENT_NAMES,
  TALENT_COLORS,
  CLASS_COLORS,
  MOVE_COLORS,
  HIST_BINS,
} from './protocol.js';

/* ────────────────────────────── 默认配置（与 src/core/config.js 对齐） ────────────────────────────── */

const DEFAULT_CONFIG = {
  seed: 20241120,
  initialPopulation: 1_000_000,
  maxPopulation: 1_500_000,
  initialWealth: 1000,
  maxDebt: 500,
  roundCost: 10,
  betMultiplier: 1.0,
  maxAge: 1000,
  genetics: {
    reproWealthThreshold: 2000,
    minReproAge: 216, // 18 岁成年（按 1 回合≈1 月、maxAge 1000 回合≈83 年折算）
    maxReproCount: 5,
    baseBirthCost: 500,
    birthCostRatio: 0.05,
    mutationRate: 0.05,
    reproChancePerRound: 0.02,
    initialAsset: 0,
    debtLimitMutation: 0.1,
  },
  matching: { mode: 'random', wealthPct: 25, strategyBins: 16 },
  endCondition: {
    mode: 'C',
    threshold: 100_000,
    pct: 10,
    rounds: 2000,
    noGrowthRounds: 200,
    maxRounds: 100_000,
  },
  macro: {
    average: { enabled: true, startRound: 60, everyRounds: 60, takePct: 2 },
    redistribute: { enabled: false, startRound: 200, everyRounds: 200, topPct: 10, takePct: 15, bottomPct: 20 },
    disaster: { enabled: false, startRound: 300, everyRounds: 300, probability: 0.2, affectedPct: 5, shrinkPct: 10 },
    dividend: { enabled: true, startRound: 5, everyRounds: 2, probability: 0.5, affectedPct: 30, amount: 140 },
    subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 2000, countPct: 0.5, amount: 20 },
  },
  inflation: { rate: 0.0002, dynamic: false, dynamicTarget: 1e10, maxFactor: 1000 },
  interest: { rate: 0.01, usuryThreshold: 0.5, usuryMultiplier: 2.0 },
  talents: {
    enabled: true,
    inheritanceMutation: 0.03,
    weights: { none: 60, lucky: 8, thrifty: 8, fertile: 8, fastLearner: 8, debtResistant: 8 },
    effects: {
      luckBonus: 0.01,
      thriftyCostReduce: 0.1,
      fertileBirthCostReduce: 0.3,
      fastLearn: 0.5,
      debtLimitBonus: 0.2,
    },
  },
  learning: {
    enabled: true,
    lossTrigger: 3,
    adjustStep: 0.02,
    imitateChance: 0.01,
    imitateThreshold: 1.5,
    imitateBlend: 0.15,
    reversalStreak: 8,
    winStreakPenalty: { enabled: true, threshold: 8, chance: 0.08 },
  },
  classes: { enabled: true, lowFactor: 0.5, midFactor: 2, highFactor: 10 },
  plague: {
    enabled: false,
    startRound: 300,
    everyRounds: 200,
    probability: 0.4,
    infectRate: 0.02,
    damagePct: 0.03,
    antibodyChance: 0.08,
    heritable: true,
    lowWealthExtraDeath: 0.02,
  },
  resourceLimited: { enabled: false, initialPool: 0, taxToPool: true, welfareFromPool: true },
  guilds: {
    enabled: true, // mock 演示默认开启（真实默认 false，便于展示公会排行）
    count: 32,
    joinChance: 0.5,
    recruitChance: 0.002,
    contributeRate: 0.002,
    coverRatio: 0.8,
    expelBelowRatio: 0.9,
    levelUpAssets: 500_000,
    maxLevel: 10,
    costDiscountPerLevel: 0.01,
    warChance: 0.02,
    warChampionCount: 3,
    warStake: 50,
  },
  families: { enabled: true, count: 512 },
  balance: {
    newbieProtectRounds: 10,
    assetSoftCap: { enabled: true, threshold: 100_000, decay: 0.85 },
    redistribution: { enabled: false, toLastOpponents: 5 },
  },
  performance: {
    snapshotIntervalMs: 90,
    sampleSize: 65_536,
    gridStrategy: { w: 192, h: 160 },
    gridWealth: { w: 256, h: 128 },
    historyRounds: 2000,
    topFamilies: 100,
    eventLogSize: 30,
  },
  speed: { targetRoundsPerSec: 0 },
  // 并行对战（真实引擎用；mock 仅用于 HUD 展示「并行 N 线程」）
  parallel: { enabled: true, workers: 0, minPairs: 6000 },
};

const PRESETS = {
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

const SURNAMES = [
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈', '褚', '卫', '蒋', '沈', '韩', '杨',
  '朱', '秦', '尤', '许', '何', '吕', '施', '张', '孔', '曹', '严', '华', '金', '魏', '陶', '姜',
];

/** 公会名（第 2 轮；≥32 个中文名，与 CONTRACTS §10 语义一致） */
const GUILD_NAMES = [
  '青龙会', '白虎堂', '朱雀阁', '玄武盟', '天罡会', '地煞帮', '凌云阁', '听雨楼',
  '长风堂', '赤霄盟', '墨影阁', '金鳞会', '青锋剑派', '玄机阁', '破军堂', '七星会',
  '流云阁', '震雷堂', '寒江盟', '万象楼', '飞星阁', '凌霄殿', '百川会', '孤鸿馆',
  '铁血堂', '紫电盟', '沧澜阁', '惊鸿楼', '卧龙堂', '逐日会', '踏雪盟', '九幽阁',
];

const EVENT_TEMPLATES = [
  { type: 'macro.average', title: '宏观调控·均富', detail: '向高资产群体抽取 10% 平均分给全体', sign: -0.004 },
  { type: 'macro.redistribute', title: '宏观调控·再分配', detail: '顶层 10% 资产抽取 30% 补给底层 20%', sign: -0.006 },
  { type: 'macro.disaster', title: '随机灾难', detail: '20% 个体资产缩水 30%', sign: -0.012 },
  { type: 'macro.dividend', title: '全民分红', detail: '10% 个体获得 500 单位分红', sign: 0.008 },
  { type: 'macro.subsidy', title: '保底补助', detail: '底层 2000 人获得 30 单位补助', sign: 0.002 },
  { type: 'plague.start', title: '瘟疫爆发', detail: '每回合 2% 感染率，感染者资产持续流失', sign: -0.01 },
  { type: 'plague.end', title: '瘟疫平息', detail: '感染曲线回落，抗体比例上升', sign: 0.0 },
  { type: 'population.bankruptcy', title: '破产潮', detail: '一批负债个体被冻结清算', sign: -0.003 },
  { type: 'family.milestone', title: '家族崛起', detail: '某家族资产突破历史新高', sign: 0.001 },
  { type: 'macro.average', title: '宏观调控·均富', detail: '本轮抽取比例 10%，覆盖 1.2 万高资产个体', sign: -0.004 },
];

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** 确定性 LCG（mock 独立随机流，不依赖 core/rng.js） */
function createRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 稳定泳道散列（与 core/rng.js hashLane 语义一致：[0,1)） */
function hashLane(id) {
  let x = Math.imul(id >>> 0, 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 深合并（普通对象递归，数组/标量替换） */
function mergeConfig(base, patch) {
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

const deepClone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 由配置生成派生信息（与 core/config.js 的 _derived 对齐） */
function derive(cfg) {
  cfg._derived = {
    classThresholds: [
      cfg.initialWealth * cfg.classes.lowFactor,
      cfg.initialWealth * cfg.classes.midFactor,
      cfg.initialWealth * cfg.classes.highFactor,
    ],
    initialCapacity: Math.ceil(cfg.initialPopulation * 1.15),
    version: 1,
  };
  return cfg;
}

/* ────────────────────────────── MockBackend ────────────────────────────── */

export class MockBackend {
  /**
   * @param {{onFrame?:(bytes:Uint8Array)=>void, delay?:number, intervalMs?:number, seed?:number}} [opts]
   */
  constructor(opts = {}) {
    this.isMock = true;
    this.onFrame = opts.onFrame || null;
    this.delay = Math.max(0, opts.delay || 0);
    this.intervalMs = Math.max(60, opts.intervalMs || 130);
    this.seed = opts.seed || 20241120;
    this.config = derive(mergeConfig(deepClone(DEFAULT_CONFIG), {}));
    this.seq = 0;
    this.round = 0;
    this.status = 'running'; // 演示默认开跑
    this.speedTarget = 0;
    this.endReason = null;
    this.uptimeStart = Date.now();
    this.lastFrameBytes = 0;
    this._timer = null;
    this._delayTimer = null;
    this._dirty = false;
    this._stopped = true;
    this._trackedIds = [];
    this._resetSim();
  }

  /* ---------- 元数据（等价 GET /api/config） ---------- */
  getMeta() {
    return {
      ok: true,
      mock: true,
      config: deepClone(this.config),
      presets: PRESETS,
      classNames: CLASS_NAMES,
      talentNames: TALENT_NAMES,
      classColors: CLASS_COLORS,
      talentColors: TALENT_COLORS,
      moveColors: MOVE_COLORS,
      version: 1,
    };
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this.uptimeStart = Date.now();
    const begin = () => {
      if (this._stopped) return;
      this._dirty = true;
      this._tickFrame();
      this._timer = setInterval(() => this._tickFrame(), this.intervalMs);
    };
    if (this.delay > 0) this._delayTimer = setTimeout(begin, this.delay);
    else begin();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this._delayTimer) clearTimeout(this._delayTimer);
    this._timer = null;
    this._delayTimer = null;
  }

  /* ---------- 控制指令（等价 POST /api/control） ---------- */
  control(action, payload = {}) {
    const res = this._handleControl(action, payload);
    if (res && res.ok) {
      // 控制指令立即推一帧，UI 秒回（真实后端也是这么做的）
      this._dirty = true;
      if (!this._stopped) this._tickFrame();
    }
    return res;
  }

  _handleControl(action, payload = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    switch (action) {
      case 'start':
      case 'resume': {
        if (this.status === 'ended') this._resetSim();
        this.status = 'running';
        this._dirty = true;
        return { ok: true, status: this.status };
      }
      case 'pause': {
        this.status = 'paused';
        this._dirty = true;
        return { ok: true, status: this.status };
      }
      case 'step': {
        if (this.status !== 'paused') return { ok: false, error: '仅暂停状态可单步' };
        const n = clamp(Math.round(Number(p.rounds) || 1), 1, 100);
        this._advance(n);
        this._dirty = true;
        return { ok: true, round: this.round };
      }
      case 'reset': {
        this._resetSim();
        this.status = 'paused';
        this._dirty = true;
        return { ok: true, round: 0 };
      }
      case 'setConfig': {
        const patch = p.patch && typeof p.patch === 'object' ? p.patch : {};
        const prev = this.config;
        const prevGuilds = JSON.stringify(prev.guilds || {});
        const mergable = deepClone(prev);
        delete mergable._derived;
        this.config = derive(mergeConfig(mergable, patch));
        const reset =
          prev.initialPopulation !== this.config.initialPopulation ||
          prev.maxPopulation !== this.config.maxPopulation ||
          prev.initialWealth !== this.config.initialWealth ||
          prev.maxDebt !== this.config.maxDebt;
        if (reset) {
          this._resetSim();
          this.status = 'paused';
          this.round = 0;
        } else {
          this._mapping = createWealthMapping(this.config);
          this._gridW = this.config.performance.gridStrategy.w;
          this._gridH = this.config.performance.gridStrategy.h;
          // 公会配置变化（数量/开关等）时重建公会基本盘，保证排行与参数量级一致
          if (JSON.stringify(this.config.guilds || {}) !== prevGuilds) {
            this._setupGuilds(createRng(this.seed ^ 0x27d4eb2f));
          }
        }
        this._dirty = true;
        return { ok: true, reset, config: deepClone(this.config) };
      }
      case 'preset': {
        const name = String(p.name || '');
        const preset = PRESETS[name];
        if (!preset) return { ok: false, error: '未知预设: ' + name };
        const { label, ...patch } = preset;
        const mergable = deepClone(this.config);
        delete mergable._derived;
        this.config = derive(mergeConfig(mergable, deepClone(patch)));
        this._resetSim();
        this.status = 'paused';
        this.round = 0;
        this._dirty = true;
        return { ok: true, reset: true, config: deepClone(this.config) };
      }
      case 'speed': {
        this.speedTarget = Math.max(0, Number(p.targetRoundsPerSec) || 0);
        this.config.speed.targetRoundsPerSec = this.speedTarget;
        return { ok: true, speedTarget: this.speedTarget };
      }
      case 'trigger': {
        const kind = String(p.macro || 'average');
        const ev = this._pushEvent(kind, true);
        this._dirty = true;
        return { ok: true, event: ev };
      }
      case 'track': {
        const id = Number(p.id);
        if (!Number.isFinite(id)) return { ok: false, error: '缺少 id' };
        if (this._trackedIds.includes(id)) return { ok: true, already: true };
        if (this._trackedIds.length >= 8) return { ok: false, error: '最多同时追踪 8 个个体' };
        this._trackedIds.push(id);
        this._dirty = true;
        return { ok: true, tracked: id };
      }
      case 'untrack': {
        const id = Number(p.id);
        this._trackedIds = this._trackedIds.filter((x) => x !== id);
        this._dirty = true;
        return { ok: true, untracked: id };
      }
      default:
        return { ok: false, error: '未知指令: ' + action };
    }
  }

  /* ---------- 内部：模拟状态 ---------- */

  _resetSim() {
    const cfg = this.config;
    this.seq = 0;
    this.round = 0;
    this.t = 0;
    this.status = this.status === 'running' ? 'running' : this.status;
    this.endReason = null;
    this.trackedHistory = new Map();
    this._trackedIds = [];
    this.events = [];
    this.eventsPre = 0;

    this._mapping = createWealthMapping(cfg);
    this._gridW = cfg.performance.gridStrategy.w;
    this._gridH = cfg.performance.gridStrategy.h;
    this._sampleCount = Math.min(20_000, cfg.performance.sampleSize || 20_000);
    const N = (this._N = this._sampleCount);
    this._ids = new Int32Array(N);
    this._lane = new Float32Array(N);
    this._phase = new Float32Array(N * 3);
    this._jitter = new Float32Array(N * 3);
    this._base = new Float32Array(N * 3); // 个体基础策略（单纯形均匀分布）
    this._asset = new Float64Array(N);
    this._talent = new Uint8Array(N);
    this._streak = new Float32Array(N);
    this._wins = new Int32Array(N);
    this._losses = new Int32Array(N);
    this._draws = new Int32Array(N);
    this._birthRound = new Int32Array(N);
    this._generation = new Int16Array(N);

    const rng = createRng(this.seed ^ 0x51ed270b);
    const W = cfg.talents.weights;
    const talentKeys = ['none', 'lucky', 'thrifty', 'fertile', 'fastLearner', 'debtResistant'];
    const talentWeights = talentKeys.map((k) => Math.max(0, Number(W[k]) || 0));
    let talentTotal = 0;
    for (let i = 0; i < talentWeights.length; i++) talentTotal += talentWeights[i];
    if (talentTotal <= 0) talentTotal = 1;

    for (let i = 0; i < N; i++) {
      this._ids[i] = 1 + i * 17;
      this._lane[i] = hashLane(this._ids[i]);
      this._phase[i * 3] = rng() * Math.PI * 2;
      this._phase[i * 3 + 1] = rng() * Math.PI * 2;
      this._phase[i * 3 + 2] = rng() * Math.PI * 2;
      this._jitter[i * 3] = (rng() - 0.5) * 0.5;
      this._jitter[i * 3 + 1] = (rng() - 0.5) * 0.5;
      this._jitter[i * 3 + 2] = (rng() - 0.5) * 0.5;
      // 基础策略：指数分布归一化 = 单纯形上的均匀分布，让点云铺满策略三角
      const e0 = -Math.log(Math.max(1e-9, rng()));
      const e1 = -Math.log(Math.max(1e-9, rng()));
      const e2 = -Math.log(Math.max(1e-9, rng()));
      const es = e0 + e1 + e2 || 1;
      this._base[i * 3] = e0 / es;
      this._base[i * 3 + 1] = e1 / es;
      this._base[i * 3 + 2] = e2 / es;
      // 对数正态 + 重尾：多数个体在初始资金附近，少数极富 / 少量负债
      const u1 = Math.max(1e-9, rng());
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      let asset = cfg.initialWealth * Math.exp(0.85 * z - 0.25);
      if (rng() < 0.025) asset *= 18; // 重尾
      if (rng() < 0.045) asset = -Math.abs(asset) * (0.15 + rng() * 0.8); // 负债者
      this._asset[i] = asset;
      let pick = rng() * talentTotal;
      let talent = 0;
      for (let k = 0; k < talentWeights.length; k++) {
        pick -= talentWeights[k];
        if (pick <= 0) {
          talent = k;
          break;
        }
      }
      this._talent[i] = talent;
      this._streak[i] = (rng() - 0.5) * 0.6;
      this._birthRound[i] = -Math.floor(rng() * Math.max(1, cfg.maxAge));
      this._generation[i] = 1 + Math.floor(rng() * 9);
    }

    // 人口与累计统计
    this.alive = Math.round(cfg.initialPopulation * 0.94);
    this.births = Math.round(cfg.initialPopulation * 0.06);
    this.deaths = Math.round(cfg.initialPopulation * 0.02);
    this.bankruptcies = Math.round(cfg.initialPopulation * 0.01);
    this.frozen = Math.round(cfg.initialPopulation * 0.004);
    this.totalCreated = 0;
    this.totalDestroyed = 0;
    this._noGrowth = 0;
    this._lastTotalWealth = 0;
    this._reviveRound = this.round;

    // 时间序列
    this.series = {
      round: [], alive: [], births: [], deaths: [], bankruptcies: [],
      totalWealth: [], meanWealth: [], gini: [],
      rock: [], scissors: [], paper: [],
      class0: [], class1: [], class2: [], class3: [],
    };

    // 家族池（固定 512 家族中的 24 个样例，保证排行可见）
    this._familyPool = [];
    const famCount = Math.max(8, cfg.families.count);
    for (let i = 0; i < Math.min(24, famCount); i++) {
      this._familyPool.push({
        id: i,
        name: i < SURNAMES.length ? SURNAMES[i] + '家' : '家族' + i,
        base: Math.pow(0.92, i) * (0.8 + rng() * 0.5), // 递减权重
        memberFrac: 0.3 + rng() * 0.5,
        generation: 2 + Math.floor(rng() * 10),
      });
    }
    this._famCount = famCount;

    // 公会池（第 2 轮）：预生成 count 个公会的基本盘，随时间缓慢演化
    this._setupGuilds(rng);

    // 初始事件（让面板一开就有内容）
    this.events = [];
    const seedEvents = [
      { r: 2, t: 4 },
      { r: 6, t: 0 },
      { r: 11, t: 8 },
      { r: 17, t: 2 },
      { r: 24, t: 5 },
    ];
    for (let i = seedEvents.length - 1; i >= 0; i--) {
      const s = seedEvents[i];
      const tpl = EVENT_TEMPLATES[s.t];
      this.events.push({
        round: s.r,
        type: tpl.type,
        title: tpl.title,
        detail: tpl.detail,
        delta: Math.round(tpl.sign * this.alive * this.config.initialWealth * 0.001),
      });
    }
    this.eventsPre = this.events.length;

    const N2 = this._N;
    this._pts = new Float32Array(N2 * 7);
    this._hist = new Float32Array(HIST_BINS);
    this._grid = new Float32Array(this._gridW * this._gridH);
    this._gridWealth = new Float32Array(this._gridW * this._gridH);
    this._gridTmp = new Float32Array(this._gridW * this._gridH);
    this._idsSection = this._ids;
    this._lastFrameBytes = 0;
    this._updateRoundOnce(0);
  }

  /** 每 tick 推进的回合数（速度目标会拉开/压缩） */
  _roundsPerTick() {
    const base = 6;
    if (this.speedTarget > 0) return Math.max(1, Math.round(this.speedTarget * (this.intervalMs / 1000)));
    return base;
  }

  _advance(rounds) {
    const n = this._roundsPerTick();
    const steps = Math.max(1, Math.round(rounds / n));
    for (let i = 0; i < steps; i++) {
      this.round += n;
      this._updateRoundOnce(n);
    }
  }

  _tickFrame() {
    if (this._stopped) return;
    let dirty = this._dirty;
    if (this.status === 'running') {
      this._advance(this._roundsPerTick());
      dirty = true;
    }
    if (!dirty) return;
    this._dirty = false;
    this._emitFrame();
  }

  /** 推进一次模拟（聚合、抽样、统计全部在一趟循环内完成） */
  _updateRoundOnce(roundsDelta) {
    const cfg = this.config;
    const N = this._N;
    const mapping = this._mapping;
    const pts = this._pts;
    const hist = this._hist;
    const grid = this._grid;
    const gridWealth = this._gridWealth;
    const gw = this._gridW;
    const gh = this._gridH;
    hist.fill(0);
    grid.fill(0);
    gridWealth.fill(0);

    const t = (this.t += 1);
    const thresholds = cfg._derived.classThresholds;
    const classCount = [0, 0, 0, 0];
    const classWealth = [0, 0, 0, 0];
    const usage = [0, 0, 0];
    const dominant = [0, 0, 0];
    const talents = [0, 0, 0, 0, 0, 0];
    let sumAsset = 0;
    let maxAsset = -Infinity;
    let minAsset = Infinity;
    let negCount = 0;
    let aboveThreshold = 0;
    const endThreshold = cfg.endCondition.threshold;
    let entropySum = 0;
    let aliveSample = 0;
    const rng = this._rng || (this._rng = createRng(this.seed ^ 0x9e3779b9));

    // 全局策略偏好（RPS 循环：三种拳的总体占比此消彼长，界面才看得出演化）
    const gp = t * 0.085;
    const g0 = 1 + 0.38 * Math.sin(gp);
    const g1 = 1 + 0.38 * Math.sin(gp + 2.0943951);
    const g2 = 1 + 0.38 * Math.sin(gp + 4.1887902);

    for (let i = 0; i < N; i++) {
      // ── 策略：个体基础偏好 × 全局 RPS 循环权重 × 缓慢个体漂移 ──
      const b0 = this._base[i * 3];
      const b1 = this._base[i * 3 + 1];
      const b2 = this._base[i * 3 + 2];
      const l0 = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.05 + this._phase[i * 3]));
      const l1 = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.05 + this._phase[i * 3 + 1]));
      const l2 = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 0.05 + this._phase[i * 3 + 2]));
      let pr = b0 * g0 * l0 + this._jitter[i * 3] * 0.006;
      let ps = b1 * g1 * l1 + this._jitter[i * 3 + 1] * 0.006;
      let pp = b2 * g2 * l2 + this._jitter[i * 3 + 2] * 0.006;
      if (pr < 0.005) pr = 0.005;
      if (ps < 0.005) ps = 0.005;
      if (pp < 0.005) pp = 0.005;
      if (pr < 0.01) pr = 0.01;
      if (ps < 0.01) ps = 0.01;
      if (pp < 0.01) pp = 0.01;
      const inv = 1 / (pr + ps + pp);
      pr *= inv;
      ps *= inv;
      pp *= inv;
      const stratX = pp + 0.5 * ps;
      const stratY = ps * 0.8660254;

      // ── 资产：带漂移 + 噪声的随机游走，偶发大赢大亏 ──
      let asset = this._asset[i];
      const drift = 0.0035 + 0.002 * Math.sin(t * 0.02 + this._phase[i]);
      const noise = (rng() - 0.5) * 0.05;
      asset *= 1 + drift + noise;
      const shock = rng();
      if (shock < 0.0015) asset *= 2.2;
      else if (shock < 0.0035) asset *= 0.35;
      const cap = cfg.initialWealth * 5000;
      if (asset > cap) asset = cap;
      const floor = -cfg.maxDebt * 1.4;
      if (asset < floor) asset = floor;
      this._asset[i] = asset;

      // ── 连胜/连败（-1..1） ──
      let streak = this._streak[i] * 0.92 + (rng() - 0.5) * 0.22;
      if (streak > 1) streak = 1;
      else if (streak < -1) streak = -1;
      this._streak[i] = streak;

      // ── 派生统计 ──
      sumAsset += asset;
      if (asset > maxAsset) maxAsset = asset;
      if (asset < minAsset) minAsset = asset;
      if (asset < 0) negCount++;
      if (asset >= endThreshold) aboveThreshold++;
      aliveSample++;

      const classId = asset < thresholds[0] ? 0 : asset < thresholds[1] ? 1 : asset < thresholds[2] ? 2 : 3;
      classCount[classId]++;
      classWealth[classId] += asset;

      usage[0] += pr;
      usage[1] += ps;
      usage[2] += pp;
      if (pr >= ps && pr >= pp) dominant[0]++;
      else if (ps >= pp) dominant[1]++;
      else dominant[2]++;
      talents[this._talent[i]]++;
      entropySum += -(pr * Math.log(pr) + ps * Math.log(ps) + pp * Math.log(pp));

      // ── 直方图 / 策略网格 ──
      hist[mapping.binOf(asset, HIST_BINS)]++;
      const wealthY = mapping.toY(asset);
      let gx = Math.floor(stratX * gw);
      if (gx < 0) gx = 0;
      else if (gx >= gw) gx = gw - 1;
      let gy = Math.floor((stratY / 0.8660254) * gh);
      if (gy < 0) gy = 0;
      else if (gy >= gh) gy = gh - 1;
      const gi = gy * gw + gx;
      grid[gi] += 1;
      gridWealth[gi] += wealthY;

      // ── 写 pts / ids ──
      const o = i * 7;
      pts[o] = this._lane[i];
      pts[o + 1] = wealthY;
      pts[o + 2] = classId;
      pts[o + 3] = this._talent[i];
      pts[o + 4] = streak;
      pts[o + 5] = stratX;
      pts[o + 6] = stratY;

      // 胜负计数用于追踪卡
      if (rng() < 0.5) this._wins[i]++;
      else if (rng() < 0.8) this._losses[i]++;
      else this._draws[i]++;
    }

    // 网格平滑（可分离盒式模糊，让热图呈连续星云状）
    this._blurGrid(grid);

    // ── 人口演化 ──
    const cfg2 = this.config;
    const aliveBefore = this.alive;
    const birthCount = Math.round(this.alive * (0.0016 + rng() * 0.0012));
    const deathCount = Math.round(this.alive * (0.0012 + rng() * 0.0009));
    const bankCount = Math.round(this.alive * (0.00012 + rng() * 0.0002));
    this.births += birthCount;
    this.deaths += deathCount;
    this.bankruptcies += bankCount;
    this.alive = clamp(
      this.alive + birthCount - deathCount - bankCount,
      Math.round(cfg2.initialPopulation * 0.35),
      cfg2.maxPopulation,
    );
    if (this.alive !== aliveBefore) this.frozen = Math.round(this.alive * 0.004);

    // ── 财富聚合 ──
    const mean = sumAsset / Math.max(1, aliveSample);
    const totalWealth = mean * this.alive;
    const scale = this.alive / Math.max(1, aliveSample);

    // 洛伦兹曲线 / 基尼：按直方图累计 + 分位插值得到 51 个平滑点（与 analytics 口径一致）
    let totalCount = 0;
    for (let b = 0; b < HIST_BINS; b++) totalCount += hist[b];
    const lorenz = buildLorenz(hist, mapping, totalCount, sumAsset);
    let area = 0;
    for (let i = 0; i < 50; i++) {
      const x0 = lorenz[i * 2];
      const y0 = lorenz[i * 2 + 1];
      const x1 = lorenz[(i + 1) * 2];
      const y1 = lorenz[(i + 1) * 2 + 1];
      area += (x1 - x0) * (y0 + y1) * 0.5;
    }
    const gini = clamp(1 - 2 * area, 0, 1);

    // 中位数 / P90（从直方图累计近似）
    let med = 0;
    let p90 = 0;
    if (totalCount > 0) {
      let acc = 0;
      let medFound = false;
      for (let b = 0; b < HIST_BINS; b++) {
        acc += hist[b];
        if (!medFound && acc >= totalCount * 0.5) {
          med = mapping.binCenterAsset(b, HIST_BINS);
          medFound = true;
        }
        if (acc >= totalCount * 0.9) {
          p90 = mapping.binCenterAsset(b, HIST_BINS);
          break;
        }
      }
      if (!medFound) med = mapping.binCenterAsset(HIST_BINS >> 1, HIST_BINS);
    }

    // ── 策略占比 ──
    const usageSum = usage[0] + usage[1] + usage[2] || 1;
    const usageNorm = [usage[0] / usageSum, usage[1] / usageSum, usage[2] / usageSum];
    const dominantNorm = [dominant[0] / N, dominant[1] / N, dominant[2] / N];
    const entropy = entropySum / N;

    // ── 阶层流动（第 2 轮）：自上一帧以来的阶层迁移（缓慢演化假数据）──
    const flowAlive = this.alive;
    const flowWave = Math.sin(t * 0.043 + (this._guildPhase || 0) * 0.3);
    const flowTotal = Math.max(0, Math.round(flowAlive * 0.0045 * (0.55 + 0.45 * flowWave) * (0.8 + rng() * 0.4)));
    const upCount = flowTotal > 0 ? Math.round(flowTotal * (0.42 + 0.12 * Math.sin(t * 0.031))) : 0;
    const downCount = Math.max(0, flowTotal - upCount);
    const stayCount = Math.max(0, flowAlive - flowTotal);
    const mobility = flowTotal / Math.max(1, flowAlive);
    const flowIn = [0, 0, 0, 0];
    const flowOut = [0, 0, 0, 0];
    {
      const up0 = Math.round(upCount * 0.5);
      const up1 = Math.round(upCount * 0.3);
      const up2 = Math.max(0, upCount - up0 - up1);
      const down0 = Math.round(downCount * 0.5);
      const down1 = Math.round(downCount * 0.3);
      const down2 = Math.max(0, downCount - down0 - down1);
      // 向上流动：阶层 i → i+1；向下流动：i+1 → i
      flowOut[0] += up0; flowIn[1] += up0;
      flowOut[1] += up1; flowIn[2] += up1;
      flowOut[2] += up2; flowIn[3] += up2;
      flowIn[0] += down0; flowOut[1] += down0;
      flowIn[1] += down1; flowOut[2] += down1;
      flowIn[2] += down2; flowOut[3] += down2;
    }
    const classFlow = { up: upCount, down: downCount, stay: stayCount, total: flowAlive, mobility: round3(mobility) };

    // ── 阶层 ──
    const classes = [];
    const positiveWealth = Math.max(1, classWealth[0] + classWealth[1] + classWealth[2] + classWealth[3]);
    const liveClassCount = classCount.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 4; i++) {
      classes.push({
        id: i,
        name: CLASS_NAMES[i],
        count: Math.round((classCount[i] / liveClassCount) * this.alive),
        share: classCount[i] / liveClassCount,
        wealthShare: Math.max(0, classWealth[i]) / Math.max(1, positiveWealth),
        flowIn: flowIn[i],
        flowOut: flowOut[i],
      });
    }
    const scaledTalents = talents.map((v) => Math.round((v / N) * this.alive));

    // ── 通胀 ──
    const factor = Math.min(cfg.inflation.maxFactor, 1 + cfg.inflation.rate * this.round);
    const cost = cfg.roundCost * factor;

    // ── 结束条件 ──
    const ec = cfg.endCondition;
    let endLabel = '';
    let progress = 0;
    switch (ec.mode) {
      case 'A':
        endLabel = `首个资产达 ${Math.round(ec.threshold)}`;
        progress = clamp(maxAsset / ec.threshold, 0, 1);
        break;
      case 'B':
        endLabel = `${ec.pct}% 个体资产超 ${Math.round(ec.threshold)}`;
        progress = clamp((aboveThreshold / Math.max(1, N)) / Math.max(0.01, ec.pct / 100), 0, 1);
        break;
      case 'D':
        endLabel = `存活低于 ${ec.pct}% 初始人口`;
        progress = clamp(this.round / ec.rounds, 0, 1);
        break;
      case 'E':
        endLabel = `连续 ${ec.noGrowthRounds} 回合总资产无增长`;
        progress = clamp(this._noGrowth / ec.noGrowthRounds, 0, 1);
        break;
      case 'C':
      default:
        endLabel = `回合 ${this.round} / ${ec.rounds}`;
        progress = clamp(this.round / ec.rounds, 0, 1);
        break;
    }
    const totalWealthRounded = Math.round(totalWealth);
    if (totalWealthRounded <= this._lastTotalWealth) this._noGrowth++;
    else this._noGrowth = 0;
    this._lastTotalWealth = totalWealthRounded;
    const ended = progress >= 1;
    if (ended && this.status === 'running') {
      this.status = 'ended';
      this.endReason = endLabel;
    }

    // ── 时间序列（保留 ≤600 点） ──
    const S = this.series;
    pushSeries(S.round, this.round, 600);
    pushSeries(S.alive, this.alive, 600);
    pushSeries(S.births, this.births, 600);
    pushSeries(S.deaths, this.deaths, 600);
    pushSeries(S.bankruptcies, this.bankruptcies, 600);
    pushSeries(S.totalWealth, totalWealthRounded, 600);
    pushSeries(S.meanWealth, Math.round(mean), 600);
    pushSeries(S.gini, round3(gini), 600);
    pushSeries(S.rock, round3(usageNorm[0]), 600);
    pushSeries(S.scissors, round3(usageNorm[1]), 600);
    pushSeries(S.paper, round3(usageNorm[2]), 600);
    pushSeries(S.class0, classes[0].count, 600);
    pushSeries(S.class1, classes[1].count, 600);
    pushSeries(S.class2, classes[2].count, 600);
    pushSeries(S.class3, classes[3].count, 600);

    // ── 家族 / 公会排行（第 2 轮新增公会）──
    const families = this._buildFamilies(totalWealthRounded);
    const guilds = this._buildGuilds(totalWealthRounded, this.alive);

    // ── 事件 ──
    let ev = null;
    if (this.status === 'running' && rng() < 0.28) ev = this._pushEvent(null, false);
    else if (this.status === 'running' && this.events.length === 0) ev = this._pushEvent(null, false);

    // ── 追踪个体 ──
    const tracked = this._buildTracked();

    // ── 资源 / 瘟疫 ──
    const resourceEnabled = !!cfg.resourceLimited.enabled;
    const plagueEnabled = !!cfg.plague.enabled;
    const plagueActive = plagueEnabled && this.round > cfg.plague.startRound && ((this.round - cfg.plague.startRound) % (cfg.plague.everyRounds * 2)) < cfg.plague.everyRounds;
    const infected = plagueActive ? Math.round(this.alive * cfg.plague.infectRate * 3) : 0;

    // ── 保存本帧 JSON 数据 ──
    this._frame = {
      seq: this.seq + 1,
      round: this.round,
      wallTime: Date.now(),
      simVersion: 1,
      engine: {
        status: this.status,
        endReason: this.endReason,
        tickMs: round1(1.2 + rng() * 2.4),
        roundsPerSec: round1(this._roundsPerTick() / (this.intervalMs / 1000)),
        uptimeMs: Date.now() - this.uptimeStart,
        speedTarget: this.speedTarget,
        parallelWorkers: this.config.parallel && this.config.parallel.enabled ? 4 : 0,
        shared: false,
      },
      population: {
        alive: this.alive,
        initial: this.config.initialPopulation,
        capacity: this.config.maxPopulation,
        births: this.births,
        deaths: this.deaths,
        bankruptcies: this.bankruptcies,
        frozen: this.frozen,
        birthRate: round3(birthCount / Math.max(1, this.alive)),
        deathRate: round3(deathCount / Math.max(1, this.alive)),
        bankruptRate: round3(bankCount / Math.max(1, this.alive)),
        families: this._famCount,
      },
      wealth: {
        total: totalWealthRounded,
        mean: round1(mean),
        median: round1(med),
        p90: round1(p90),
        max: round1(maxAsset),
        min: round1(minAsset),
        gini: round3(gini),
        lorenz,
        classWealthShare: classes.map((c) => round3(c.wealthShare)),
        negativeShare: round3(negCount / N),
      },
      strategy: {
        usage: usageNorm.map(round3),
        preference: usageNorm.map(round3),
        dominant: dominantNorm.map(round3),
        entropy: round3(entropy),
      },
      classes,
      classFlow,
      talents: scaledTalents,
      series: S,
      families,
      guilds,
      events: this.events,
      inflation: { factor: round3(factor), cost: round1(cost), baseCost: cfg.roundCost },
      resource: {
        enabled: resourceEnabled,
        pool: resourceEnabled ? Math.round(this.totalCreated - this.totalDestroyed) : 0,
        created: Math.round(this.totalCreated),
        destroyed: Math.round(this.totalDestroyed),
      },
      plague: {
        enabled: plagueEnabled,
        active: plagueActive,
        infected,
        infectedShare: round3(infected / Math.max(1, this.alive)),
        antibodies: plagueEnabled ? round3(0.02 + this.round * 0.0001) : 0,
      },
      tracked,
      endCondition: { mode: ec.mode, label: endLabel, progress: round3(progress), ended },
      perf: {
        analyticsMs: round1(2.4 + rng() * 3.5),
        frameBytes: this.lastFrameBytes,
        sampleCount: N,
        heapUsedMB: Math.round(420 + 60 * Math.sin(t * 0.03)),
        aliveScanMs: round1(1.2 + rng() * 1.5),
      },
      grids: {
        strategy: { w: gw, h: gh },
        wealth: { w: cfg.performance.gridWealth.w, h: cfg.performance.gridWealth.h },
        sampleCount: N,
      },
    };
    this._sections = [
      { name: 'pts', type: 'f32', data: pts },
      { name: 'ids', type: 'i32', data: this._ids },
      { name: 'hist', type: 'f32', data: hist },
      { name: 'strategyGrid', type: 'f32', data: grid },
      { name: 'strategyGridWealth', type: 'f32', data: gridWealth },
    ];
    this._roundsDelta = roundsDelta;
    // 记录本帧事件供底部 ticker
    if (ev) this._lastEvent = ev;
  }

  /** 可分离盒式模糊（原地），让热图更连续 */
  _blurGrid(grid) {
    const w = this._gridW;
    const h = this._gridH;
    const tmp = this._gridTmp;
    // 横向
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const l = x > 0 ? grid[i - 1] : grid[i];
        const r = x < w - 1 ? grid[i + 1] : grid[i];
        tmp[i] = (l + grid[i] * 2 + r) * 0.25;
      }
    }
    // 纵向
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const up = y > 0 ? tmp[i - w] : tmp[i];
        const dn = y < h - 1 ? tmp[i + w] : tmp[i];
        grid[i] = (up + tmp[i] * 2 + dn) * 0.25;
      }
    }
  }

  _pushEvent(kind, forced) {
    const rng = this._rng;
    let tpl;
    if (kind) {
      tpl = EVENT_TEMPLATES.find((e) => e.type === kind || e.type.endsWith('.' + kind)) || EVENT_TEMPLATES[0];
    } else {
      tpl = EVENT_TEMPLATES[Math.floor(rng() * EVENT_TEMPLATES.length)];
    }
    const baseWealth = Math.max(1, this.alive * this.config.initialWealth);
    const ev = {
      round: this.round,
      type: tpl.type,
      title: tpl.title,
      detail: tpl.detail,
      delta: Math.round(tpl.sign * baseWealth * (0.004 + rng() * 0.01)),
    };
    this.events.unshift(ev);
    const cap = Math.max(4, this.config.performance.eventLogSize || 30);
    if (this.events.length > cap) this.events.length = cap;
    return ev;
  }

  /* ── 公会（第 2 轮）：预生成公会基本盘 + 每帧聚合排行 ── */

  _setupGuilds(rng) {
    const gcfg = this.config.guilds || {};
    const count = clamp(Math.round(gcfg.count || 32), 1, Math.min(64, GUILD_NAMES.length * 2));
    this._guildCount = count;
    this._guildPhase = rng() * Math.PI * 2;
    this._guildWars = 0;
    const list = [];
    let shareSum = 0;
    for (let i = 0; i < count; i++) {
      const share = 0.5 + rng() * 1.5;
      shareSum += share;
      list.push({
        id: i,
        name: i < GUILD_NAMES.length ? GUILD_NAMES[i] : GUILD_NAMES[i % GUILD_NAMES.length] + '·分舵' + (Math.floor(i / GUILD_NAMES.length) + 1),
        share,
        memberFrac: 0.45 + rng() * 1.1,
        treasuryFrac: 0.04 + rng() * 0.07,
        baseWins: Math.round(rng() * 30),
        baseLevel: 1 + Math.floor(rng() * 4),
      });
    }
    for (const g of list) g.share /= shareSum; // 归一化，保证各公会资产份额和为 1
    this._guilds = list;
  }

  /**
   * 聚合公会排行（与 PROTOCOL §3 json.guilds 一致；enabled=false 时返回空榜）。
   * @param {number} totalWealth 全体总资产
   * @param {number} alive 存活人口
   */
  _buildGuilds(totalWealth, alive) {
    const gcfg = this.config.guilds || {};
    const count = this._guildCount || Math.round(gcfg.count || 32);
    if (!gcfg.enabled || !this._guilds) {
      return {
        enabled: !!gcfg.enabled,
        total: count,
        wars: 0,
        treasuryTotal: 0,
        avgLevel: 0,
        topWealth: [],
        topMembers: [],
        topWars: [],
      };
    }
    const t = this.t;
    const rng = this._rng;
    const maxLevel = Math.max(1, Math.round(gcfg.maxLevel || 10));
    const levelUpAssets = Math.max(1, gcfg.levelUpAssets || 1_000_000);
    const warChance = clamp(gcfg.warChance || 0.02, 0, 1);
    if (rng() < warChance * this._roundsPerTick()) this._guildWars += 1;
    const rows = [];
    let treasuryTotal = 0;
    let levelWeighted = 0;
    let membersSum = 0;
    for (let i = 0; i < this._guilds.length; i++) {
      const g = this._guilds[i];
      const wobble = 1 + 0.14 * Math.sin(t * 0.03 + i * 1.37 + this._guildPhase);
      const guildWealth = Math.max(0, totalWealth * g.share * wobble);
      const members = Math.round((alive / Math.max(1, count)) * g.memberFrac * (1 + 0.1 * Math.sin(t * 0.021 + i)));
      const treasury = Math.max(0, guildWealth * g.treasuryFrac);
      const memberAssets = Math.max(0, guildWealth - treasury);
      const level = clamp(g.baseLevel + Math.floor(Math.sqrt(guildWealth / (levelUpAssets * 6))), 1, maxLevel);
      const wins = g.baseWins + Math.floor(t * 0.35) + (guildWealth > totalWealth / Math.max(1, count) ? 1 : 0);
      rows.push({
        id: g.id,
        name: g.name,
        level,
        members,
        treasury: round2(treasury),
        memberAssets: round2(memberAssets),
        totalWealth: round2(guildWealth),
        wins,
      });
      treasuryTotal += treasury;
      levelWeighted += level * members;
      membersSum += members;
    }
    const byWealth = rows.slice().sort((a, b) => b.totalWealth - a.totalWealth).slice(0, 10);
    const byMembers = rows.slice().sort((a, b) => b.members - a.members).slice(0, 10);
    const byWars = rows.slice().sort((a, b) => b.wins - a.wins).slice(0, 10);
    return {
      enabled: true,
      total: count,
      wars: this._guildWars,
      treasuryTotal: round2(treasuryTotal),
      avgLevel: membersSum > 0 ? round2(levelWeighted / membersSum) : 0,
      topWealth: byWealth,
      topMembers: byMembers,
      topWars: byWars,
    };
  }

  _buildFamilies(totalWealth) {
    const rng = this._rng;
    const t = this.t;
    const alive = this.alive;
    const pool = this._familyPool;
    const rows = pool.map((f, i) => {
      const wobble = 1 + 0.18 * Math.sin(t * 0.02 + i * 1.7);
      const wealth = Math.max(0, totalWealth * 0.0007 * f.base * 24 * wobble);
      const members = Math.round(alive * 0.0015 * f.memberFrac * (0.8 + 0.4 * Math.sin(t * 0.01 + i)));
      return {
        id: f.id,
        name: f.name,
        wealth: Math.round(wealth * 100) / 100,
        members,
        avgWealth: members > 0 ? Math.round((wealth / members) * 100) / 100 : 0,
        generation: Math.max(1, Math.round(f.generation + t * 0.01)),
      };
    });
    const topWealth = rows.slice().sort((a, b) => b.wealth - a.wealth).slice(0, 10);
    const topSize = rows.slice().sort((a, b) => b.members - a.members).slice(0, 10);
    const topGeneration = rows.slice().sort((a, b) => b.generation - a.generation || b.members - a.members).slice(0, 10);
    return {
      topWealth,
      topSize,
      topGeneration,
      familyCount: this._famCount,
      totalMembers: alive,
    };
  }

  _buildTracked() {
    if (this._trackedIds.length === 0) return [];
    const out = [];
    const N = this._N;
    for (let k = 0; k < this._trackedIds.length; k++) {
      const id = this._trackedIds[k];
      let idx = Number.isInteger((id - 1) / 17) ? (id - 1) / 17 : -1;
      if (idx < 0 || idx >= N) {
        // 未知 id：用 id 散列映射到采样个体，保证卡片有数据
        idx = Math.abs(Math.imul(id, 2654435761)) % N;
      }
      const asset = this._asset[idx];
      const age = Math.max(0, this.round - this._birthRound[idx]);
      const strat = [
        this._pts[idx * 7 + 5] - this._pts[idx * 7 + 6] / 0.8660254 / 2, // 近似反解
        this._pts[idx * 7 + 6] / 0.8660254,
        1,
      ];
      const pS = strat[1];
      const pP = this._pts[idx * 7 + 5] - 0.5 * pS;
      const pR = Math.max(0.01, 1 - pS - pP);
      const sum = pR + pS + pP;
      const strategy = [pR / sum, pS / sum, pP / sum];
      const talentId = this._talent[idx];
      let hist = this.trackedHistory.get(id);
      if (!hist) {
        hist = [];
        this.trackedHistory.set(id, hist);
      }
      hist.push([this.round, Math.round(asset * 100) / 100]);
      if (hist.length > 240) hist.shift();
      out.push({
        id,
        name: '#' + id,
        asset: Math.round(asset * 100) / 100,
        age,
        alive: this.status !== 'ended',
        classId: asset < this.config._derived.classThresholds[0] ? 0 : asset < this.config._derived.classThresholds[1] ? 1 : asset < this.config._derived.classThresholds[2] ? 2 : 3,
        talentId,
        talentName: TALENT_NAMES[talentId] || '无',
        strategy,
        wins: this._wins[idx],
        losses: this._losses[idx],
        draws: this._draws[idx],
        reproCount: Math.min(5, Math.floor(this._wins[idx] / 40)),
        generation: this._generation[idx],
        family: { id: idx % Math.max(1, this._famCount), name: SURNAMES[idx % SURNAMES.length] + '家' },
        parents: [0, 0],
        history: hist,
      });
    }
    return out;
  }

  _emitFrame() {
    if (!this._frame) return;
    this._frame.seq = ++this.seq;
    const bytes = encodeFrame(this._frame, this._sections);
    this.lastFrameBytes = bytes.length;
    this._frame.perf.frameBytes = bytes.length;
    if (this.onFrame) this.onFrame(bytes);
  }}

/* ────────────────────────────── 小工具 ────────────────────────────── */

/**
 * 由直方图构造 51 点洛伦兹曲线（x,y 交替，x=人口累计占比，y=财富累计占比）。
 * 每个 k/50 分位在跨箱区间内做线性插值，保证曲线平滑；负资产段 clamp 到 0。
 */
function buildLorenz(hist, mapping, totalCount, totalWealth) {
  const out = new Array(102).fill(0);
  if (totalCount <= 0) {
    for (let k = 0; k <= 50; k++) {
      out[k * 2] = k / 50;
      out[k * 2 + 1] = k / 50;
    }
    return out;
  }
  const cumPop = new Float64Array(HIST_BINS + 1);
  const cumWealth = new Float64Array(HIST_BINS + 1);
  for (let b = 0; b < HIST_BINS; b++) {
    cumPop[b + 1] = cumPop[b] + hist[b];
    cumWealth[b + 1] = cumWealth[b] + hist[b] * mapping.binCenterAsset(b, HIST_BINS);
  }
  const denom = totalWealth || 1;
  let b = 0;
  for (let k = 0; k <= 50; k++) {
    const x = k / 50;
    const target = x * totalCount;
    while (b < HIST_BINS && cumPop[b + 1] < target) b++;
    let y;
    if (b >= HIST_BINS) {
      y = 1;
    } else {
      const segCount = cumPop[b + 1] - cumPop[b];
      const frac = segCount > 0 ? (target - cumPop[b]) / segCount : 0;
      y = (cumWealth[b] + frac * hist[b] * mapping.binCenterAsset(b, HIST_BINS)) / denom;
      if (y < 0) y = 0;
      else if (y > 1) y = 1;
    }
    out[k * 2] = x;
    out[k * 2 + 1] = y;
  }
  out[100] = 1;
  out[101] = 1;
  return out;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function pushSeries(list, value, cap) {
  list.push(value);
  if (list.length > cap) list.splice(0, list.length - cap);
}

/** 创建 mock 数据源（app.js 使用） */
export function createMockBackend(opts) {
  return new MockBackend(opts);
}

/** 供测试/自检：导出一份默认配置与预设 */
export { DEFAULT_CONFIG as MOCK_DEFAULT_CONFIG, PRESETS as MOCK_PRESETS };
