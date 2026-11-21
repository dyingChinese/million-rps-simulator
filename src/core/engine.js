/**
 * engine.js — 模拟引擎核心（百万级智能体石头剪刀布演化经济模拟）
 *
 * 每回合（tick）流程：
 *   1. 通胀更新（成本 × 通胀因子）
 *   2. 世界事件（宏观调控 / 瘟疫 / 保底）
 *   3. 个体阶段：年龄增长、负债计息、自然死亡、破产判定、冻结/解冻
 *   4. 匹配对战：随机 / 资产相近 / 策略相近 配对 → 出拳 → 成本 → 赌注结算 → 学习/模仿/逆反
 *   5. 破产清算（负资产核销 / 可选分配给最近对手）
 *   6. 繁殖：满足条件的两两结合 → 基因遗传+突变 → 新生个体
 *   7. 汇总：重建存活表、总资产/极值、结束条件、追踪记录、统计快照钩子
 *
 * 性能设计：
 *   - 数据全部为 SoA TypedArray（见 store.js），热路径零对象分配。
 *   - 配对用 O(n) 桶排序 / 部分洗牌，不做全量排序。
 *   - 所有循环局部缓存数组引用（V8 友好），只在 store 可能扩容处重新读取。
 */

import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { Rng } from './rng.js';
import { AgentStore, GENE_COUNT, STATS_STRIDE, STATS_WINS, STATS_LOSSES } from './store.js';
import { createConfig, mergeConfig, normalizeConfig, classOf } from './config.js';
import * as talents from './talents.js';
import * as genetics from './genetics.js';
import { createFamilySystem, aggregateFamilies, familyForFounder } from './families.js';
import * as guilds from './guilds.js';
import { createEventSystem, tickEvents, triggerManual } from './events.js';
import { createAnalytics } from './analytics.js';
import { createTracker } from './tracking.js';
import { buildFrame } from './snapshot.js';
import { processBattleRange, resetOut, createOut } from './battle.js';
import { BattlePool } from './battle-pool.js';

/** 死亡类型 */
const DEATH_NATURAL = 0;
const DEATH_BANKRUPT = 1;

/** 这些配置字段变化时需要重置模拟（人口/资产尺度相关） */
const RESET_KEYS = ['seed', 'initialPopulation', 'maxPopulation', 'initialWealth', 'maxDebt', 'maxAge'];

const BACKSLASH = 0.8660254037844386; // √3/2

export class Engine {
  /** @param {object} cfg createConfig() 的结果 */
  constructor(cfg) {
    /** @type {object} */
    this.cfg = cfg;
    /** @type {'idle'|'running'|'paused'|'ended'} */
    this.status = 'idle';
    this.endReason = null;
    this.reset(cfg);
  }

  // ──────────────────────────────────────────────────────────────
  // 初始化 / 重置
  // ──────────────────────────────────────────────────────────────

