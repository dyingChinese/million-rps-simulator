/**
 * events.js — 宏观调控（模式 1~4 + 保底）、瘟疫与系统记账
 *
 * 模块职责：
 *  1. 由引擎每回合调用一次 `tickEvents(store, state, ctx)`，按 `cfg.macro` 的时间表判断
 *     是否触发「均衡 / 再分配 / 灾难 / 分红 / 保底」五类宏观调控；
 *  2. 推进瘟疫状态机（按概率激活 → 每回合感染/资产损伤/产生抗体/低资产额外死亡 → 结束）；
 *  3. `triggerManual` 供 UI 按钮/测试手动触发任意一个事件（忽略开关、时间表与概率）；
 *  4. 直接修改 store 的资产/瘟疫字段并维护 `ctx.pool` 记账；**不扩容、不重建 aliveList、不回收槽位**。
 *
 * 记账口径（与引擎/统计对齐）：
 *  - `report.created`  ：本回合系统「注入」个体经济的钱（分红 / 保底补助，含从资金池支取的部分）；
 *  - `report.destroyed`：本回合从个体经济「蒸发」的钱（灾难缩水 / 瘟疫资产损伤）；
 *  - 转移类调控（均衡 / 再分配）总量守恒，`created/destroyed` 记 0；
 *  - `ctx.pool.created / ctx.pool.destroyed` 是**累计**统计，与 report 同步累加；
 *  - 资源有限模式（cfg.resourceLimited）下，福利类事件优先从 `ctx.pool.amount` 支取，
 *    池子不足时按比例缩减（保底）或逐人跳过（分红）；池子为 0 时整件事跳过；
 *  - 分红 / 保底的名义金额随通胀指数化（× 当前成本 / 基础成本，见 nominalScale），
 *    保持真实购买力不变，避免长期跑（成本上涨）后福利实际缩水导致经济二次通缩；
 *    均衡 / 再分配是内部转移、灾难是百分比，均不需要缩放；资金池支取逻辑不变。
 *
 * 死亡处理（与引擎约定）：
 *  - 本模块**不调用 store.freeSlot**：瘟疫低资产额外死亡时仅置 `alive=0 / frozen=0`，
 *    并把槽位号追加到 `report.deadSlots`（同一回合多次触发会汇总到同一数组）；
 *    由引擎在本回合统一走 `_processDeaths` 做资产核销/遗产分配/槽位回收，
 *    以保证「总资产 = 初始 + created - destroyed」口径守恒；
 *  - 死亡者的资产在本模块内保持不变（不蒸发、不清零）；`report.created/destroyed`
 *    只统计事件本身造成的注入与蒸发。
 *  - 因此 `report.deaths` 的语义在本项目中调整为「本函数内**标记死亡**的个体数」，
 *    恒等于 `report.deadSlots.length`（不再是 `store.freeSlot` 调用次数）。
 *
 * 性能约定：
 *  - 只遍历 `ctx.aliveList`，对每个个体做 O(1) 操作；逐个体循环内不创建对象/闭包；
 *  - 需要分位数时用 `rng.int(aliveCount)` 随机采样（样本 ≤ MAX_QUANTILE_SAMPLES=20000）
 *    后只对采样值排序，**绝不整库排序**；采样缓冲与分位缓存都复用 state 内预分配对象；
 *  - 概率型事件（灾难/感染/抗体/额外死亡）每个个体只掷一次骰子；**分红**不做逐人掷骰，
 *    而是按 affectedPct 比例做 O(k) 抽样：小人口（n ≤ 65536）用精确部分洗牌；大人口用
 *    查表几何间隔抽样（逐人 Bernoulli 过程的等价 O(k) 实现，顺序访问 aliveList、边抽边发），
 *    以 4σ 超采样率保证命中人数精确为 k（1M 人口一次约 2.5~3ms，优化前逐人掷骰约 13ms）；
 *    下标缓冲 / 命中缓冲 / 分位表全部复用 state 内预分配 TypedArray，不逐事件分配大数组；
 *  - 事件文案只在真正触发时拼接，平时零字符串开销。
 *
 * 扩展字段（契约之外的返回值，引擎可选用）：`deadSlots`（本回合被标记死亡的槽位号数组，
 * 无死亡时为空数组）、`infected`（当前感染者数）、`newInfections`（本回合新增感染）、
 * `antibodies`（本回合新增抗体人数）、`plagueActive`。
 *
 * @module events
 */

/** 分位数采样上限（契约要求 ≤ 20000） */
const MAX_QUANTILE_SAMPLES = 20000;
/** 保底补助人群阈值缓存的刷新间隔（回合）；期间阈值近似复用，避免每回合排序采样 */
const SUBSIDY_CACHE_ROUNDS = 32;
/** 分红抽样：n ≤ 该阈值时用「精确部分洗牌」（小样本随机访问代价可忽略，分布精确） */
const SMALL_SAMPLING_MAX = 65536;
/** 分红大样本抽样：几何间隔分位表的桶数（4096 桶 ≈ 12 位随机数，命中期望偏差 < 0.01%） */
const GEOM_TABLE_SIZE = 4096;

