/**
 * store.js — 智能体状态容器（Structure of Arrays / SoA）
 *
 * 为什么用 SoA：百万级个体，若每个个体一个 JS 对象，光是 GC 与指针跳转就会拖垮性能。
 * 这里全部使用连续的 TypedArray，按列存储属性，热路径循环只做数字计算与数组下标访问。
 *
 * 槽位（slot）语义：
 *  - 所有数组按 slot 并行索引，slot ∈ [0, capacity)。
 *  - `count` 是已使用槽位的高水位；死掉的个体通过 `freeList` 复用其槽位。
 *  - `id` 单调递增且永不复用，是跨线程/跨快照的稳定标识（前端追踪、谱系引用都用它）。
 *  - 存活个体用 `alive[slot] === 1` 标记；`aliveList` 是每回合重建的紧凑索引表。
 */

/** 基因维度数量：出石头/剪刀/布概率 + 风险偏好 + 保守阈值 + 激进阈值 */
export const GENE_COUNT = 6;
export const GENE_ROCK = 0;
export const GENE_SCISSORS = 1;
export const GENE_PAPER = 2;
export const GENE_RISK = 3;
export const GENE_CONSERVATIVE = 4;
export const GENE_AGGRESSIVE = 5;

/** 天赋编码（与 talents.js / config.TALENT_NAMES 顺序一致） */
export const TALENT_NONE = 0;
export const TALENT_LUCKY = 1;
export const TALENT_THRIFTY = 2;
export const TALENT_FERTILE = 3;
export const TALENT_FAST_LEARNER = 4;
export const TALENT_DEBT_RESISTANT = 5;
export const TALENT_COUNT = 6;

/**
 * 熔合统计数组 `stats` 的步长与下标：
 * [0]=累计猜拳次数 [1]=胜 [2]=负 [3]=平。
 * 合并到同一个 Int32Array 可以减少热路径的随机数组访问（缓存友好）。
 */
export const STATS_STRIDE = 4;
export const STATS_ROUNDS = 0;
export const STATS_WINS = 1;
export const STATS_LOSSES = 2;
export const STATS_DRAWS = 3;

export class AgentStore {
  /**
   * @param {number} capacity 初始槽位容量
   * @param {object} cfg 归一化后的配置对象
   * @param {number} [startId=1]
   */
  constructor(capacity, cfg, startId = 1) {
    /** @type {object} */
    this.cfg = cfg;
    this.capacity = 0;
    /** 已使用槽位高水位（含墓碑） */
    this.count = 0;
    /** 存活人数 */
    this.aliveCount = 0;
    this.freeCount = 0;
    this.nextId = startId;
    this.lastOppK = cfg.balance.redistribution.enabled ? cfg.balance.redistribution.toLastOpponents : 0;
    /** 是否使用 SharedArrayBuffer（并行对战需要，跨 worker 共享记忆） */
    this.shared = !!(cfg.parallel && cfg.parallel.enabled);
    /** 数组版本号：扩容/重建时自增（并行线程池据此刷新视图） */
    this.arrayVersion = 0;
    this._allocArrays(Math.max(4, Math.ceil(capacity)));
  }

