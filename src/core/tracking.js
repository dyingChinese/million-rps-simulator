/**
 * tracking.js — 个体追踪：记录被选中个体的一生资产曲线与谱系信息
 *
 * 引擎每回合调用 onRound()（只处理 ≤8 个个体，开销可忽略），
 * snapshot 时把追踪卡数据放进帧 JSON。
 */
import { classOf } from './config.js';
import { familyName } from './families.js';
import { STATS_STRIDE, STATS_WINS, STATS_LOSSES, STATS_DRAWS } from './store.js';

const MAX_TRACKED = 8;
/** 追踪曲线保留点数（前端 sparkline / 资产曲线用） */
const MAX_HISTORY = 240;

export class Tracker {
  /** @param {object} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Array<{slot:number,id:number,history:number[],historyRounds:number[],alive:boolean}>} */
    this.entries = [];
    this._dirty = false;
  }

  /** @param {object} cfg */
  setConfig(cfg) {
    this.cfg = cfg;
  }

  reset() {
    this.entries.length = 0;
  }

  get size() {
    return this.entries.length;
  }

  /**
   * 追踪某个存活个体。
   * @param {import('./store.js').AgentStore} store
   * @param {number} slot
   * @param {object} familySys
   * @returns {object|null} 摘要
   */
  track(store, slot, familySys) {
    if (!store.alive[slot]) return null;
    const id = store.id[slot];
    if (this.entries.some((e) => e.id === id)) return { id, duplicated: true };
    if (this.entries.length >= MAX_TRACKED) {
      // 淘汰最早的一个（保持轻量，避免追踪过多影响性能）
      this.entries.shift();
    }
    const entry = {
      slot,
      id,
      alive: true,
      history: [],
      historyRounds: [],
    };
    this._pushPoint(entry, store, store.birthRound[slot] || 0);
    this.entries.push(entry);
    this._dirty = true;
    return this._summary(store, entry, familySys);
  }

  /** @param {number} id @returns {boolean} */
  untrack(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this._dirty = true;
    return true;
  }

  /**
   * 每回合记录被追踪个体的资产（槽位可能被回收，用 id 校验）。
   * @param {import('./store.js').AgentStore} store
   * @param {number} round
   */
  onRound(store, round) {
    const entries = this.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.alive) continue;
      const slot = e.slot;
      const valid = slot < store.count && store.id[slot] === e.id && store.alive[slot] === 1;
      if (!valid) {
        // 槽位被回收或个体死亡：尝试重新定位一次（死亡后不再记录）
        if (!this._relocate(store, e)) {
          e.alive = false;
          continue;
        }
      }
      e.slot = e.slot; // 槽位固定，仅当 relocate 后更新
      this._pushPoint(e, store, round);    }
  }

  /** @private */
  _relocate(store, entry) {
    const list = store.aliveList;
    const n = store.aliveCount;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (store.id[s] === entry.id) {
        entry.slot = s;
        return true;
      }
    }
    return false;
  }

  /** @private */
  _pushPoint(entry, store, round) {
    const slot = entry.slot;
    if (slot >= store.count || store.id[slot] !== entry.id) return;
    entry.history.push(store.assets[slot]);
    entry.historyRounds.push(round);
    if (entry.history.length > MAX_HISTORY) {
      entry.history.shift();
      entry.historyRounds.shift();
    }
  }

  /**
   * 生成追踪卡片 JSON。
   * @param {import('./store.js').AgentStore} store
   * @param {object} familySys
   * @returns {Array<object>}
   */
  snapshot(store, familySys) {
    const out = [];
    for (const e of this.entries) {
      const slot = e.slot;
      if (slot >= store.count || store.id[slot] !== e.id) {
        // 个体已被彻底移除
        out.push({ ...this._deadCard(e), alive: false });
        continue;
      }
      const card = this._summary(store, e, familySys);
      if (card) out.push(card);
    }
    return out;
  }

  /** @private */
  _deadCard(entry) {
    return {
      id: entry.id,
      name: `#${entry.id}`,
      asset: entry.history.length ? entry.history[entry.history.length - 1] : 0,
      age: 0,
      alive: false,
      classId: 0,
      talentId: 0,
      talentName: '',
      strategy: [1 / 3, 1 / 3, 1 / 3],
      wins: 0,
      losses: 0,
      draws: 0,
      reproCount: 0,
      generation: 0,
      family: { id: 0, name: '—' },
      parents: [],
      history: this._historyPairs(entry, 600),
    };
  }

  /** @private */
  _summary(store, entry, familySys) {
    const slot = entry.slot;
    if (slot >= store.count || store.id[slot] !== entry.id) return null;
    const cfg = this.cfg;
    const g = slot * 6;
    const st = slot * STATS_STRIDE;
    const genealogyOk = store.parentAId[slot] > 0;
    const talentId = store.talent[slot];
    return {
      id: entry.id,
      name: `#${entry.id}`,
      asset: round2(store.assets[slot]),
      age: store.age[slot],
      alive: store.alive[slot] === 1,
      classId: classOf(cfg, store.assets[slot]),
      talentId,
      talentName: TALENT_NAME(talentId),
      strategy: [round3(store.gene[g]), round3(store.gene[g + 1]), round3(store.gene[g + 2])],
      wins: store.stats[st + STATS_WINS],
      losses: store.stats[st + STATS_LOSSES],
      draws: store.stats[st + STATS_DRAWS],
      reproCount: store.reproCount[slot],
      generation: store.generation[slot],
      family: {
        id: store.familyId[slot],
        name: familySys ? familyName(familySys, store.familyId[slot]) : '—',
      },
      parents: genealogyOk ? [store.parentAId[slot], store.parentBId[slot]] : [],
      history: this._historyPairs(entry, 600),
    };
  }

  /** @private 采样到 ≤600 个点，返回 [round, asset] 交替的扁平数组 */
  _historyPairs(entry, maxPoints) {
    const R = entry.historyRounds;
    const A = entry.history;
    const n = R.length;
    if (n === 0) return [];
    const out = [];
    if (n <= maxPoints) {
      for (let i = 0; i < n; i++) out.push(R[i], round2(A[i]));
      return out;
    }
    const step = (n - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
      const idx = Math.min(n - 1, Math.round(i * step));
      out.push(R[idx], round2(A[idx]));
    }
    return out;
  }
}

function TALENT_NAME(id) {
  // 与 config.js TALENT_NAMES 保持一致（延迟取，避免循环依赖）
  return ['无', '幸运儿', '节俭者', '生育达人', '学习天才', '负债抗性'][id] || '未知';
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** @param {object} cfg */
export function createTracker(cfg) {
  return new Tracker(cfg);
}