/**
 * 名义金额随通胀缩放：当前成本 / 基础成本（= cost × inflationFactor / roundCost）。
 *
 * 红利 / 保底属于「名义金额固定」的福利：若不随通胀放大，长期跑（约 1300+ 回合、成本涨 35%+）
 * 会因真实购买力缩水而让经济重新转为通缩。这里按当前成本水平等比放大，保持真实购买力不变。
 * 其它事件（均衡/再分配是内部转移；灾难是百分比）不需要缩放。
 *
 * ctx.cost 或 cfg.roundCost 非法/缺失时回退为 1（不缩放）。
 *
 * @param {object} ctx 引擎上下文
 * @returns {number} 名义金额缩放系数（≈ 1 + 累计通胀率）
 */
function nominalScale(ctx) {
  const base = ctx.cfg && ctx.cfg.roundCost > 0 ? ctx.cfg.roundCost : 0;
  const cost = ctx.cost > 0 ? ctx.cost : base;
  return base > 0 && cost > 0 ? cost / base : 1;
}

/**
 * 事件系统内部状态（每局一个，由 createEventSystem 创建）。
 * @typedef {object} EventSystemState
 * @property {{active:boolean,roundsLeft:number,infected:number,newInfections:number}} plague 瘟疫状态
 * @property {{average:number,redistribute:number,disaster:number,dividend:number,subsidy:number,plague:number}} lastFire 各事件最近触发回合
 * @property {{created:number,destroyed:number,deaths:number,events:number,plagueInfections:number,plagueDeaths:number}} counters 累计计数
 * @property {Float64Array} samples 分位数采样缓冲（复用）
 * @property {{round:number,aliveCount:number,count:number,p:number,value:number}} quantCache 保底阈值缓存
 * @property {Int32Array} shuffleBuf 分红小样本（n ≤ 65536）精确部分洗牌的位置下标缓冲（懒增长复用）
 * @property {Uint32Array} shuffleEpoch 位置是否已在本次洗牌中初始化的标记（懒初始化，O(k) 抽样）
 * @property {number} shuffleEpochCur 当前洗牌轮次号（每触发一次分红 +1）
 * @property {Int32Array} geomTable 大样本几何间隔抽样分位表（4096 桶，均值已校正）
 * @property {number} geomP 分位表对应的命中率 p（-1 = 未构建；变化超过 2e-4 才重建）
 */

/**
 * 创建一局的事件系统状态。
 *
 * @param {object} cfg 归一化配置（createConfig 结果）
 * @returns {EventSystemState} 事件系统状态
 */
export function createEventSystem(cfg) {
  const m = cfg.macro;
  const p = cfg.plague;
  return {
    plague: { active: false, roundsLeft: 0, infected: 0, newInfections: 0 },
    lastFire: {
      average: m.average.startRound - m.average.everyRounds,
      redistribute: m.redistribute.startRound - m.redistribute.everyRounds,
      disaster: m.disaster.startRound - m.disaster.everyRounds,
      dividend: m.dividend.startRound - m.dividend.everyRounds,
      subsidy: m.subsidy.startRound - m.subsidy.everyRounds,
      plague: p.startRound - p.everyRounds,
    },
    counters: {
      created: 0,
      destroyed: 0,
      deaths: 0,
      events: 0,
      plagueInfections: 0,
      plagueDeaths: 0,
    },
    // 分位数采样缓冲：每次触发复用，避免在百万级快照/事件路径上分配大数组
    samples: new Float64Array(MAX_QUANTILE_SAMPLES),
    // 保底补助的「最穷 N 人」资产阈值缓存（近似分位，按回合/人口变化刷新）
    quantCache: { round: -1, aliveCount: -1, count: -1, p: 0, value: 0 },
    // 分红小样本（n ≤ SMALL_SAMPLING_MAX）的精确部分洗牌缓冲：容量随存活人数懒增长、跨事件复用，
    // 配合 shuffleEpoch 的懒初始化实现 O(k) 抽样（不必每次 fill 0..n-1）
    shuffleBuf: new Int32Array(0),
    shuffleEpoch: new Uint32Array(0),
    shuffleEpochCur: 0,
    // 分红大样本（n > SMALL_SAMPLING_MAX）的几何间隔抽样：
    //   geomTable —— 几何间隔 gap 的分位查表（12 位随机数 → gap），均值已校正；
    //   geomP     —— 当前分位表对应的命中率（变化超过 2e-4 才重建，约 0.1ms）
    geomTable: new Int32Array(GEOM_TABLE_SIZE),
    geomP: -1,
  };
}

/**
 * 创建一份空事件报告。
 * @returns {{events:Array<object>,created:number,destroyed:number,deaths:number,deadSlots:number[],plagueActive:boolean,infected:number,newInfections:number,antibodies:number}}
 */