  /** @private */
  _allocArrays(cap) {
    this.capacity = cap;
    /** 稳定且唯一的个体 ID */
    this.id = this._allocA(Int32Array, cap);
    /** 1 = 存活 */
    this.alive = this._allocA(Uint8Array, cap);
    /** 1 = 冻结（新手保护 / 破产保护状态），不进入匹配池 */
    this.frozen = this._allocA(Uint8Array, cap);
    /** 冻结解除回合 */
    this.freezeUntil = this._allocA(Int32Array, cap);
    /** 当前资产（可负） */
    this.assets = this._allocA(Float64Array, cap);
    /** 负债上限（已含天赋加成） */
    this.debtLimit = this._allocA(Float32Array, cap);
    /** 猜拳成本承受能力（成本系数，天赋影响） */
    this.costAffinity = this._allocA(Float32Array, cap);
    /** 年龄（存活回合数） */
    this.age = this._allocA(Int32Array, cap);
    /** 出生回合 */
    this.birthRound = this._allocA(Int32Array, cap);
    /** 连胜 */
    this.winStreak = this._allocA(Int16Array, cap);
    /** 连败 */
    this.lossStreak = this._allocA(Int16Array, cap);
    /** 繁殖次数 */
    this.reproCount = this._allocA(Uint8Array, cap);
    /** 累计猜拳次数 / 胜 / 负 / 平：[rounds, wins, losses, draws] × STATS_STRIDE */
    this.stats = this._allocA(Int32Array, cap * STATS_STRIDE);
    /** 策略基因：[石头, 剪刀, 布, 风险偏好, 保守阈值, 激进阈值] × GENE_COUNT */
    this.gene = this._allocA(Float32Array, cap * GENE_COUNT);
    /** 天赋编码 */
    this.talent = this._allocA(Uint8Array, cap);
    /** 代数（创始人为 0） */
    this.generation = this._allocA(Int16Array, cap);
    /** 父系家族 ID（创始家族 0..F-1，后代继承父系） */
    this.familyId = this._allocA(Int32Array, cap);
    /** 母系家族 ID（谱系观测用） */
    this.maternalFamilyId = this._allocA(Int32Array, cap);
    /** 父母槽位提示 + 稳定 ID（父 = 0, 母 = 1） */
    this.parentA = this._allocA(Int32Array, cap);
    this.parentAId = this._allocA(Int32Array, cap);
    this.parentB = this._allocA(Int32Array, cap);
    this.parentBId = this._allocA(Int32Array, cap);
    /** 公会 ID（-1 = 无） */
    this.guild = this._allocA(Int16Array, cap);
    /** 瘟疫状态 */
    this.infected = this._allocA(Uint8Array, cap);
    this.infectionRound = this._allocA(Int32Array, cap);
    this.immunity = this._allocA(Uint8Array, cap);
    /** 最近 N 个对手（破产清算规则用；未启用时不分配） */
    this.lastOpp = this.lastOppK > 0 ? this._allocA(Int32Array, cap * this.lastOppK) : null;
    this.lastOppPtr = this.lastOppK > 0 ? this._allocA(Uint8Array, cap) : null;
    /** 存活索引表（每回合重建） */
    this.aliveList = this._allocA(Int32Array, cap);
    /** 空闲槽位栈 */
    this.freeList = this._allocA(Int32Array, cap);
    if (this.guild.length) this.guild.fill(-1);
  }

  /** 扩容（倍增），保留已有数据。O(capacity)。 */
  _grow(newCap) {
    if (newCap <= this.capacity) return;
    const old = this;
    const copy = (name, Type, stride = 1) => {
      const a = this._allocA(Type, newCap * stride);
      a.set(old[name]);
      old[name] = a;
    };
    copy('id', Int32Array);
    copy('alive', Uint8Array);
    copy('frozen', Uint8Array);
    copy('freezeUntil', Int32Array);
    copy('assets', Float64Array);
    copy('debtLimit', Float32Array);
    copy('costAffinity', Float32Array);
    copy('age', Int32Array);
    copy('birthRound', Int32Array);
    copy('winStreak', Int16Array);
    copy('lossStreak', Int16Array);
    copy('reproCount', Uint8Array);
    copy('stats', Int32Array, STATS_STRIDE);
    copy('gene', Float32Array, GENE_COUNT);
    copy('talent', Uint8Array);
    copy('generation', Int16Array);
    copy('familyId', Int32Array);
    copy('maternalFamilyId', Int32Array);
    copy('parentA', Int32Array);
    copy('parentAId', Int32Array);
    copy('parentB', Int32Array);
    copy('parentBId', Int32Array);
    copy('guild', Int16Array);
    copy('infected', Uint8Array);
    copy('infectionRound', Int32Array);
    copy('immunity', Uint8Array);
    copy('aliveList', Int32Array);
    copy('freeList', Int32Array);
    if (this.lastOppK > 0) {
      copy('lastOpp', Int32Array, this.lastOppK);
      copy('lastOppPtr', Uint8Array);
    }
    this.capacity = newCap;
    this.arrayVersion++;
  }