  /**
   * 用给定配置重新开局。
   * @param {object} [cfg] 完整配置；缺省复用当前配置
   */
  reset(cfg) {
    if (cfg) this.cfg = normalizeConfig(cfg);
    const c = this.cfg;

    this.rng = new Rng(c.seed);
    this.round = 0;
    this.status = 'idle';
    this.endReason = null;
    this.tickMs = 0;
    this.initMs = 0;

    // 计数器（累计）
    this.births = 0;
    this.deaths = 0;
    this.bankruptcies = 0;
    this.naturalDeaths = 0;
    this.plagueDeaths = 0;
    this.created = 0;
    this.destroyed = 0;
    /** 资源有限模式的系统资金池 */
    this.pool = { amount: c.resourceLimited.enabled ? c.resourceLimited.initialPool : 0, created: 0, destroyed: 0 };

    this.inflationFactor = 1;
    this.cost = c.roundCost;

    this.totalWealth = 0;
    this.maxAsset = 0;
    this.aboveThreshold = 0;
    this.frozenCount = 0;
    this.negativeCount = 0;
    this.infectedCount = 0;
    this.antibodyCount = 0;
    this.noGrowthCounter = 0;
    this.prevTotalWealth = 0;

    this.familySys = createFamilySystem(c);
    this.guildSys = guilds.createGuildSystem(c);
    this.guildTreasury = 0;
    this.guildWars = 0;
    this._guildLevelShared = null;
    if (c.guilds.enabled && c.parallel.enabled) {
      // 并行对战 worker 需要读取公会等级 → 使用 SAB 视图（公会数量很小，开销可忽略）
      this._guildLevelShared = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * Math.max(1, this.guildSys.count)),
      );
    }
    this.eventSys = createEventSystem(c);
    this.analytics = createAnalytics(c);
    this.tracker = createTracker(c);

    this.eventLog = [];

    // 缓冲（按容量/人口上限预分配，避免热路径扩容）
    this._buffersCapacity = 0;
    this._ensureBuffers();
    this.deathCount = 0;
    this.moveUsage = new Int32Array(3);
    this.outcomes = { wins: 0, losses: 0, draws: 0 };
    this.avgBet = 0;
    this.avgWinStreak = 0;
    this.avgLossStreak = 0;
    this.participants = 0;

    // 复用的 summary 对象（analytics 每回合读取）
    this.summary = {
      round: 0,
      aliveCount: 0,
      births: 0,
      deaths: 0,
      bankruptcies: 0,
      frozenCount: 0,
      totalWealth: 0,
      maxAsset: 0,
      aboveThreshold: 0,
      cost: this.cost,
      inflationFactor: 1,
      moveUsage: this.moveUsage,
      outcomes: this.outcomes,
      avgBet: 0,
      avgWinStreak: 0,
      avgLossStreak: 0,
      pool: this.pool,
      plague: { enabled: !!c.plague.enabled, active: false, infected: 0, antibodies: 0 },
      events: this.eventLog,
      endCondition: { mode: c.endCondition.mode, label: '', progress: 0, ended: false, reason: null },
      perf: { tickMs: 0, roundsPerSec: 0, analyticsMs: 0 },
    };

    // 初始化种群
    const t0 = performance.now();
    this.store = new AgentStore(c._derived.initialCapacity, c);
    // store 的 shared 属性可能与本轮配置刚变更（并行开关），强制按新 store 重建工作缓冲
    this._buffersCapacity = 0;
    this._ensureBuffers();
    this._initPopulation();
    this.store.rebuildAliveList();
    this._aggregate();
    this.analytics.reset();
    this.initMs = performance.now() - t0;
    this.prevTotalWealth = this.totalWealth;
    this._updateEndCondition();
    this.summary.perf.tickMs = 0;

    // ── 并行对战线程池（可选；SharedArrayBuffer 支撑）──
    // 线程池**懒创建**：只有真正出现大规模对局（pairCount ≥ parallel.minPairs）时才启动 worker，
    // 避免小规模模拟（测试/小预设/开局）白白创建线程。
    if (this.battlePool) {
      this.battlePool.close();
      this.battlePool = null;
    }
    this._parallelBroken = false;
    this.configVersion = (this.configVersion || 0) + 1;
    this.parallelWorkers = 0;
    this._battleCtx = null;
    if (c.parallel.enabled && this.store.shared) {
      const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
      const auto = Math.max(0, Math.min(4, cores - 1));
      this.parallelWorkers = c.parallel.workers > 0 ? Math.min(c.parallel.workers, 16) : auto;
    }
    return this;
  }

  /** 生成初始种群（参数 1/12/13 + 天赋 + 家族 + 策略基因）。 */
  _initPopulation() {
    const c = this.cfg;
    const store = this.store;
    const rng = this.rng;
    const n = c.initialPopulation;
    const talOn = c.talents.enabled;
    const famOn = c.families.enabled;
    const guildOn = c.guilds.enabled;
    const g = store.gene;
    const initAsset = c.initialWealth;
    for (let i = 0; i < n; i++) {
      const s = store.alloc(0);
      // 天赋
      const t = talOn ? talents.rollTalent(rng, c) : 0;
      store.talent[s] = t;
      store.assets[s] = initAsset;
      store.debtLimit[s] = c.maxDebt * (talOn ? talents.debtLimitFactor(t, c) : 1);
      store.costAffinity[s] = talOn ? talents.costFactor(t, c) : 1;
      store.age[s] = rng.int(c.maxAge);
      store.generation[s] = 0;
      const off = s * GENE_COUNT;
      genetics.randomGenome(rng, c, g, off);
      if (famOn) {
        store.familyId[s] = familyForFounder(this.familySys, rng);
        store.maternalFamilyId[s] = familyForFounder(this.familySys, rng);
      } else {
        store.familyId[s] = 0;
        store.maternalFamilyId[s] = 0;
      }
      // 公会模式：按 joinChance 随机入会
      store.guild[s] = guildOn ? guilds.guildForNewAgent(this.guildSys, rng, c) : -1;
    }
    this.store.rebuildAliveList();
  }

  // ──────────────────────────────────────────────────────────────
  // 缓冲管理
  // ──────────────────────────────────────────────────────────────

  /** @private 保证所有工作缓冲不小于 store 容量 */
  _ensureBuffers() {
    const cap = Math.max(this.store ? this.store.capacity : this.cfg.maxPopulation, 16);
    if (this._buffersCapacity >= cap) return;
    // 并行模式：匹配池与死亡列表需要跨 worker 共享 → SharedArrayBuffer
    const shared = this.store ? this.store.shared : !!(this.cfg.parallel && this.cfg.parallel.enabled);
    const allocI32 = (len) => (shared ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * len)) : new Int32Array(len));
    const allocU8 = (len) => (shared ? new Uint8Array(new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * len)) : new Uint8Array(len));
    this.poolBuf = allocI32(cap);
    this.eligibleBuf = new Int32Array(cap);
    this.bucketOf = new Int32Array(cap);
    this.sortedPool = new Int32Array(cap);
    this.leftoverBuf = new Int32Array(cap);
    this.bucketCounts = new Int32Array(128);
    this.bucketCursor = new Int32Array(128);
    this.bucketStart = new Int32Array(128);
    this.deathList = allocI32(cap);
    this.deathTypes = allocU8(cap);
    this._buffersCapacity = cap;
  }

  /** 关闭引擎资源（并行线程池） */
  close() {
    if (this.battlePool) {
      this.battlePool.close();
      this.battlePool = null;
    }
    this.parallelWorkers = 0;
  }

  // ──────────────────────────────────────────────────────────────
  // 主循环
  // ──────────────────────────────────────────────────────────────

  /**
   * 运行一回合。
   * @returns {boolean} 是否已结束
   */
  tick() {
    if (this.status === 'ended') return true;
    const t0 = performance.now();
    this.round++;
    this._ensureBuffers();

    const phase = this.phaseMs || (this.phaseMs = { events: 0, individuals: 0, deaths: 0, battle: 0, reproduce: 0, aggregate: 0, other: 0 });
    let t = performance.now();
    this._updateInflation();
    this._applyWorldEvents();
    this._tickGuilds();
    phase.events = performance.now() - t;

    this.deathCount = 0;
    this.birthsThisRound = 0;
    this.deathsThisRound = 0;
    this.bankruptciesThisRound = 0;

    t = performance.now();
    this._individualPhase();
    phase.individuals = performance.now() - t;

    t = performance.now();
    this._processDeaths();
    this._battle();
    this._processDeaths();
    phase.battle = performance.now() - t;
    t = performance.now();
    this._reproduce();
    phase.reproduce = performance.now() - t;
    t = performance.now();
    this._finalize(t0);
    phase.aggregate = performance.now() - t;
    phase.other = performance.now() - t0 - phase.events - phase.individuals - phase.battle - phase.reproduce - phase.aggregate;
    return this.status === 'ended';
  }

  // ──────────────────────────────────────────────────────────────
  // 1. 通胀（参数 14）
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _updateInflation() {
    const inf = this.cfg.inflation;
    if (inf.rate <= 0 && !inf.dynamic) {
      this.cost = this.cfg.roundCost;
      return;
    }
    let rate = inf.rate;
    if (inf.dynamic && this.totalWealth > inf.dynamicTarget && this.totalWealth > 0) {
      // 总资产越大，通胀越快（上限 10 倍基础速率）
      rate *= Math.min(10, this.totalWealth / inf.dynamicTarget);
    }
    this.inflationFactor = Math.min(inf.maxFactor, this.inflationFactor * (1 + rate));
    this.cost = this.cfg.roundCost * this.inflationFactor;
  }

  // ──────────────────────────────────────────────────────────────
  // 2. 世界事件（宏观调控 + 瘟疫 + 保底）
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _applyWorldEvents() {
    const store = this.store;
    const ctx = {
      cfg: this.cfg,
      rng: this.rng,
      round: this.round,
      aliveList: store.aliveList,
      aliveCount: store.aliveCount,
      cost: this.cost,
      totalWealth: this.totalWealth,
      pool: this.pool,
    };
    const report = tickEvents(store, this.eventSys, ctx);
    if (report && report.events && report.events.length) {
      this._logEvents(report.events);
    }
    if (report) {
      if (report.created) this.created += report.created;
      if (report.destroyed) this.destroyed += report.destroyed;
      if (report.deaths) {
        this.plagueDeaths += report.deaths;
        this.deaths += report.deaths;
        this.deathsThisRound = (this.deathsThisRound || 0) + report.deaths;
      }
      // 瘟疫等事件标记死亡（alive=0）但资产仍在：由引擎统一清算并回收槽位
      if (report.deadSlots && report.deadSlots.length) this._settleExternalDeaths(report.deadSlots);
    }
  }

  /**
   * 清算由事件系统标记死亡的个体（瘟疫等）：
   * 正资产按自然死亡规则核销（或启用破产清算时分配给最近对手），负资产债务豁免，
   * 然后回收槽位。死亡计数已由调用方累计。
   * @private
   * @param {number[]} deadSlots 已标记 alive=0 的槽位列表
   */
  _settleExternalDeaths(deadSlots) {
    const store = this.store;
    const assets = store.assets;
    let created = 0;
    let destroyed = 0;
    const redistribution = this.cfg.balance.redistribution;
    for (let i = 0; i < deadSlots.length; i++) {
      const s = deadSlots[i];
      if (s < 0 || s >= store.count) continue;
      const asset = assets[s];
      if (asset > 0) {
        if (redistribution.enabled && store.lastOppK > 0) {
          if (!this._redistributeEstate(store, s, asset)) {
            const distributed = this._distributeEstateToRandomHeirs(store, asset, 3);
            if (distributed < asset) destroyed += asset - distributed;
          }
        } else {
          const distributed = this._distributeEstateToRandomHeirs(store, asset, 3);
          if (distributed < asset) destroyed += asset - distributed;
        }
      } else if (asset < 0) {
        created += -asset;
      }
      assets[s] = 0;
      store.freeSlot(s);
    }
    this.created += created;
    this.destroyed += destroyed;
  }

  /**
   * 公会模式每回合逻辑（世界事件之后、个体阶段之前调用）：
   * 缴金 → 破产兜底/开除 → 招收 → 等级更新 → 公会团体战。
   * 全部为资产转移（成员 ↔ 金库），不影响 created/destroyed。
   * @private
   */
  _tickGuilds() {
    const c = this.cfg;
    if (!c.guilds.enabled) return;
    const store = this.store;
    const report = guilds.tickGuilds(store, this.guildSys, this.rng, c, this.round);
    if (report) {
      if (report.events && report.events.length) this._logEvents(report.events);
      this.guildTreasury = report.treasuryTotal || 0;
      this.guildWars = this.guildSys.wars;
    }
    // 并行对战 worker 通过 SAB 视图读取公会等级，每回合同步一次（公会数 ≤256，开销可忽略）
    if (this._guildLevelShared) this._guildLevelShared.set(this.guildSys.level);
  }

  /** @private */
  _logEvents(events) {
    const max = this.cfg.performance.eventLogSize;
    for (let i = 0; i < events.length; i++) {
      this.eventLog.push(events[i]);
    }
    while (this.eventLog.length > max) this.eventLog.shift();
  }

  // ──────────────────────────────────────────────────────────────
  // 3. 个体阶段：衰老 / 利息 / 破产 / 冻结
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _individualPhase() {
    const store = this.store;
    const c = this.cfg;
    const list = store.aliveList;
    const n = store.aliveCount;
    const assets = store.assets;
    const debtLimit = store.debtLimit;
    const age = store.age;
    const frozen = store.frozen;
    const freezeUntil = store.freezeUntil;
    const deathList = this.deathList;
    const deathTypes = this.deathTypes;
    let deathCount = 0;
    let destroyed = 0;
    const maxAge = c.maxAge;
    const interestRate = c.interest.rate;
    const usuryThreshold = c.interest.usuryThreshold;
    const usuryMult = c.interest.usuryMultiplier;
    const newbieK = c.balance.newbieProtectRounds;
    const round = this.round;

    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (store.alive[s] === 0) continue;

      // 年龄增长与自然死亡（参数 13）
      const a = age[s] + 1;
      age[s] = a;
      if (a > maxAge) {
        store.alive[s] = 0;
        deathList[deathCount] = s;
        deathTypes[deathCount] = DEATH_NATURAL;
        deathCount++;
        continue;
      }

      let asset = assets[s];
      // 负债计息（参数 15，高利贷阈值）
      if (asset < 0) {
        let rate = interestRate;
        const dl = debtLimit[s];
        if (dl > 0 && -asset > dl * usuryThreshold) rate *= usuryMult;
        const interest = -asset * rate;
        asset -= interest;
        assets[s] = asset;
        destroyed += interest;
      }

      // 冻结状态处理（新手保护 / 破产冻结）
      if (frozen[s] === 1) {
        if (a >= newbieK || asset > -debtLimit[s]) {
          frozen[s] = 0;
        } else {
          continue; // 继续冻结：不参加匹配，也不重复判定
        }
      }

      // 破产判定（参数 2：资产 < -最大负债）
      if (asset < -debtLimit[s]) {
        if (a < newbieK) {
          frozen[s] = 1;
          freezeUntil[s] = round + 1;
        } else {
          store.alive[s] = 0;
          frozen[s] = 0;
          deathList[deathCount] = s;
          deathTypes[deathCount] = DEATH_BANKRUPT;
          deathCount++;
        }
      }
    }

    this.deathCount = deathCount;
    this.destroyed += destroyed;
  }

  // ──────────────────────────────────────────────────────────────
  // 5. 死亡处理（核销 / 破产清算）
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _processDeaths() {
    const count = this.deathCount;
    if (count === 0) return;
    const store = this.store;
    const assets = store.assets;
    const deathList = this.deathList;
    const deathTypes = this.deathTypes;
    const redistribution = this.cfg.balance.redistribution;
    let created = 0;
    let destroyed = 0;
    let bankruptcies = 0;
    let natural = 0;

    for (let i = 0; i < count; i++) {
      const s = deathList[i];
      const asset = assets[s];
      const type = deathTypes[i];
      if (type === DEATH_BANKRUPT) {
        bankruptcies++;
        if (asset < 0) {
          // 负资产由系统核销（债务豁免）：总资产增加 |asset|
          created += -asset;
        } else if (asset > 0) {
          if (redistribution.enabled && store.lastOppK > 0) {
            if (!this._redistributeEstate(store, s, asset)) destroyed += asset;
          } else {
            destroyed += asset;
          }
        }
        assets[s] = 0;
      } else {
        natural++;
        // 自然死亡：遗产由随机存活者继承（模拟遗产扩散 / 家族兴衰；规则文档未定义，
        // 这里采用「遗产不蒸发」的守恒设计），无存活者则核销。
        if (asset > 0) {
          const distributed = this._distributeEstateToRandomHeirs(store, asset, 3);
          if (distributed < asset) destroyed += asset - distributed;
        } else if (asset < 0) {
          created += -asset;
        }
        assets[s] = 0;
      }
      store.freeSlot(s);
    }

    this.created += created;
    this.destroyed += destroyed;
    this.bankruptcies += bankruptcies;
    this.naturalDeaths += natural;
    this.deaths += count;
    this.deathsThisRound = (this.deathsThisRound || 0) + count;
    this.deathCount = 0;
  }

  /**
   * 自然死亡遗产分配：随机挑选若干存活个体继承（不创建/销毁货币，总量守恒）。
   * @private
   * @param {import('./store.js').AgentStore} store
   * @param {number} asset 遗产总额（正数）
   * @param {number} maxHeirs 最多继承人数量
   * @returns {number} 实际分配出去的金额
   */
  _distributeEstateToRandomHeirs(store, asset, maxHeirs) {
    const aliveCount = store.aliveCount;
    if (aliveCount <= 0) return 0;
    const list = store.aliveList;
    const alive = store.alive;
    const assets = store.assets;
    const rng = this.rng;
    let heirs = 0;
    const target = Math.min(maxHeirs, aliveCount);
    const slots = this._heirScratch || (this._heirScratch = new Int32Array(8));
    for (let tries = 0; tries < target * 4 && heirs < target; tries++) {
      const cand = list[rng.int(aliveCount)];
      if (alive[cand] !== 1) continue;
      let dup = false;
      for (let k = 0; k < heirs; k++) {
        if (slots[k] === cand) {
          dup = true;
          break;
        }
      }
      if (!dup) slots[heirs++] = cand;
    }
    if (heirs === 0) return 0;
    const share = asset / heirs;
    for (let k = 0; k < heirs; k++) assets[slots[k]] += share;
    return share * heirs;
  }

  /**
   * 破产清算：剩余正资产按比例分配给最近 N 个对手。
   * @private
   * @returns {boolean} 是否分配成功
   */
  _redistributeEstate(store, slot, asset) {
    const k = store.lastOppK;
    const base = slot * k;
    const assets = store.assets;
    let aliveOpps = 0;
    for (let i = 0; i < k; i++) {
      const opp = store.lastOpp[base + i];
      if (opp >= 0 && store.alive[opp] === 1) aliveOpps++;
    }
    if (aliveOpps === 0) return false;
    const share = asset / aliveOpps;
    for (let i = 0; i < k; i++) {
      const opp = store.lastOpp[base + i];
      if (opp >= 0 && store.alive[opp] === 1) assets[opp] += share;
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────────
  // 4. 匹配与对战
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _battle() {
    const pool = this.poolBuf;
    const n = this._buildPool();
    this.participants = n;
    this.moveUsage.fill(0);
    this.outcomes.wins = 0;
    this.outcomes.losses = 0;
    this.outcomes.draws = 0;
    if (n < 2) {
      this.avgBet = 0;
      this.avgWinStreak = 0;
      this.avgLossStreak = 0;
      return;
    }
    const c = this.cfg;
    const mode = c.matching.mode;
    let pairCount;
    if (mode === 'random') {
      pairCount = this._pairRandom(n);
    } else if (mode === 'wealth') {
      pairCount = this._pairByWealth(n);
    } else {
      pairCount = this._pairByStrategy(n);
    }
    if (pairCount <= 0) return;

    const ctx = this._buildBattleCtx();
    const out = resetOut(this._battleOut || (this._battleOut = createOut()));

    // ── 并行路径：把 pair 区间切给多个 worker 线程结算（线程池懒创建）──
    if (this.parallelWorkers > 0 && pairCount >= c.parallel.minPairs && !this._parallelBroken) {
      if (!this.battlePool) this.battlePool = new BattlePool(this.parallelWorkers);
      const battlePool = this.battlePool;
      if (battlePool && !battlePool.broken) {
        const res = battlePool.run(
          ctx,
          this.store.arrayVersion,
          this.configVersion,
          this.store.capacity,
          pairCount,
          this.round,
          c.seed,
        );
        if (res) {
          this._applyBattleOutParallel(res);
          return;
        }
        // 并行失败（超时/异常）：标记后回退单线程，避免反复尝试
        this._parallelBroken = true;
        battlePool.close();
        this.battlePool = null;
        return;
      }
      if (battlePool && battlePool.broken) {
        this._parallelBroken = true;
        battlePool.close();
        this.battlePool = null;
      }
    }

    // ── 单线程路径 ──
    processBattleRange(ctx, out, 0, pairCount, this.rng);
    this._applyBattleOut(out);
  }

  /**
   * 并行对战结果落账：从共享死亡缓冲拷回引擎死亡列表，其余计数复用 _applyBattleOut。
   * @private
   * @param {{out: object, deaths: Array<{offset:number,count:number}>}} res
   */
  _applyBattleOutParallel(res) {
    const out = res.out;
    const pool = this.battlePool;
    const deathList = this.deathList;
    const deathTypes = this.deathTypes;
    let deathCount = 0;
    for (let w = 0; w < res.deaths.length; w++) {
      const { offset, count } = res.deaths[w];
      for (let i = 0; i < count; i++) {
        deathList[deathCount] = pool.deathListAll[offset + i];
        deathTypes[deathCount] = pool.deathTypesAll[offset + i];
        deathCount++;
      }
    }
    out.deathCount = deathCount;
    this.moveUsage[0] = out.move0;
    this.moveUsage[1] = out.move1;
    this.moveUsage[2] = out.move2;
    this._applyBattleOut(out);
  }

  /**
   * 构建/刷新对战上下文（热循环在 battle.js 中；此处只做引用与参数装配）。
   * @private
   * @returns {object} ctx
   */
  _buildBattleCtx() {
    const store = this.store;
    const c = this.cfg;
    const learning = c.learning;
    const talOn = c.talents.enabled;
    let ctx = this._battleCtx;
    if (!ctx) {
      ctx = this._battleCtx = {
        learnFactorArr: new Float32Array(6),
        lastOppK: 0,
      };
    }
    // 数组引用（store 扩容/重建后自动刷新）
    ctx.assets = store.assets;
    ctx.debtLimit = store.debtLimit;
    ctx.gene = store.gene;
    ctx.talent = store.talent;
    ctx.age = store.age;
    ctx.winStreak = store.winStreak;
    ctx.lossStreak = store.lossStreak;
    ctx.stats = store.stats;
    ctx.frozen = store.frozen;
    ctx.alive = store.alive;
    ctx.pool = this.poolBuf;
    ctx.moveUsage = this.moveUsage;
    ctx.deathList = this.deathList;
    ctx.deathTypes = this.deathTypes;
    ctx.lastOpp = store.lastOpp;
    ctx.lastOppPtr = store.lastOppPtr;
    ctx.lastOppK = store.lastOppK;
    // 参数
    ctx.cost = this.cost;
    ctx.baseBet = this.cost * c.betMultiplier;
    ctx.talOn = talOn;
    ctx.luckBonus = c.talents.effects.luckBonus;
    ctx.thriftyMul = 1 - c.talents.effects.thriftyCostReduce;
    ctx.softCapOn = c.balance.assetSoftCap.enabled;
    ctx.softCapThreshold = c.balance.assetSoftCap.threshold;
    ctx.softCapDecay = c.balance.assetSoftCap.decay;
    ctx.newbieK = c.balance.newbieProtectRounds;
    ctx.redistributeOn = c.balance.redistribution.enabled;
    ctx.taxToPool = c.resourceLimited.enabled && c.resourceLimited.taxToPool;
    ctx.classT0 = c._derived.classThresholds[0];
    ctx.classT1 = c._derived.classThresholds[1];
    ctx.classT2 = c._derived.classThresholds[2];
    ctx.learnOn = learning.enabled;
    ctx.lossTrigger = learning.lossTrigger;
    ctx.adjustStep = learning.adjustStep;
    ctx.reversalStreak = learning.reversalStreak;
    ctx.imitateChance = learning.imitateChance;
    ctx.imitateThreshold = learning.imitateThreshold;
    ctx.imitateBlend = learning.imitateBlend;
    ctx.penaltyEnabled = learning.winStreakPenalty.enabled;
    ctx.penaltyThreshold = learning.winStreakPenalty.threshold;
    ctx.penaltyChance = learning.winStreakPenalty.chance;
    // 公会模式：成员按公会等级享受成本折扣
    const gd = c.guilds;
    ctx.guildsOn = !!gd.enabled;
    ctx.guild = store.guild;
    ctx.guildLevel = this._guildLevelShared || this.guildSys.level;
    ctx.guildDiscountPerLevel = gd.costDiscountPerLevel;
    ctx.guildMaxDiscount = gd.costDiscountPerLevel * gd.maxLevel;
    for (let t = 0; t < 6; t++) ctx.learnFactorArr[t] = talOn ? talents.learnFactor(t, c) : 1;
    return ctx;
  }

  /**
   * 把对战输出累加器写回引擎状态。
   * @private
   * @param {object} out
   */
  _applyBattleOut(out) {
    this.deathCount = out.deathCount;
    this.destroyed += out.destroyed;
    this.pool.amount += out.poolDelta;
    this.outcomes.wins = out.wins;
    this.outcomes.losses = out.wins;
    this.outcomes.draws = out.draws;
    this.avgBet = out.betCount > 0 ? out.betSum / out.betCount : 0;
    this.avgWinStreak = out.wins > 0 ? out.winStreakSum / out.wins : 0;
    this.avgLossStreak = out.wins > 0 ? out.lossStreakSum / out.wins : 0;
  }

  /**
   * 构建匹配池：存活且未冻结的个体。
   * @private
   * @returns {number} 池内人数
   */
  _buildPool() {
    const store = this.store;
    const list = store.aliveList;
    const n = store.aliveCount;
    const frozen = store.frozen;
    const alive = store.alive;
    const pool = this.poolBuf;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (alive[s] === 1 && frozen[s] === 0) pool[m++] = s;
    }
    return m;
  }

  /**
   * 随机配对：部分 Fisher-Yates，每对只需一次随机数（O(n)）。
   * @private
   * @returns {number} 对数
   */
  _pairRandom(n) {
    const pool = this.poolBuf;
    const rng = this.rng;
    const pairs = (n / 2) | 0;
    for (let p = 0; p < pairs; p++) {
      const i = p + p;
      const j = i + rng.int(n - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pairs;
  }

  /**
   * 资产相近配对：按资产对数分桶（±wealthPct% 近似同桶），桶内相邻配对，奇数余数随机配对。
   * @private
   * @returns {number} 对数
   */
  _pairByWealth(n) {
    const c = this.cfg;
    const base = 1 + c.matching.wealthPct / 100;
    const logBase = Math.log(base);
    const maxB = 64;
    const store = this.store;
    const assets = store.assets;
    const pool = this.poolBuf;
    const bucketOf = this.bucketOf;
    const counts = this.bucketCounts;
    counts.fill(0, 0, maxB + 1);
    for (let i = 0; i < n; i++) {
      const a = assets[pool[i]];
      let b;
      if (a <= 0) b = 0;
      else {
        b = 1 + Math.floor(Math.log(a) / logBase);
        if (b < 0) b = 0;
        else if (b > maxB) b = maxB;
      }
      bucketOf[i] = b;
      counts[b]++;
    }
    return this._pairFromBuckets(n, maxB + 1);
  }

  /**
   * 策略相近配对：按策略基因在单纯形上的 2D 分桶，桶内相邻配对。
   * @private
   * @returns {number} 对数
   */
  _pairByStrategy(n) {
    const c = this.cfg;
    const side = Math.max(2, Math.round(Math.sqrt(c.matching.strategyBins || 16)));
    const bins = side * side;
    const store = this.store;
    const gene = store.gene;
    const pool = this.poolBuf;
    const bucketOf = this.bucketOf;
    const counts = this.bucketCounts;
    counts.fill(0, 0, bins);
    const scale = side;
    for (let i = 0; i < n; i++) {
      const off = pool[i] * GENE_COUNT;
      // stratX = p_paper + 0.5*p_scissors ; stratY = p_scissors*√3/2
      const pS = gene[off + 1];
      const pP = gene[off + 2];
      const sx = pP + 0.5 * pS;
      const sy = pS * BACKSLASH;
      let gx = (sx * scale) | 0;
      let gy = ((sy / BACKSLASH) * scale) | 0;
      if (gx < 0) gx = 0;
      else if (gx >= side) gx = side - 1;
      if (gy < 0) gy = 0;
      else if (gy >= side) gy = side - 1;
      const b = gy * side + gx;
      bucketOf[i] = b;
      counts[b]++;
    }
    return this._pairFromBuckets(n, bins);
  }

  /**
   * 桶内配对：对 pool 做计数排序 → 桶内相邻两两配对，各桶奇数尾数合并后随机配对。
   * @private
   * @returns {number} 对数
   */
  _pairFromBuckets(n, bins) {
    const counts = this.bucketCounts;
    const cursor = this.bucketCursor;
    const starts = this.bucketStart;
    const sorted = this.sortedPool;
    const pool = this.poolBuf;
    const leftover = this.leftoverBuf;
    const bucketOf = this.bucketOf;

    let offset = 0;
    for (let b = 0; b < bins; b++) {
      starts[b] = offset;
      cursor[b] = offset;
      offset += counts[b];
    }
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i];
      sorted[cursor[b]++] = pool[i];
    }

    // 桶内配对，奇数尾数进入 leftover
    const rng = this.rng;
    let pairs = 0;
    let leftCount = 0;
    for (let b = 0; b < bins; b++) {
      const start = starts[b];
      const end = start + counts[b];
      let i = start;
      for (; i + 1 < end; i += 2) {
        pool[pairs * 2] = sorted[i];
        pool[pairs * 2 + 1] = sorted[i + 1];
        pairs++;
      }
      if (i < end) leftover[leftCount++] = sorted[i];
    }

    // 余数随机配对
    const remaining = leftCount;
    const remPairs = (remaining / 2) | 0;
    for (let p = 0; p < remPairs; p++) {
      const i = p + p;
      const j = i + rng.int(remaining - i);
      const tmp = leftover[i];
      leftover[i] = leftover[j];
      leftover[j] = tmp;
      pool[pairs * 2] = leftover[i];
      pool[pairs * 2 + 1] = leftover[i + 1];
      pairs++;
    }
    return pairs;
  }

  // ──────────────────────────────────────────────────────────────
  // 6. 繁殖（遗传参数 6~10）
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _reproduce() {
    const c = this.cfg;
    const g = c.genetics;
    if (g.maxReproCount <= 0 || g.reproChancePerRound <= 0) return;
    const store = this.store;
    if (store.aliveCount >= c.maxPopulation) return;

    // 先按“最多可能出生数”一次性扩容，保证循环内 alloc 不会重建数组
    // （否则循环中缓存的 TypedArray 引用会失效）
    const maxBirths = Math.min(store.aliveCount >> 1, c.maxPopulation - store.aliveCount);
    if (maxBirths <= 0) return;
    store.ensureCapacity(store.count + maxBirths);
    this._ensureBuffers();

    const list = store.aliveList;
    const n = store.aliveCount;
    const alive = store.alive;
    const frozen = store.frozen;
    const assets = store.assets;
    const age = store.age;
    const reproCount = store.reproCount;
    const eligible = this.eligibleBuf;
    const threshold = g.reproWealthThreshold;
    const minAge = g.minReproAge;
    const maxCount = g.maxReproCount;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (alive[s] === 0 || frozen[s] === 1) continue;
      if (age[s] < minAge) continue;
      if (assets[s] <= threshold) continue;
      if (reproCount[s] >= maxCount) continue;
      eligible[m++] = s;
    }
    if (m < 2) return;

    const rng = this.rng;
    const chance = g.reproChancePerRound;
    const pairs = Math.min((m / 2) | 0, maxBirths);
    let births = 0;
    let destroyed = 0;
    let created = 0;
    let pop = store.aliveCount;

    for (let p = 0; p < pairs; p++) {
      if (pop + births >= c.maxPopulation) break;
      const i = p + p;
      const j = i + rng.int(m - i);
      const tmp = eligible[i];
      eligible[i] = eligible[j];
      eligible[j] = tmp;
      const a = eligible[i];
      const b = eligible[i + 1];
      if (alive[a] === 0 || alive[b] === 0) continue;
      // 每回合只有一定概率尝试繁殖（防止人口指数爆炸）
      if (rng.float() >= chance) continue;

      // 生育成本 = 基础费 + 父母资产 × 比例，生育达人减免
      const talOn = c.talents.enabled;
      const fA = talOn ? talents.birthCostFactor(store.talent[a], c) : 1;
      const fB = talOn ? talents.birthCostFactor(store.talent[b], c) : 1;
      const costA = (g.baseBirthCost + assets[a] * g.birthCostRatio) * fA;
      const costB = (g.baseBirthCost + assets[b] * g.birthCostRatio) * fB;
      if (!(costA >= 0) || !(costB >= 0)) continue;
      // 支付后不得跌破负债上限，否则繁殖失败
      if (assets[a] - costA < -store.debtLimit[a]) continue;
      if (assets[b] - costB < -store.debtLimit[b]) continue;

      assets[a] -= costA;
      assets[b] -= costB;
      destroyed += costA + costB;
      store.reproCount[a]++;
      store.reproCount[b]++;
      this._spawnChild(a, b, created);
      created += g.initialAsset > 0 ? g.initialAsset : 0;
      births++;
    }

    this.births += births;
    this.birthsThisRound = births;
    this.destroyed += destroyed;
    this.created += created;
  }

  /**
   * 生成后代（父母基因交叉 + 突变 + 天赋遗传 + 家族/谱系记录）。
   * @private
   */
  _spawnChild(a, b, created) {
    const c = this.cfg;
    const store = this.store;
    const rng = this.rng;
    const g = c.genetics;
    const slot = store.alloc(this.round);
    // alloc 可能扩容，这里重新读取数组引用
    const S = store;
    S.assets[slot] = g.initialAsset;
    const baseDebt = (S.debtLimit[a] + S.debtLimit[b]) * 0.5;
    S.debtLimit[slot] = Math.max(0, baseDebt * (1 + rng.gauss() * g.debtLimitMutation));
    S.costAffinity[slot] = (S.costAffinity[a] + S.costAffinity[b]) * 0.5;
    // 天赋遗传
    const talOn = c.talents.enabled;
    S.talent[slot] = talOn ? talents.inheritTalent(rng, S.talent[a], S.talent[b], c) : 0;
    // 策略基因遗传 + 突变
    genetics.inheritGenome(rng, S.gene, a * GENE_COUNT, S.gene, b * GENE_COUNT, c, S.gene, slot * GENE_COUNT);
    // 谱系：a 为父系（家族继承），b 为母系
    S.familyId[slot] = S.familyId[a];
    S.maternalFamilyId[slot] = S.familyId[b];
    const gen = Math.max(S.generation[a], S.generation[b]) + 1;
    S.generation[slot] = gen > 32767 ? 32767 : gen;
    S.parentA[slot] = a;
    S.parentAId[slot] = S.id[a];
    S.parentB[slot] = b;
    S.parentBId[slot] = S.id[b];
    S.birthRound[slot] = this.round;
    S.age[slot] = 0;
    S.frozen[slot] = 0;
    // 公会模式：后代继承父系公会（无则按 joinChance 随机入会）
    S.guild[slot] = c.guilds.enabled ? guilds.inheritGuild(this.guildSys, rng, S.guild[a], c) : -1;
    // 瘟疫抗体遗传
    if (c.plague.enabled && c.plague.heritable) {
      S.immunity[slot] = S.immunity[a] === 1 || S.immunity[b] === 1 ? (rng.chance(0.5) ? 1 : 0) : 0;
    } else {
      S.immunity[slot] = 0;
    }
    return slot;
  }

  // ──────────────────────────────────────────────────────────────
  // 7. 汇总 / 结束条件
  // ──────────────────────────────────────────────────────────────

  /** @private */
  _finalize(t0) {
    const store = this.store;
    store.rebuildAliveList();
    this._ensureBuffers();
    this._aggregate();

    const summary = this.summary;
    summary.round = this.round;
    summary.aliveCount = this.store.aliveCount;
    summary.births = this.births;
    summary.deaths = this.deaths;
    summary.bankruptcies = this.bankruptcies;
    summary.frozenCount = this.frozenCount;
    summary.totalWealth = this.totalWealth;
    summary.maxAsset = this.maxAsset;
    summary.aboveThreshold = this.aboveThreshold;
    summary.cost = this.cost;
    summary.inflationFactor = this.inflationFactor;
    summary.avgBet = this.avgBet;
    summary.avgWinStreak = this.avgWinStreak;
    summary.avgLossStreak = this.avgLossStreak;
    summary.pool.amount = this.pool.amount;
    summary.pool.created = this.created;
    summary.pool.destroyed = this.destroyed;
    summary.plague.infected = this.infectedCount;
    summary.plague.antibodies = this.store.aliveCount > 0 ? this.antibodyCount / this.store.aliveCount : 0;
    summary.plague.active = this.infectedCount > 0;

    this._updateEndCondition();
    summary.endCondition = this.endInfo;

    this.analytics.onRound(store, summary);
    this.tracker.onRound(store, this.round);

    const elapsed = performance.now() - t0;
    this.tickMs = this.tickMs === 0 ? elapsed : this.tickMs * 0.85 + elapsed * 0.15;
    summary.perf.tickMs = this.tickMs;
    if (this.endInfo.ended && this.status !== 'ended') {
      this.status = 'ended';
      this.endReason = this.endInfo.reason;
    }
  }

  /**
   * 全量存活扫描：总资产、最大值、冻结/负资产/感染人数、结束条件所需计数。
   * @private
   */
  _aggregate() {
    const store = this.store;
    const list = store.aliveList;
    const n = store.aliveCount;
    const assets = store.assets;
    const frozen = store.frozen;
    const infected = store.infected;
    const immunity = store.immunity;
    const needAbove = this.cfg.endCondition.mode === 'A' || this.cfg.endCondition.mode === 'B';
    const threshold = this.cfg.endCondition.threshold;
    let total = 0;
    let max = 0;
    let above = 0;
    let frozenCount = 0;
    let negative = 0;
    let infectedCount = 0;
    let antibodyCount = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const a = assets[s];
      total += a;
      if (a > max) max = a;
      if (a < 0) negative++;
      if (frozen[s] === 1) frozenCount++;
      if (needAbove && a >= threshold) above++;
      if (infected[s] === 1) infectedCount++;
      if (immunity[s] === 1) antibodyCount++;
    }
    this.totalWealth = total;
    this.maxAsset = max;
    this.aboveThreshold = above;
    this.frozenCount = frozenCount;
    this.negativeCount = negative;
    this.infectedCount = infectedCount;
    this.antibodyCount = antibodyCount;
  }

  /** @private 结束条件（参数 4 模式 A~E） */
  _updateEndCondition() {
    const c = this.cfg;
    const ec = c.endCondition;
    const initial = c.initialPopulation;
    const alive = this.store.aliveCount;
    let ended = false;
    let reason = null;
    let progress = 0;
    let label = '';

    // 模式 E 的“连续无增长”计数（用总资产近似）
    const grew = this.totalWealth > this.prevTotalWealth + 1e-9;
    if (ec.mode === 'E') {
      if (grew) this.noGrowthCounter = 0;
      else this.noGrowthCounter++;
    }
    this.prevTotalWealth = this.totalWealth;

    switch (ec.mode) {
      case 'A': {
        progress = ec.threshold > 0 ? Math.min(1, this.maxAsset / ec.threshold) : 1;
        ended = this.maxAsset >= ec.threshold;
        label = `模式A：最高资产 ${fmt(this.maxAsset)} / ${fmt(ec.threshold)}`;
        if (ended) reason = `出现资产达到 ${fmt(ec.threshold)} 的个体`;
        break;
      }
      case 'B': {
        const target = Math.max(1, Math.ceil((initial * ec.pct) / 100));
        progress = Math.min(1, this.aboveThreshold / target);
        ended = this.aboveThreshold >= target;
        label = `模式B：资产超阈值 ${this.aboveThreshold.toLocaleString()} / ${target.toLocaleString()}（${ec.pct}%）`;
        if (ended) reason = `${ec.pct}% 的个体资产超过 ${fmt(ec.threshold)}`;
        break;
      }
      case 'D': {
        const target = Math.max(1, Math.ceil((initial * ec.pct) / 100));
        ended = alive < target;
        progress = initial > target ? Math.min(1, Math.max(0, 1 - (alive - target) / (initial - target))) : (ended ? 1 : 0);
        label = `模式D：存活 ${alive.toLocaleString()} / 下限 ${target.toLocaleString()}`;
        if (ended) reason = `存活个体低于总人口的 ${ec.pct}%`;
        break;
      }
      case 'E': {
        progress = Math.min(1, this.noGrowthCounter / ec.noGrowthRounds);
        ended = this.noGrowthCounter >= ec.noGrowthRounds;
        label = `模式E：资产连续无增长 ${this.noGrowthCounter} / ${ec.noGrowthRounds} 回合`;
        if (ended) reason = `连续 ${ec.noGrowthRounds} 回合总资产无增长`;
        break;
      }
      case 'C':
      default: {
        progress = Math.min(1, this.round / ec.rounds);
        ended = this.round >= ec.rounds;
        label = `模式C：回合 ${this.round.toLocaleString()} / ${ec.rounds.toLocaleString()}`;
        if (ended) reason = `完成 ${ec.rounds} 回合`;
        break;
      }
    }
    if (!ended && alive === 0) {
      ended = true;
      reason = '所有个体均已灭绝';
      progress = 1;
      label = '全员灭绝';
    }
    if (!ended && this.round >= ec.maxRounds) {
      ended = true;
      reason = `达到安全回合上限 ${ec.maxRounds}`;
      progress = 1;
      label = '达到安全回合上限';
    }
    this.endInfo = { mode: ec.mode, label, progress, ended, reason };
  }

  // ──────────────────────────────────────────────────────────────
  // 对外控制接口
  // ──────────────────────────────────────────────────────────────

  start() {
    if (this.status !== 'ended') this.status = 'running';
    return this.status;
  }

  pause() {
    if (this.status === 'running') this.status = 'paused';
    return this.status;
  }

  resume() {
    if (this.status === 'paused' && this.endInfo && !this.endInfo.ended) this.status = 'running';
    return this.status;
  }

  /** 单步：暂停状态下跑 n 回合 */
  step(rounds = 1) {
    if (this.status === 'running') return { ok: false, error: '运行中不能单步' };
    for (let i = 0; i < rounds; i++) {
      if (this.tick()) break;
    }
    if (this.status !== 'ended') this.status = 'paused';
    return { ok: true, round: this.round, ended: this.status === 'ended' };
  }

  /**
   * 热更新配置。人口/资产尺度相关字段变化时返回 { reset: true }。
   * @param {object} patch
   */
  setConfig(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 无效' };
    const needsReset = RESET_KEYS.some((k) => patch[k] !== undefined)
      || patch.families !== undefined
      || patch.parallel !== undefined
      || (patch.guilds !== undefined
        && patch.guilds.enabled !== undefined
        && !!patch.guilds.enabled !== this.cfg.guilds.enabled)
      || (patch.plague !== undefined && patch.plague.enabled !== undefined && !!patch.plague.enabled !== this.cfg.plague.enabled);
    const nextCfg = normalizeConfig(mergeConfig(this.cfg, patch));
    if (needsReset) {
      const wasRunning = this.status === 'running';
      this.reset(nextCfg);
      if (wasRunning) this.start();
      return { ok: true, reset: true, config: this.cfg };
    }
    this.cfg = nextCfg;
    this.store.cfg = nextCfg;
    this.analytics.setConfig(nextCfg);
    this.tracker.setConfig(nextCfg);
    this.configVersion = (this.configVersion || 0) + 1;
    return { ok: true, reset: false, config: this.cfg };
  }

  /**
   * 手动触发宏观调控。
   * @param {string} kind average|redistribute|disaster|dividend|subsidy|plague
   */
  triggerMacro(kind) {
    const store = this.store;
    const ctx = {
      cfg: this.cfg,
      rng: this.rng,
      round: this.round,
      aliveList: store.aliveList,
      aliveCount: store.aliveCount,
      cost: this.cost,
      totalWealth: this.totalWealth,
      pool: this.pool,
    };
    const report = triggerManual(store, this.eventSys, ctx, kind);
    if (report) {
      if (report.events) this._logEvents(report.events);
      if (report.created) this.created += report.created;
      if (report.destroyed) this.destroyed += report.destroyed;
    }
    return report;
  }

  /**
   * 按稳定 ID 追踪个体（线性扫描存活表，频率低可接受）。
   * @param {number} id
   */
  trackById(id) {
    const store = this.store;
    const list = store.aliveList;
    const n = store.aliveCount;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (store.id[s] === id) return this.tracker.track(store, s, this.familySys);
    }
    return null;
  }

  /** @param {number} id */
  untrackById(id) {
    return this.tracker.untrack(id);
  }

  /**
   * 生成一帧完整二进制快照。
   * @param {number} seq
   * @returns {{buffer: ArrayBuffer, json: object}}
   */
  snapshot(seq) {
    this._ensureBuffers();
    return buildFrame(this, seq);
  }

  /** 轻量状态（/api/status 与控制响应） */
  getStatus() {
    const store = this.store;
    return {
      round: this.round,
      status: this.status,
      aliveCount: store ? store.aliveCount : 0,
      initialPopulation: this.cfg.initialPopulation,
      births: this.births,
      deaths: this.deaths,
      bankruptcies: this.bankruptcies,
      totalWealth: this.totalWealth,
      maxAsset: this.maxAsset,
      cost: this.cost,
      inflationFactor: this.inflationFactor,
      tickMs: this.tickMs,
      initMs: this.initMs,
      created: this.created,
      destroyed: this.destroyed,
      pool: { ...this.pool },
      endCondition: this.endInfo,
      tracked: this.tracker.size,
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      capacity: store ? store.capacity : 0,
      frozen: this.frozenCount,
      shared: store ? store.shared : false,
      parallelWorkers: this.parallelWorkers || 0,
      guildTreasury: Math.round(this.guildTreasury || 0),
      guildWars: this.guildWars || 0,
    };
  }

  /** 家族聚合（供 snapshot 使用） */
  familyStats() {
    const store = this.store;
    return aggregateFamilies(store, this.familySys, store.aliveList, store.aliveCount, this.cfg);
  }

  /** 公会聚合（供 snapshot 使用；未启用时返回 enabled:false 的空结构） */
  guildStats() {
    return guilds.aggregateGuilds(this.store, this.guildSys, this.cfg);
  }
}

/** 中文金额格式（万/亿） */
function fmt(v) {
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return Math.round(v).toLocaleString();
}

export { fmt };