function freshReport() {
  return {
    events: [],
    created: 0,
    destroyed: 0,
    deaths: 0,
    // —— 契约之外的扩展字段（引擎可选用）——
    // 本回合被标记死亡（alive=0）的槽位号；引擎统一走 _processDeaths 清算资产/回收槽位
    deadSlots: [],
    plagueActive: false,
    infected: 0,
    newInfections: 0,
    antibodies: 0,
  };
}

/**
 * 记录一条事件（受 cfg.performance.eventLogSize 限制）。
 * 只在事件真正触发时调用，字符串拼接开销可忽略。
 *
 * @param {object} report 事件报告
 * @param {object} ctx 引擎上下文
 * @param {string} type 事件类型（如 macro.disaster）
 * @param {string} title 中文标题
 * @param {string} detail 中文详情
 * @param {number} delta 对总财富的净影响（created 为正 / destroyed 为负）
 * @returns {void}
 */
function emit(report, ctx, type, title, detail, delta) {
  const max = ctx.cfg.performance.eventLogSize;
  if (report.events.length >= max) return;
  report.events.push({ round: ctx.round, type, title, detail, delta });
}

/**
 * 周期判定：到达 startRound 且距上次触发满 everyRounds 时返回 true（并记录本次触发回合）。
 * 概率型事件也先占用周期（即「每 everyRounds 回合掷一次骰子」）。
 *
 * @param {EventSystemState} state 事件系统状态
 * @param {string} key lastFire 键名
 * @param {number} round 当前回合
 * @param {{startRound:number,everyRounds:number}} conf 事件配置
 * @returns {boolean} 是否到点
 */
function due(state, key, round, conf) {
  if (round < conf.startRound) return false;
  if (round - state.lastFire[key] < conf.everyRounds) return false;
  state.lastFire[key] = round;
  return true;
}

/**
 * 填充资产分位采样：存活数 ≤ 20000 时全量拷贝（小规模下分位精确），
 * 否则用 rng.int 均匀随机采样；随后只对采样值排序。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @returns {number} 采样数量（samples[0..n-1] 已升序）
 */
function fillAssetSample(store, state, ctx) {
  const n = ctx.aliveCount;
  const target = n < MAX_QUANTILE_SAMPLES ? n : MAX_QUANTILE_SAMPLES;
  const buf = state.samples;
  const list = ctx.aliveList;
  const assets = store.assets;
  if (n <= MAX_QUANTILE_SAMPLES) {
    for (let i = 0; i < target; i++) buf[i] = assets[list[i]];
  } else {
    const rng = ctx.rng;
    for (let i = 0; i < target; i++) buf[i] = assets[list[rng.int(n)]];
  }
  buf.subarray(0, target).sort();
  return target;
}

/**
 * 从已排序的采样数组取近似分位数（下分位口径：第 floor(p·(n-1)) 个）。
 * @param {EventSystemState} state 事件系统状态
 * @param {number} n 采样数量
 * @param {number} p 分位（0~1）
 * @returns {number} 近似分位值
 */
function sampleQuantile(state, n, p) {
  if (n <= 0) return 0;
  let i = Math.floor(p * (n - 1));
  if (i < 0) i = 0;
  else if (i > n - 1) i = n - 1;
  return state.samples[i];
}

/**
 * 取「最穷 count 人」的资产阈值（带缓存：人口变化不大时 32 回合内复用上次采样结果）。
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {number} count 目标人数
 * @returns {number} 近似阈值（资产 ≤ 该值视为补助对象）
 */
function subsidyThreshold(store, state, ctx, count) {
  const cache = state.quantCache;
  const n = ctx.aliveCount;
  const round = ctx.round;
  const aliveClose =
    cache.aliveCount > 0 && Math.abs(cache.aliveCount - n) <= Math.max(1, cache.aliveCount * 0.02);
  if (cache.round >= 0 && round - cache.round < SUBSIDY_CACHE_ROUNDS && cache.count === count && aliveClose) {
    return cache.value;
  }
  const sampled = fillAssetSample(store, state, ctx);
  const p = n > 1 ? count / n : 0;
  const value = sampled > 0 ? sampleQuantile(state, sampled, p) : 0;
  cache.round = round;
  cache.aliveCount = n;
  cache.count = count;
  cache.p = p;
  cache.value = value;
  return value;
}

