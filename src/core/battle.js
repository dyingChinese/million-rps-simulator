/**
 * battle.js — 匹配对战热循环（纯函数，零对象分配）
 *
 * 该模块被两个地方调用：
 *   1. 单线程模式：引擎在自己的线程里直接调用 processBattleRange()；
 *   2. 并行模式：battle-worker.js 在每个 worker 线程里对一段 pair 区间调用它。
 *
 * 并行安全性：每个个体每回合只出现在一个 pair 中，因此不同区间写入的
 * assets / stats / streak 槽位互不相交（无数据竞争）；所有数组均为 SAB 支撑。
 *
 * 上下文 ctx 字段（由引擎每回合构建一次，结构固定）：
 *   数组：assets, debtLimit, gene, talent, age, winStreak, lossStreak, stats,
 *        frozen, alive, pool, moveUsage, deathList, deathTypes,
 *        lastOpp, lastOppPtr（破产清算启用时）
 *   参数：cost, baseBet, talOn, luckBonus, thriftyMul, softCapOn, softCapThreshold,
 *        softCapDecay, newbieK, redistributeOn, taxToPool, classT0/1/2,
 *        learnOn, lossTrigger, adjustStep, reversalStreak, imitateChance,
 *        imitateThreshold, imitateBlend, penaltyEnabled, penaltyThreshold,
 *        penaltyChance, learnFactorArr, lastOppK
 *
 * 输出写在 out 对象（每个 worker 独占一份）：
 *   { destroyed, poolDelta, wins, draws, betSum, betCount, winStreakSum, lossStreakSum, deathCount }
 */
import { GENE_COUNT, STATS_STRIDE, STATS_WINS, STATS_LOSSES } from './store.js';

/** 破产死亡类型（与 engine.js 保持一致） */
export const DEATH_BANKRUPT = 1;

/**
 * 处理 [startPair, endPair) 区间的对局。
 * @param {object} ctx 见模块头注释
 * @param {object} out 累加器（调用前应清零）
 * @param {number} startPair 起始 pair 下标（含）
 * @param {number} endPair 结束 pair 下标（不含）
 * @param {import('./rng.js').Rng} rng 本区间专属随机源
 */