  /** 确保容量至少为 need（不够则倍增扩容）。 */
  ensureCapacity(need) {
    if (need <= this.capacity) return;
    let cap = this.capacity;
    while (cap < need) cap = Math.ceil(cap * 1.5);
    this._grow(Math.min(cap, 5_000_000));
  }

  /**
   * 分配一个槽位（优先复用空闲槽位），并重置为「新生儿」默认值。
   * 调用方随后设置 id 以外的全部业务字段。
   * @param {number} round 当前回合
   * @returns {number} slot
   */
  /**
   * 按需分配 TypedArray：并行模式下使用 SharedArrayBuffer，使数组可跨 worker 共享。
   * @private
   * @param {Function} Type TypedArray 构造器
   * @param {number} length 元素个数
   * @returns {TypedArray}
   */
  _allocA(Type, length) {
    if (!this.shared) return new Type(length);
    return new Type(new SharedArrayBuffer(Type.BYTES_PER_ELEMENT * length));
  }

  alloc(round) {
    let slot;
    if (this.freeCount > 0) {
      slot = this.freeList[--this.freeCount];
    } else {
      if (this.count >= this.capacity) this.ensureCapacity(this.count + 1);
      slot = this.count++;
    }
    const s = slot;
    this.id[s] = this.nextId++;
    this.alive[s] = 1;
    this.frozen[s] = 0;
    this.freezeUntil[s] = 0;
    this.assets[s] = 0;
    this.debtLimit[s] = 0;
    this.costAffinity[s] = 1;
    this.age[s] = 0;
    this.birthRound[s] = round;
    this.winStreak[s] = 0;
    this.lossStreak[s] = 0;
    this.reproCount[s] = 0;
    const st = s * STATS_STRIDE;
    this.stats[st] = 0;
    this.stats[st + 1] = 0;
    this.stats[st + 2] = 0;
    this.stats[st + 3] = 0;
    this.talent[s] = TALENT_NONE;
    this.generation[s] = 0;
    this.familyId[s] = 0;
    this.maternalFamilyId[s] = 0;
    this.parentA[s] = -1;
    this.parentAId[s] = 0;
    this.parentB[s] = -1;
    this.parentBId[s] = 0;
    this.guild[s] = -1;
    this.infected[s] = 0;
    this.infectionRound[s] = 0;
    this.immunity[s] = 0;
    if (this.lastOppPtr) this.lastOppPtr[s] = 0;
    return s;
  }

  /** 释放槽位（调用方负责业务层面的死亡处理，如破产核销）。 */
  freeSlot(slot) {
    this.alive[slot] = 0;
    this.frozen[slot] = 0;
    if (this.freeCount < this.capacity) this.freeList[this.freeCount++] = slot;
  }

  /**
   * 重建存活索引表。每回合调用一次（O(count)）。
   * @returns {number} 存活人数
   */
  rebuildAliveList() {
    const { alive, aliveList } = this;
    const count = this.count;
    let n = 0;
    for (let s = 0; s < count; s++) {
      if (alive[s]) aliveList[n++] = s;
    }
    this.aliveCount = n;
    return n;
  }

  /** @returns {number} 基因值 */
  geneOf(slot, geneId) {
    return this.gene[slot * GENE_COUNT + geneId];
  }

  /** 设置基因值 */
  setGene(slot, geneId, value) {
    this.gene[slot * GENE_COUNT + geneId] = value;
  }

  /** 记录一次对局对手（环形写入，仅破产清算启用时调用）。 */
  pushOpponent(slot, oppSlot) {
    const k = this.lastOppK;
    if (k === 0) return;
    const ptr = this.lastOppPtr[slot];
    this.lastOpp[slot * k + ptr] = oppSlot;
    let next = ptr + 1;
    if (next >= k) next = 0;
    this.lastOppPtr[slot] = next;
  }

  /** 遍历最近对手（破产清算时按比例分配）。 */
  forEachLastOpponent(slot, fn) {
    const k = this.lastOppK;
    if (k === 0) return;
    const base = slot * k;
    for (let i = 0; i < k; i++) {
      const opp = this.lastOpp[base + i];
      if (opp >= 0 && this.alive[opp]) fn(opp, i);
    }
  }
}