/**
 * 模式 1：均衡调控。
 * 两遍遍历：第一遍征收所有个体的 takePct% 正资产进「池子」，第二遍把池子均分给全体存活者。
 * 总量守恒（created/destroyed 记 0），是温和的向下再分配。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function fireAverage(store, state, ctx, report) {
  const conf = ctx.cfg.macro.average;
  const n = ctx.aliveCount;
  const rate = conf.takePct / 100;
  if (n <= 0 || !(rate > 0)) return;
  const list = ctx.aliveList;
  const assets = store.assets;
  let poolSum = 0;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    const a = assets[s];
    if (a > 0) {
      const cut = a * rate;
      assets[s] = a - cut;
      poolSum += cut;
    }
  }
  if (!(poolSum > 0)) return;
  const share = poolSum / n;
  for (let i = 0; i < n; i++) assets[list[i]] += share;
  emit(
    report,
    ctx,
    'macro.average',
    '均衡调控',
    `征收全体 ${conf.takePct}% 正资产共 ${poolSum.toFixed(0)}，均分给 ${n} 名存活者（每人 +${share.toFixed(2)}）`,
    0
  );
}

/**
 * 模式 2：再分配调控。
 * 采样近似分位得到「最富 topPct%」与「最穷 bottomPct%」的资产阈值，
 * 向最富者征收 takePct% 资产，均分给最穷者（总量守恒，lastFire 之外的随机只用于分位采样）。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function fireRedistribute(store, state, ctx, report) {
  const conf = ctx.cfg.macro.redistribute;
  const n = ctx.aliveCount;
  if (n < 2 || !(conf.takePct > 0)) return;
  let topPct = conf.topPct;
  let bottomPct = conf.bottomPct;
  if (topPct <= 0 || bottomPct <= 0) return;
  if (topPct + bottomPct > 100) bottomPct = Math.max(0, 100 - topPct);
  const sampled = fillAssetSample(store, state, ctx);
  if (sampled <= 1) return;
  const qTop = sampleQuantile(state, sampled, (100 - topPct) / 100);
  const qBottom = sampleQuantile(state, sampled, bottomPct / 100);
  if (!(qTop > qBottom)) return; // 分位区间退化（资产几乎相同），跳过本次调控
  const list = ctx.aliveList;
  const assets = store.assets;

  // 第一遍：确定接收者规模（在征税前统计，避免征税后阈值漂移）
  let bottomN = 0;
  for (let i = 0; i < n; i++) {
    if (assets[list[i]] <= qBottom) bottomN++;
  }
  if (bottomN <= 0) return;

  // 第二遍：向最富者征收
  const rate = conf.takePct / 100;
  let takeSum = 0;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    const a = assets[s];
    if (a > qTop) {
      const cut = a * rate;
      assets[s] = a - cut;
      takeSum += cut;
    }
  }
  if (!(takeSum > 0)) return;

  // 第三遍：均分给最穷者；最后一人吸收浮点余数，保证发出总额精确等于征收总额
  const per = takeSum / bottomN;
  const lastPay = takeSum - per * (bottomN - 1);
  let given = 0;
  for (let i = 0; i < n && given < bottomN; i++) {
    const s = list[i];
    if (assets[s] <= qBottom) {
      assets[s] += given === bottomN - 1 ? lastPay : per;
      given++;
    }
  }
  emit(
    report,
    ctx,
    'macro.redistribute',
    '再分配调控',
    `向最富 ${topPct}% 征收 ${conf.takePct}% 资产，均分给最穷 ${bottomPct}%（${bottomN} 人，每人 +${per.toFixed(2)}）`,
    0
  );
}

/**
 * 模式 3：随机灾难。
 * 对每个存活者按 affectedPct% 概率掷骰，命中者的正资产按 shrinkPct% 核销（资产蒸发）。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function fireDisaster(store, state, ctx, report) {
  const conf = ctx.cfg.macro.disaster;
  const n = ctx.aliveCount;
  const p = conf.affectedPct / 100;
  const rate = conf.shrinkPct / 100;
  if (n <= 0 || !(p > 0) || !(rate > 0)) return;
  const rng = ctx.rng;
  const list = ctx.aliveList;
  const assets = store.assets;
  let destroyed = 0;
  for (let i = 0; i < n; i++) {
    if (rng.float() >= p) continue;
    const s = list[i];
    const a = assets[s];
    if (a > 0) {
      const cut = a * rate;
      assets[s] = a - cut;
      destroyed += cut;
    }
  }
  if (!(destroyed > 0)) return;
  report.destroyed += destroyed;
  ctx.pool.destroyed += destroyed;
  emit(
    report,
    ctx,
    'macro.disaster',
    '随机灾难',
    `随机 ${conf.affectedPct}% 个体正资产缩水 ${conf.shrinkPct}%，共核销 ${destroyed.toFixed(0)}`,
    -destroyed
  );
}

/**
 * 保证分红抽样缓冲容量 ≥ n（懒增长、倍增复用；重建时同步重置轮次号）。
 *
 * @param {EventSystemState} state 事件系统状态
 * @param {number} n 需要的容量（通常 = aliveCount）
 * @returns {void}
 */
function ensureShuffleCapacity(state, n) {
  if (state.shuffleBuf.length >= n) return;
  let cap = state.shuffleBuf.length > 0 ? state.shuffleBuf.length : 1024;
  while (cap < n) cap *= 2;
  state.shuffleBuf = new Int32Array(cap);
  state.shuffleEpoch = new Uint32Array(cap);
  state.shuffleEpochCur = 0;
}

/**
 * 开启一轮新的抽样轮次（用于 shuffleBuf 的懒初始化标记，避免每次事件 O(n) 清空）。
 * 轮次号到顶时整体清零一次（保证正确性；实际单局内不可能达到）。
 *
 * @param {EventSystemState} state 事件系统状态
 * @returns {number} 本轮次号
 */