export function processBattleRange(ctx, out, startPair, endPair, rng) {
  const assets = ctx.assets;
  const debtLimit = ctx.debtLimit;
  const gene = ctx.gene;
  const talent = ctx.talent;
  const age = ctx.age;
  const winStreak = ctx.winStreak;
  const lossStreak = ctx.lossStreak;
  const stats = ctx.stats;
  const frozen = ctx.frozen;
  const alive = ctx.alive;
  const pool = ctx.pool;
  const moveUsage = ctx.moveUsage;
  const deathList = ctx.deathList;
  const deathTypes = ctx.deathTypes;
  const lastOpp = ctx.lastOpp;
  const lastOppPtr = ctx.lastOppPtr;
  const lastOppK = ctx.lastOppK;

  const cost = ctx.cost;
  const baseBet = ctx.baseBet;
  const talOn = ctx.talOn;
  const luckBonus = ctx.luckBonus;
  const thriftyMul = ctx.thriftyMul;
  const softCapOn = ctx.softCapOn;
  const softCapThreshold = ctx.softCapThreshold;
  const softCapDecay = ctx.softCapDecay;
  const newbieK = ctx.newbieK;
  const redistributeOn = ctx.redistributeOn;
  const taxToPool = ctx.taxToPool;
  const t0 = ctx.classT0;
  const t1 = ctx.classT1;
  const t2 = ctx.classT2;
  const learnOn = ctx.learnOn;
  const lossTrigger = ctx.lossTrigger;
  const adjustStep = ctx.adjustStep;
  const reversalStreak = ctx.reversalStreak;
  const imitateChance = ctx.imitateChance;
  const imitateThreshold = ctx.imitateThreshold;
  const imitateBlend = ctx.imitateBlend;
  const penaltyEnabled = ctx.penaltyEnabled;
  const penaltyThreshold = ctx.penaltyThreshold;
  const penaltyChance = ctx.penaltyChance;
  const learnFactorArr = ctx.learnFactorArr;
  // 公会模式（可选）：成员按公会等级享受猜拳成本折扣
  const guildsOn = ctx.guildsOn === true;
  const guild = ctx.guild;
  const guildLevel = ctx.guildLevel;
  const guildDiscountPerLevel = ctx.guildDiscountPerLevel || 0;
  const guildDiscountCap = ctx.guildMaxDiscount || 0;
  const TALENT_LUCKY = 1;
  const TALENT_THRIFTY = 2;
  const G = GENE_COUNT;
  const S = STATS_STRIDE;
  const S_WINS = STATS_WINS;
  const S_LOSSES = STATS_LOSSES;

  let destroyed = 0;
  let poolDelta = 0;
  let wins = 0;
  let draws = 0;
  let betSum = 0;
  let betCount = 0;
  let winStreakSum = 0;
  let lossStreakSum = 0;
  let deathCount = 0;

  for (let p = startPair; p < endPair; p++) {
    const ai = p + p;
    const a = pool[ai];
    const b = pool[ai + 1];
    const ao = a * G;
    const bo = b * G;

    // ── 出拳 ──
    let r = rng.float();
    const ma = r < gene[ao] ? 0 : r < gene[ao] + gene[ao + 1] ? 1 : 2;
    r = rng.float();
    const mb = r < gene[bo] ? 0 : r < gene[bo] + gene[bo + 1] ? 1 : 2;
    moveUsage[ma]++;
    moveUsage[mb]++;

    // ── 成本 ──
    const talA = talent[a];
    const talB = talent[b];
    let costA = talOn && talA === TALENT_THRIFTY ? cost * thriftyMul : cost;
    let costB = talOn && talB === TALENT_THRIFTY ? cost * thriftyMul : cost;
    if (guildsOn) {
      const ga = guild[a];
      if (ga >= 0) {
        const disc = guildLevel[ga] * guildDiscountPerLevel;
        costA *= 1 - (disc > guildDiscountCap ? guildDiscountCap : disc);
      }
      const gb = guild[b];
      if (gb >= 0) {
        const disc = guildLevel[gb] * guildDiscountPerLevel;
        costB *= 1 - (disc > guildDiscountCap ? guildDiscountCap : disc);
      }
    }
    let assetA = assets[a] - costA;
    let assetB = assets[b] - costB;
    if (taxToPool) poolDelta += costA + costB;
    else destroyed += costA + costB;

    // ── 判定胜负 ──
    const diff = ma - mb;
    let result;
    if (diff === 0) result = 0;
    else if ((diff + 3) % 3 === 2) result = 1;
    else result = -1;

    // 幸运儿翻盘
    if (result !== 0) {
      const loserTalent = result === 1 ? talB : talA;
      if (talOn && loserTalent === TALENT_LUCKY && rng.chance(luckBonus)) result = -result;
      // 连胜惩罚
      if (penaltyEnabled) {
        const winnerSlot = result === 1 ? a : b;
        if (winStreak[winnerSlot] >= penaltyThreshold && rng.chance(penaltyChance)) result = -result;
      }
    }

    const sa = a * S;
    const sb = b * S;
    let finalA;
    let finalB;

    if (result === 0) {
      // ── 平局 ──
      draws++;
      stats[sa]++;
      stats[sb]++;
      winStreak[a] = 0;
      winStreak[b] = 0;
      lossStreak[a] = 0;
      lossStreak[b] = 0;
      finalA = assetA;
      finalB = assetB;
    } else {
      // ── 胜负 ──
      const aWin = result === 1;
      const winner = aWin ? a : b;
      const loser = aWin ? b : a;
      const loserOff = (aWin ? b : a) * G;
      const loserAsset = aWin ? assetB : assetA;
      const winnerAssetBefore = aWin ? assetA : assetB;

      // 赌注
      let mult = gene[loserOff + 3];
      if (loserAsset < gene[loserOff + 4]) mult *= 0.5;
      else if (loserAsset > gene[loserOff + 5]) mult *= 1.5;
      if (loserAsset >= t2) mult *= 0.85;
      else if (loserAsset >= t1) mult *= 0.95;
      else if (loserAsset >= t0) mult *= 1.05;
      else mult *= 1.25;
      let stake = baseBet * mult;
      if (!(stake >= 0)) stake = 0;
      betSum += stake;
      betCount++;

      // 资产上限软限制
      let gain = stake;
      if (softCapOn && winnerAssetBefore > softCapThreshold) {
        gain = stake * softCapDecay;
        destroyed += stake - gain;
      }

      if (aWin) {
        finalA = assetA + gain;
        finalB = assetB - stake;
        stats[sa]++;
        stats[sb]++;
        stats[sa + S_WINS]++;
        stats[sb + S_LOSSES]++;
        winStreak[a]++;
        lossStreak[a] = 0;
        lossStreak[b]++;
        winStreak[b] = 0;
      } else {
        finalA = assetA - stake;
        finalB = assetB + gain;
        stats[sa]++;
        stats[sb]++;
        stats[sa + S_LOSSES]++;
        stats[sb + S_WINS]++;
        winStreak[b]++;
        lossStreak[b] = 0;
        lossStreak[a]++;
        winStreak[a] = 0;
      }
      wins++;
      winStreakSum += winStreak[winner];
      lossStreakSum += lossStreak[loser];

      // ── 学习 / 逆反 / 模仿 ──
      if (learnOn) {
        const ls = lossStreak[loser];
        const learnRate = learnFactorArr[aWin ? talB : talA];
        if (ls % lossTrigger === 0 || ls === reversalStreak) {
          if (ls % lossTrigger === 0) adjustStrategy(gene, loser, aWin ? mb : ma, adjustStep * learnRate, false);
          if (ls === reversalStreak) adjustStrategy(gene, loser, 0, 0, true);
        }
        const loserFinal = aWin ? finalB : finalA;
        const winnerFinal = aWin ? finalA : finalB;
        if (ls > 2 && winnerFinal > loserFinal * imitateThreshold && rng.chance(imitateChance)) {
          imitateStrategy(gene, loser, winner, imitateBlend);
        }
      }

      // 记录最近对手
      if (redistributeOn) {
        if (lastOppK > 0) {
          let ptr = lastOppPtr[a];
          lastOpp[a * lastOppK + ptr] = b;
          lastOppPtr[a] = ptr + 1 >= lastOppK ? 0 : ptr + 1;
          ptr = lastOppPtr[b];
          lastOpp[b * lastOppK + ptr] = a;
          lastOppPtr[b] = ptr + 1 >= lastOppK ? 0 : ptr + 1;
        }
      }
    }

    // 写回资产
    assets[a] = finalA;
    assets[b] = finalB;

    // ── 破产判定（先判负数，避免无谓读取 debtLimit）──
    if (finalA < 0 && finalA < -debtLimit[a]) {
      if (age[a] < newbieK) frozen[a] = 1;
      else {
        alive[a] = 0;
        deathList[deathCount] = a;
        deathTypes[deathCount] = DEATH_BANKRUPT;
        deathCount++;
      }
    }
    if (finalB < 0 && finalB < -debtLimit[b]) {
      if (age[b] < newbieK) frozen[b] = 1;
      else {
        alive[b] = 0;
        deathList[deathCount] = b;
        deathTypes[deathCount] = DEATH_BANKRUPT;
        deathCount++;
      }
    }
  }

  out.destroyed = destroyed;
  out.poolDelta = poolDelta;
  out.wins = wins;
  out.draws = draws;
  out.betSum = betSum;
  out.betCount = betCount;
  out.winStreakSum = winStreakSum;
  out.lossStreakSum = lossStreakSum;
  out.deathCount = deathCount;
}