function nextShuffleEpoch(state) {
  if (state.shuffleEpochCur >= 0xffffffff) {
    state.shuffleEpoch.fill(0);
    state.shuffleEpochCur = 0;
  }
  state.shuffleEpochCur++;
  return state.shuffleEpochCur;
}

/**
 * 构建大样本「几何间隔 gap」分位查表（4096 桶，12 位随机数一次查表即得 gap）。
 *
 * gap ~ Geom(p)：P(gap ≥ g) = (1-p)^g。用桶中点做逆变换 g = floor(ln(u)/ln(1-p))，
 * 再对整表做整数均值校正，使 E[gap] ≈ (1-p)/p（保证命中人数期望不变）。
 * 表建一次约 0.1ms；命中率变化 ≤ 2e-4 时复用旧表。
 *
 * @param {EventSystemState} state 事件系统状态
 * @param {number} p 命中率（0 < p < 1）
 * @returns {void}
 */
function buildGeomTable(state, p) {
  const table = state.geomTable;
  const lp = Math.log1p(-p);
  let sum = 0;
  for (let b = 0; b < GEOM_TABLE_SIZE; b++) {
    const u = 1 - (b + 0.5) / GEOM_TABLE_SIZE; // 桶中点的 U ∈ (0,1)
    let g = Math.floor(Math.log(u) / lp);
    if (g < 0) g = 0;
    table[b] = g;
    sum += g;
  }
  // 均值校正：分桶量化会带来微小偏差，整体平移保证期望不变
  const shift = Math.round((1 - p) / p - sum / GEOM_TABLE_SIZE);
  if (shift !== 0) {
    for (let b = 0; b < GEOM_TABLE_SIZE; b++) {
      const v = table[b] + shift;
      table[b] = v < 0 ? 0 : v;
    }
  }
  state.geomP = p;
}

/**
 * 模式 4：随机分红。
 *
 * 命中人数 k = round(aliveCount × affectedPct%)，命中者按人口规模分两条 O(k) 路径抽样
 * （避免对百万存活者逐个掷骰，1M 人口一次事件从 ~13ms 降到 ~3ms）：
 *  - n ≤ SMALL_SAMPLING_MAX(=65536)：精确不放回「部分 Fisher-Yates」——命中人数精确、
 *    分布精确、每人至多一次（小样本随机访问代价可忽略；缓冲 + epoch 懒初始化复用）；
 *  - n > SMALL_SAMPLING_MAX：查表「几何间隔抽样」（等价于逐人 Bernoulli 过程的 O(k) 实现，
 *    顺序访问 aliveList、无 O(n) 随机访问），以 4σ 超采样率边抽边发，
 *    正常情况命中人数精确为 k（扫完仍不足 k 人的极端概率 < 1e-4，届时按实际人数发放）。
 * 两种情况都会跳过 aliveList 中的死亡墓碑并继续补抽。
 *
 * 命中者获得 amount 元（系统凭空创造；资源有限模式下从资金池支取，池子不足则跳过剩余命中者）；
 * amount 按当前通胀水平指数化（× 当前成本/基础成本），保持真实购买力不变。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function fireDividend(store, state, ctx, report) {
  const cfg = ctx.cfg;
  const conf = cfg.macro.dividend;
  const n = ctx.aliveCount;
  const pct = conf.affectedPct;
  // 名义金额随通胀指数化：成本涨 35% → 红利也放大 35%
  const amount = conf.amount * nominalScale(ctx);
  if (n <= 0 || !(pct > 0) || !(amount > 0)) return;
  // 命中人数：按比例四舍五入，clamp 到 [0, aliveCount]
  const k = Math.min(n, Math.max(0, Math.round((n * pct) / 100)));
  if (k <= 0) return;
  const pool = ctx.pool;
  const fromPool = cfg.resourceLimited.enabled && cfg.resourceLimited.welfareFromPool;
  let avail = fromPool ? pool.amount : Infinity;
  if (fromPool && !(avail > 0)) return;
  const rng = ctx.rng;
  const list = ctx.aliveList;
  const alive = store.alive;
  const assets = store.assets;

  let created = 0;
  if (k >= n) {
    // 覆盖全体（affectedPct=100）：顺序发放，无需抽样
    for (let i = 0; i < n; i++) {
      const slot = list[i];
      if (alive[slot] === 0) continue;
      if (fromPool) {
        if (avail < amount) break;
        avail -= amount;
      }
      assets[slot] += amount;
      created += amount;
    }
  } else if (n <= SMALL_SAMPLING_MAX) {
    // 小样本：精确不放回部分 Fisher-Yates（O(k)，命中人数精确、分布精确）
    ensureShuffleCapacity(state, n);
    const buf = state.shuffleBuf;
    const epochs = state.shuffleEpoch;
    const epoch = nextShuffleEpoch(state);
    let selected = 0;
    for (let i = 0; selected < k && i < n; i++) {
      // 在 [i, n) 中随机取一个位置与 i 交换，再取 buf[i]
      const j = i + rng.int(n - i);
      if (epochs[i] !== epoch) {
        buf[i] = i; // 懒初始化：本事件首次访问该位置
        epochs[i] = epoch;
      }
      if (epochs[j] !== epoch) {
        buf[j] = j;
        epochs[j] = epoch;
      }
      const tmp = buf[i];
      buf[i] = buf[j];
      buf[j] = tmp;
      const slot = list[buf[i]];
      // 死亡墓碑（调用方尚未重建 aliveList）：跳过并继续补抽
      if (alive[slot] === 0) continue;
      if (fromPool) {
        if (avail < amount) break; // 资金池不足：剩余命中者不再发放
        avail -= amount;
      }
      assets[slot] += amount;
      created += amount;
      selected++;
    }
  } else {
    // 大样本：查表几何间隔抽样（O(k) 次查表、顺序访问、边抽边发）
    // 超采样率 pGen=(k+margin)/n 保证「扫完 aliveList 仍不足 k 人」的概率 < 1e-4；
    // 正常情况命中人数精确为 k、每人至多命中一次，无需额外缓冲/第二遍遍历。
    const p0 = k / n;
    const margin = Math.max(16, Math.ceil(4 * Math.sqrt(k * (1 - p0)) + 8));
    let pGen = (k + margin) / n;
    if (!(pGen < 1)) pGen = 0.999999; // 极端 affectedPct≈100% 的兜底
    if (state.geomP < 0 || Math.abs(state.geomP - pGen) > 2e-4) buildGeomTable(state, pGen);
    const table = state.geomTable;
    let selected = 0;
    let pos = -1;
    while (selected < k) {
      const g = table[rng.nextU32() >>> 20];
      pos += 1 + g;
      if (pos >= n) break; // 极端小概率：扫完仍未满 k 人，按实际人数发放
      const slot = list[pos];
      if (alive[slot] === 0) continue; // 死亡墓碑：跳过并继续补抽
      if (fromPool) {
        if (avail < amount) break; // 资金池不足：剩余命中者不再发放
        avail -= amount;
      }
      assets[slot] += amount;
      created += amount;
      selected++;
    }
  }

  if (!(created > 0)) return;
  if (fromPool) pool.amount = avail < 0 ? 0 : avail;
  report.created += created;
  pool.created += created;
  emit(
    report,
    ctx,
    'macro.dividend',
    '随机分红',
    `随机 ${pct}% 个体各获 ${amount} 元，共投放 ${created.toFixed(0)}`,
    created
  );
}

/**
 * 保底机制：给「最穷的 count 个」存活者每人补助 amount 元。
 *
 * 人数口径：`countPct > 0` 时按人口比例取 `count = max(1, min(n, round(n×countPct%)))`
 * （1M→2000 人、200k→400 人、5 万→100 人，各预设覆盖比例一致）；
 * `countPct = 0` 时回退到绝对人数 `conf.count`（兼容旧配置/测试）。
 *
 * 实现：用随机采样估计「最穷 count 人」的近似资产阈值（不排序全库），
 * 再从随机起点沿 aliveList 环扫，资产 ≤ 阈值者每人 +amount，发满 count 人为止。
 * amount 按当前通胀水平指数化（× 当前成本/基础成本），保持真实购买力不变。
 * 资源有限模式下从资金池按人数比例支取，池子不足时等比缩减。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function fireSubsidy(store, state, ctx, report) {
  const cfg = ctx.cfg;
  const conf = cfg.macro.subsidy;
  const n = ctx.aliveCount;
  const countPct = conf.countPct > 0 ? conf.countPct : 0;
  // 比例模式：按存活人口比例；绝对模式（countPct=0）：沿用 conf.count
  const count = countPct > 0
    ? Math.max(1, Math.min(n, Math.round((n * countPct) / 100)))
    : conf.count;
  // 名义金额随通胀指数化（与红利同口径），need/per 均使用缩放后的金额
  const amount = conf.amount * nominalScale(ctx);
  if (n <= 0 || count <= 0 || !(amount > 0)) return;
  const pool = ctx.pool;
  const fromPool = cfg.resourceLimited.enabled && cfg.resourceLimited.welfareFromPool;
  let per = amount;
  if (fromPool) {
    const avail = pool.amount;
    if (!(avail > 0)) return; // 资金池为空：跳过整件事
    const need = count * amount;
    per = avail < need ? avail / count : amount;
    if (!(per > 0)) return;
  }
  const list = ctx.aliveList;
  const assets = store.assets;
  const rng = ctx.rng;
  let given = 0;
  let paid = 0;
  if (count >= n) {
    // 覆盖全体：无需阈值，直接每人发放
    for (let i = 0; i < n; i++) {
      assets[list[i]] += per;
      paid += per;
    }
    given = n;
  } else {
    const threshold = subsidyThreshold(store, state, ctx, count);
    const start = rng.int(n);
    for (let step = 0; step < n && given < count; step++) {
      let idx = start + step;
      if (idx >= n) idx -= n;
      const s = list[idx];
      if (assets[s] <= threshold) {
        assets[s] += per;
        paid += per;
        given++;
      }
    }
  }
  if (given <= 0 || !(paid > 0)) return;
  if (fromPool) {
    const left = pool.amount - paid;
    pool.amount = left > 0 ? left : 0;
  }
  report.created += paid;
  pool.created += paid;
  emit(
    report,
    ctx,
    'macro.subsidy',
    '保底补助',
    `向最穷约 ${count} 名个体每人补助 ${per.toFixed(2)} 元（实际发放 ${given} 人），共投放 ${paid.toFixed(2)}`,
    paid
  );
}

/**
 * 激活/延长瘟疫（手动触发与概率触发共用）。
 * 持续回合数取 cfg.plague.everyRounds（契约未单独定义持续时长，这里取一个检查周期，见汇报）。
 *
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function activatePlague(state, ctx, report) {
  const pr = ctx.cfg.plague;
  const rounds = Math.max(1, pr.everyRounds);
  state.plague.active = true;
  state.plague.roundsLeft = rounds;
  state.plague.infected = 0;
  state.plague.newInfections = 0;
  emit(
    report,
    ctx,
    'plague.start',
    '瘟疫爆发',
    `持续 ${rounds} 回合：每回合 ${(pr.infectRate * 100).toFixed(1)}% 感染率，感染者流失 ${(
      pr.damagePct * 100
    ).toFixed(1)}% 正资产，${(pr.antibodyChance * 100).toFixed(1)}% 概率产生抗体`,
    0
  );
}

/**
 * 推进一个回合的瘟疫结算：新感染 / 资产损伤 / 低资产额外死亡 / 产生抗体。
 * 注意：本函数**不调用 store.freeSlot**；低资产死亡只置 `alive=0 / frozen=0` 并把槽位号
 * 追加到 `report.deadSlots`（同时计入 report.deaths），槽位资产留给引擎统一清算；
 * 不重建 aliveList、不回收槽位。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改，deathSlots 汇总到这里）
 * @returns {void}
 */