/**
 * 学习/逆反：调整败者出拳概率。
 * @param {Float32Array} gene 基因数组
 * @param {number} slot 败者槽位
 * @param {number} losingMove 败者本局出的拳
 * @param {number} step 降权比例
 * @param {boolean} reversal 是否「策略反转」
 */
export function adjustStrategy(gene, slot, losingMove, step, reversal) {
  const off = slot * GENE_COUNT;
  let p0 = gene[off];
  let p1 = gene[off + 1];
  let p2 = gene[off + 2];
  if (reversal) {
    if (p0 <= p1 && p0 <= p2) p0 += 0.2;
    else if (p1 <= p0 && p1 <= p2) p1 += 0.2;
    else p2 += 0.2;
    const sum = p0 + p1 + p2;
    if (sum > 0) {
      p0 /= sum;
      p1 /= sum;
      p2 /= sum;
    }
  } else {
    let cut;
    if (losingMove === 0) {
      cut = p0 * step;
      p0 -= cut;
      p1 += cut * 0.5;
      p2 += cut * 0.5;
    } else if (losingMove === 1) {
      cut = p1 * step;
      p1 -= cut;
      p0 += cut * 0.5;
      p2 += cut * 0.5;
    } else {
      cut = p2 * step;
      p2 -= cut;
      p0 += cut * 0.5;
      p1 += cut * 0.5;
    }
  }
  gene[off] = p0;
  gene[off + 1] = p1;
  gene[off + 2] = p2;
}

/**
 * 模仿：败者向胜者策略混合。
 * @param {Float32Array} gene
 * @param {number} loser
 * @param {number} winner
 * @param {number} blend 混合比例
 */
export function imitateStrategy(gene, loser, winner, blend) {
  const lOff = loser * GENE_COUNT;
  const wOff = winner * GENE_COUNT;
  gene[lOff] = gene[lOff] * (1 - blend) + gene[wOff] * blend;
  gene[lOff + 1] = gene[lOff + 1] * (1 - blend) + gene[wOff + 1] * blend;
  gene[lOff + 2] = gene[lOff + 2] * (1 - blend) + gene[wOff + 2] * blend;
}

/** 清零输出累加器（复用对象） */
export function resetOut(out) {
  out.destroyed = 0;
  out.poolDelta = 0;
  out.wins = 0;
  out.draws = 0;
  out.betSum = 0;
  out.betCount = 0;
  out.winStreakSum = 0;
  out.lossStreakSum = 0;
  out.deathCount = 0;
  return out;
}

/** 新建一个输出累加器 */
export function createOut() {
  return {
    destroyed: 0,
    poolDelta: 0,
    wins: 0,
    draws: 0,
    betSum: 0,
    betCount: 0,
    winStreakSum: 0,
    lossStreakSum: 0,
    deathCount: 0,
  };
}