function applyPlagueRound(store, state, ctx, report) {
  const pr = ctx.cfg.plague;
  const rng = ctx.rng;
  const list = ctx.aliveList;
  const n = ctx.aliveCount;
  const alive = store.alive;
  const assets = store.assets;
  const debtLimit = store.debtLimit;
  const infected = store.infected;
  const immunity = store.immunity;
  const infectionRound = store.infectionRound;
  const round = ctx.round;
  const infectRate = pr.infectRate;
  const damagePct = pr.damagePct;
  const antibodyChance = pr.antibodyChance;
  const extraDeath = pr.lowWealthExtraDeath;
  const canInfect = infectRate > 0;
  const canDamage = damagePct > 0;
  const canAntibody = antibodyChance > 0;
  const canDie = extraDeath > 0;
  let infectedCount = 0;
  let newInfections = 0;
  let antibodies = 0;
  let destroyed = 0;
  let deaths = 0;

  for (let i = 0; i < n; i++) {
    const s = list[i];
    // 防御：调用方若未重建 aliveList（如连续两次 tick），已死亡槽位不再重复结算
    if (alive[s] === 0) continue;
    if (immunity[s]) continue; // 有抗体：不感染、不损伤
    if (infected[s]) {
      infectedCount++;
      // 1) 正资产按 damagePct 流失（核销）
      if (canDamage) {
        const a = assets[s];
        if (a > 0) {
          const cut = a * damagePct;
          assets[s] = a - cut;
          destroyed += cut;
        }
      }
      // 2) 低资产（资产 < 自身负债上限 × 0.5）可能直接死亡：
      //    只标记死亡并把槽位交给引擎统一清算（不 freeSlot、不清零资产）
      if (canDie && assets[s] < debtLimit[s] * 0.5 && rng.float() < extraDeath) {
        alive[s] = 0;
        store.frozen[s] = 0;
        report.deadSlots.push(s);
        deaths++;
        continue;
      }
      // 3) 按概率产生抗体并痊愈
      if (canAntibody && rng.float() < antibodyChance) {
        immunity[s] = 1;
        infected[s] = 0;
        antibodies++;
      }
    } else if (canInfect && rng.float() < infectRate) {
      infected[s] = 1;
      infectionRound[s] = round;
      newInfections++;
    }
  }

  if (destroyed > 0) {
    report.destroyed += destroyed;
    ctx.pool.destroyed += destroyed;
  }
  if (deaths > 0) report.deaths += deaths;
  state.counters.plagueInfections += newInfections;
  state.counters.plagueDeaths += deaths;
  state.plague.infected = infectedCount;
  state.plague.newInfections = newInfections;
  report.infected = infectedCount;
  report.newInfections = newInfections;
  report.antibodies = antibodies;
}

/**
 * 每回合推进瘟疫状态机：爆发中则结算一回合并递减计时；否则按时间表+概率尝试激活。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state 事件系统状态
 * @param {object} ctx 引擎上下文
 * @param {object} report 事件报告（原地修改）
 * @returns {void}
 */
function tickPlague(store, state, ctx, report) {
  const pr = ctx.cfg.plague;
  const ps = state.plague;
  if (ps.active) {
    applyPlagueRound(store, state, ctx, report);
    ps.roundsLeft--;
    if (ps.roundsLeft <= 0) {
      ps.roundsLeft = 0;
      ps.active = false;
      emit(
        report,
        ctx,
        'plague.end',
        '瘟疫结束',
        `累计感染 ${state.counters.plagueInfections} 人，累计病亡 ${state.counters.plagueDeaths} 人`,
        0
      );
    }
    return;
  }
  if (!pr.enabled) return;
  if (!due(state, 'plague', ctx.round, pr)) return;
  if (!(pr.probability > 0) || ctx.rng.float() >= pr.probability) return;
  activatePlague(state, ctx, report);
}

/**
 * 每回合调用一次：按 cfg.macro 时间表触发宏观调控，并推进瘟疫。
 *
 * 触发顺序（固定，保证同 seed 可复现）：均衡 → 保底 → 再分配 → 灾难 → 分红 → 瘟疫。
 * 瘟疫放在最后，因为它可能标记死亡槽位（写入 report.deadSlots），避免本回合其它调控
 * 继续操作刚死亡的个体。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state createEventSystem 返回的状态
 * @param {object} ctx 引擎上下文
 * @param {object} ctx.cfg 归一化配置
 * @param {import('./rng.js').Rng} ctx.rng 模拟随机源
 * @param {number} ctx.round 当前回合
 * @param {Int32Array} ctx.aliveList 存活 slot 表
 * @param {number} ctx.aliveCount 存活数量
 * @param {number} ctx.cost 当前（含通胀）单次猜拳成本（本模块不使用，保留给引擎）
 * @param {number} ctx.totalWealth 本回合开始总资产（近似；本模块不使用，保留给引擎）
 * @param {{amount:number,created:number,destroyed:number}} ctx.pool 系统资金池与累计记账（可修改）
 * @returns {{events:Array<{round:number,type:string,title:string,detail:string,delta:number}>,created:number,destroyed:number,deaths:number,deadSlots:number[]}} 事件报告
 */
export function tickEvents(store, state, ctx) {
  const cfg = ctx.cfg;
  const report = freshReport();
  if (ctx.aliveCount <= 0) {
    report.plagueActive = state.plague.active;
    return report;
  }
  const round = ctx.round;
  const m = cfg.macro;
  if (m.average.enabled && due(state, 'average', round, m.average)) {
    fireAverage(store, state, ctx, report);
  }
  if (m.subsidy.enabled && due(state, 'subsidy', round, m.subsidy)) {
    fireSubsidy(store, state, ctx, report);
  }
  if (m.redistribute.enabled && due(state, 'redistribute', round, m.redistribute)) {
    fireRedistribute(store, state, ctx, report);
  }
  const disaster = m.disaster;
  if (
    disaster.enabled &&
    due(state, 'disaster', round, disaster) &&
    ctx.rng.float() < disaster.probability
  ) {
    fireDisaster(store, state, ctx, report);
  }
  const dividend = m.dividend;
  if (
    dividend.enabled &&
    due(state, 'dividend', round, dividend) &&
    ctx.rng.float() < dividend.probability
  ) {
    fireDividend(store, state, ctx, report);
  }
  // 瘟疫最后结算：可能标记死亡槽位（写入 report.deadSlots，交由引擎统一清算）
  tickPlague(store, state, ctx, report);

  state.counters.created += report.created;
  state.counters.destroyed += report.destroyed;
  state.counters.deaths += report.deaths;
  state.counters.events += report.events.length;
  report.plagueActive = state.plague.active;
  return report;
}

/**
 * 手动触发某个宏观调控/瘟疫（UI 按钮、演示与测试用）。
 * 手动触发忽略 enabled 开关、时间表与 probability；资源有限模式下的资金池限制仍然生效。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {EventSystemState} state createEventSystem 返回的状态
 * @param {object} ctx 引擎上下文（同 tickEvents）
 * @param {'average'|'redistribute'|'disaster'|'dividend'|'subsidy'|'plague'} kind 事件类型
 * @returns {{events:Array<{round:number,type:string,title:string,detail:string,delta:number}>,created:number,destroyed:number,deaths:number,deadSlots:number[]}} 事件报告
 */
export function triggerManual(store, state, ctx, kind) {
  const report = freshReport();
  switch (kind) {
    case 'average':
      fireAverage(store, state, ctx, report);
      break;
    case 'redistribute':
      fireRedistribute(store, state, ctx, report);
      break;
    case 'disaster':
      fireDisaster(store, state, ctx, report);
      break;
    case 'dividend':
      fireDividend(store, state, ctx, report);
      break;
    case 'subsidy':
      fireSubsidy(store, state, ctx, report);
      break;
    case 'plague':
      activatePlague(state, ctx, report);
      break;
    default:
      throw new Error(`未知宏观调控类型: ${kind}`);
  }
  state.counters.created += report.created;
  state.counters.destroyed += report.destroyed;
  state.counters.deaths += report.deaths;
  state.counters.events += report.events.length;
  report.plagueActive = state.plague.active;
  return report;
}
