/**
 * guilds.js — 公会模式（需求规则 5.3）
 *
 * 模块职责：
 *  1. 定义 64 个中文公会名与公会系统状态（金库 / 等级 / 胜场，每局一个实例）；
 *  2. 建号入会（guildForNewAgent）与后代继承（inheritGuild）；
 *  3. 每回合公会逻辑（tickGuilds，引擎在「世界事件之后、个体阶段之前」调用一次）：
 *     ① 成员缴金 → ② 濒临破产成员金库兜底 / 开除 → ③ 招收新成员 → ④ 等级更新 → ⑤ 团体战；
 *  4. 快照聚合（aggregateGuilds）：公会资产/人数/胜场榜单，复用 lastStats 对象。
 *
 * 经济口径：
 *  - 缴金 / 兜底 / 团体战全部是**资产转移**（成员 ↔ 金库、金库 ↔ 金库），
 *    不产生 created/destroyed，全系统总资产守恒；
 *  - 公会等级 = min(maxLevel, floor(金库余额 / levelUpAssets))，只看金库（不含成员个人资产）；
 *    金库会因成员缴金而增长、因兜底/团体战而消耗，因此等级可升可降（特性）；
 *    引擎据此给成员提供猜拳成本折扣（本模块只维护等级数组）。
 *
 * 性能约定：
 *  - tickGuilds 只对 ctx.aliveList 做一次 O(aliveCount) 扫描；逐个体循环内不创建对象/闭包；
 *  - 成员数/成员资产/出战成员等缓冲全部预分配并挂在 guildSys 上复用；
 *  - 招收新成员用「几何间隔计数」实现（只对招到的人消耗随机数），避免对百万非成员逐个掷骰；
 *  - 团体战按成员数加权随机选 2 个公会，再用拒绝采样抽取出战成员（不构建成员列表）。
 *
 * 唯一随机源是注入的 rng；同 seed 完全可复现。
 *
 * @module guilds
 */

import { GENE_COUNT } from './store.js';
import { pickMove } from './genetics.js';

/**
 * 中文公会名（64 个，互不重复）。公会数超过本表长度时用「青龙会2号」这类后缀区分。
 * @readonly
 * @type {string[]}
 */
export const GUILD_NAMES = [
  '青龙会', '白虎堂', '朱雀阁', '玄武盟', '天罡殿', '地煞门', '凌霄阁', '听雨楼',
  '藏锋谷', '揽月轩', '踏雪楼', '临风阁', '问剑宗', '流云宗', '玄机阁', '万象门',
  '金戈堂', '铁马盟', '青锋会', '赤霄殿', '碧海阁', '紫薇宫', '幽冥谷', '星河盟',
  '山海阁', '惊鸿楼', '逐月堂', '断岳宗', '飞雪阁', '扶摇殿', '浩气盟', '逍遥谷',
  '昆仑派', '蓬莱阁', '蜀山宗', '华山派', '峨眉派', '少林寺', '武当派', '丐帮',
  '明教', '日月神教', '五毒教', '唐门', '墨家', '儒家', '法家', '兵家',
  '阴阳家', '纵横家', '天机阁', '璇玑楼', '九霄殿', '寒江雪', '落霞谷', '烟雨楼',
  '云梦泽', '铁衣卫', '金吾卫', '羽林军', '骠骑营', '虎贲军', '神机营', '龙骧卫',
];

/** 公会数量上限（与 config.js 的 guilds.count 钳制范围一致） */
const MAX_GUILDS = 256;
/** 团体战单方最多出战人数（与 config.js 的 guilds.warChampionCount 钳制范围一致） */
const MAX_CHAMPIONS = 20;
/** 单名出战成员抽取的最大尝试次数（防止极小公会把拒绝采样拖慢） */
const CHAMPION_TRIES_PER_PICK = 1024;

/**
 * 公会系统实例（每局一个）。
 * @typedef {object} GuildSystem
 * @property {boolean} enabled 创建时是否启用（运行时以 cfg.guilds.enabled 为准）
 * @property {number} count 公会数量
 * @property {string[]} names 公会展示名（长度 = count）
 * @property {Float64Array} treasury 每个公会的金库余额
 * @property {Int32Array} level 每个公会的等级（引擎用于成员成本折扣）
 * @property {Int32Array} wins 每个公会的团体战胜场
 * @property {number} wars 累计团体战次数
 * @property {number} treasuryTotal 金库总额（供引擎记账/快照）
 * @property {object|null} lastStats 最近一次聚合结果（复用对象）
 * @property {number} topN 榜单长度上限
 * @property {Int32Array} _memberCount 本轮各公会成员数（复用）
 * @property {Float64Array} _memberAssets 成员个人资产和（aggregateGuilds 扫描时填充，tickGuilds 不再维护）
 * @property {Int32Array} _eligible 有成员的公会列表（复用）
 * @property {Int32Array} _cumMembers 按成员数累加的前缀和（加权选公会，复用）
 * @property {Float64Array} _guildTotal 各公会总资产（金库+成员资产，复用）
 * @property {Int32Array} _idx 公会下标工作区（排序复用）
 * @property {Int32Array} _champA 团体战 A 方出战槽位（复用）
 * @property {Int32Array} _champB 团体战 B 方出战槽位（复用）
 * @property {object|null} _statPools 聚合输出对象池（复用）
 */

/**
 * 创建公会系统：生成公会名并预分配全部累加器/缓冲。
 *
 * @param {object} cfg 归一化配置（createConfig 结果）
 * @returns {GuildSystem} 公会系统实例
 */
export function createGuildSystem(cfg) {
  const rawCount = Math.round(cfg.guilds.count);
  const count = Math.max(1, Math.min(MAX_GUILDS, Number.isFinite(rawCount) ? rawCount : 1));
  const nameCount = GUILD_NAMES.length;
  const names = new Array(count);
  for (let i = 0; i < count; i++) {
    names[i] = i < nameCount ? GUILD_NAMES[i] : `${GUILD_NAMES[i % nameCount]}${Math.floor(i / nameCount) + 1}号`;
  }
  const rawTopN = cfg.performance && Number.isFinite(cfg.performance.topFamilies) ? cfg.performance.topFamilies : 20;
  const topN = Math.max(1, Math.min(count, rawTopN | 0));
  return {
    enabled: !!cfg.guilds.enabled,
    count,
    names,
    treasury: new Float64Array(count),
    level: new Int32Array(count),
    wins: new Int32Array(count),
    wars: 0,
    treasuryTotal: 0,
    lastStats: null,
    topN,
    // —— 内部复用缓冲（每次 tick/聚合 fill(0) 即可，不再分配）——
    _memberCount: new Int32Array(count),
    _memberAssets: new Float64Array(count),
    _eligible: new Int32Array(count),
    _cumMembers: new Int32Array(count),
    _guildTotal: new Float64Array(count),
    _idx: new Int32Array(count),
    _champA: new Int32Array(MAX_CHAMPIONS),
    _champB: new Int32Array(MAX_CHAMPIONS),
    _statPools: null,
  };
}

/**
 * 建号时入会：按 cfg.guilds.joinChance 随机加入某个公会，返回 guildId 或 -1。
 *
 * @param {GuildSystem} guildSys 公会系统
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置（运行时以 cfg.guilds.enabled / joinChance 为准）
 * @returns {number} 公会 ID（0..count-1）或 -1（未入会）
 */
export function guildForNewAgent(guildSys, rng, cfg) {
  const g = cfg.guilds;
  if (!g.enabled) return -1;
  const chance = g.joinChance;
  if (!(chance > 0)) return -1; // 概率为 0：不消耗随机数
  if (chance < 1 && rng.float() >= chance) return -1;
  return rng.int(guildSys.count);
}

/**
 * 后代入会：父系公会优先（父/母有公会则继承该公会），否则按 joinChance 随机入会。
 *
 * @param {GuildSystem} guildSys 公会系统
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {number} parentGuild 父方（或母方）公会 ID，-1 表示无
 * @param {object} cfg 归一化配置
 * @returns {number} 公会 ID 或 -1
 */
export function inheritGuild(guildSys, rng, parentGuild, cfg) {
  const g = cfg.guilds;
  if (!g.enabled) return -1;
  if (parentGuild >= 0 && parentGuild < guildSys.count) return parentGuild;
  return guildForNewAgent(guildSys, rng, cfg);
}

/**
 * 生成「几何间隔」：跳过多少个候选（非成员）后招收 1 人。
 * P(gap=g) = (1-rate)^g × rate，等价于「每名非成员独立按 rate 掷骰」。
 *
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {number} logRate ln(1-rate)（<0）
 * @returns {number} 间隔（≥0）
 */
function nextRecruitGap(rng, logRate) {
  // U ∈ (0,1]，gap = floor(ln(U)/ln(1-rate))
  const u = 1 - rng.float();
  const gap = Math.floor(Math.log(u) / logRate);
  return gap < 0 ? 0 : gap;
}

/**
 * 从 aliveList 中用拒绝采样抽取指定阵营的出战成员（去重，最多 want 名）。
 * 抽取失败超过上限时返回实际找到的人数（极小公会场景不会拖慢整体）。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {Int32Array} outBuf 输出槽位缓冲
 * @param {number} guildId 目标公会 ID
 * @param {number} want 期望人数
 * @returns {number} 实际抽到的出战人数
 */
function sampleChampions(store, rng, outBuf, guildId, want) {
  const list = store.aliveList;
  const n = store.aliveCount;
  const alive = store.alive;
  const guild = store.guild;
  if (n <= 0) return 0;
  const maxTries = want * CHAMPION_TRIES_PER_PICK;
  let found = 0;
  let tries = 0;
  while (found < want && tries < maxTries) {
    tries++;
    const slot = list[rng.int(n)];
    if (alive[slot] === 0 || guild[slot] !== guildId) continue;
    let dup = false;
    for (let k = 0; k < found; k++) {
      if (outBuf[k] === slot) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    outBuf[found++] = slot;
  }
  return found;
}

/**
 * ④ 公会等级更新：level = min(maxLevel, floor(金库余额 / levelUpAssets))。
 * 只按金库余额计算（不含成员个人资产）；金库被兜底/团体战消耗时等级允许下降（特性）。
 * 单独成函数，避免把内层循环撑大影响 tickGuilds 热点循环的 JIT 优化。
 *
 * @param {GuildSystem} guildSys 公会系统
 * @param {object} cfg 归一化配置
 * @returns {void}
 */
function updateGuildLevels(guildSys, cfg) {
  const count = guildSys.count;
  const treasury = guildSys.treasury;
  const level = guildSys.level;
  const g = cfg.guilds;
  const lvlDiv = g.levelUpAssets > 0 ? g.levelUpAssets : 1;
  const maxLvl = g.maxLevel;
  for (let gi = 0; gi < count; gi++) {
    const t = treasury[gi];
    let lv = t > 0 ? Math.floor(t / lvlDiv) : 0;
    if (lv > maxLvl) lv = maxLvl;
    level[gi] = lv;
  }
}

/**
 * ⑤ 公会团体战：按成员数加权随机选 2 个有成员的公会，各随机抽 warChampionCount 名出战者，
 * 用各自策略基因逐对出拳决胜；赢家金库获得对方下注（上限 = 对方金库余额），wins++。
 * 全部为金库 ↔ 金库的资产转移，不产生 created/destroyed。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {GuildSystem} guildSys 公会系统
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置
 * @param {number} round 当前回合
 * @param {object} report tickGuilds 报告（原地写入 wars / events）
 * @returns {void}
 */
function runGuildWar(store, guildSys, rng, cfg, round, report) {
  const g = cfg.guilds;
  const count = guildSys.count;
  const treasury = guildSys.treasury;
  const wins = guildSys.wins;
  const memberCount = guildSys._memberCount;
  const eligible = guildSys._eligible;
  const cum = guildSys._cumMembers;
  let m = 0;
  let totalMembers = 0;
  for (let gi = 0; gi < count; gi++) {
    const c = memberCount[gi];
    if (c > 0) {
      totalMembers += c;
      cum[m] = totalMembers;
      eligible[m++] = gi;
    }
  }
  if (m < 2) return;
  if (!(rng.float() < g.warChance)) return;
  // A 方：按成员数加权抽取
  const ra = rng.int(totalMembers);
  let ka = 0;
  while (cum[ka] <= ra) ka++;
  const guildA = eligible[ka];
  // B 方：在其余公会的成员中加权抽取
  const otherTotal = totalMembers - memberCount[guildA];
  if (otherTotal <= 0) return;
  const rb = rng.int(otherTotal);
  let acc = 0;
  let guildB = -1;
  for (let k = 0; k < m; k++) {
    const gi = eligible[k];
    if (gi === guildA) continue;
    acc += memberCount[gi];
    if (rb < acc) {
      guildB = gi;
      break;
    }
  }
  if (guildB < 0) return;
  const want = Math.max(1, Math.min(MAX_CHAMPIONS, g.warChampionCount));
  const ca = sampleChampions(store, rng, guildSys._champA, guildA, want);
  const cb = sampleChampions(store, rng, guildSys._champB, guildB, want);
  const bouts = ca < cb ? ca : cb;
  if (bouts <= 0) return;
  const gene = store.gene;
  const warStake = g.warStake;
  let moved = 0;
  let winsA = 0;
  let winsB = 0;
  for (let k = 0; k < bouts; k++) {
    const ma = pickMove(rng, gene, guildSys._champA[k] * GENE_COUNT);
    const mb = pickMove(rng, gene, guildSys._champB[k] * GENE_COUNT);
    if (ma === mb) continue; // 平局不下注
    const aWins = (ma - mb + 3) % 3 === 2;
    const winner = aWins ? guildA : guildB;
    const loser = aWins ? guildB : guildA;
    const lostTreasury = treasury[loser];
    const bet = warStake < lostTreasury ? warStake : lostTreasury;
    if (bet > 0) {
      treasury[loser] = lostTreasury - bet;
      treasury[winner] += bet;
      moved += bet;
    }
    wins[winner]++;
    if (aWins) winsA++;
    else winsB++;
  }
  guildSys.wars++;
  report.wars = 1;
  const cap = cfg.performance.eventLogSize;
  if (report.events.length < cap) {
    const draws = bouts - winsA - winsB;
    report.events.push({
      round,
      type: 'guild.war',
      title: '公会团体战',
      detail: `${guildSys.names[guildA]} vs ${guildSys.names[guildB]}：${winsA} 胜 ${winsB} 负${
        draws > 0 ? ` ${draws} 平` : ''
      }，金库转移 ${moved.toFixed(0)}`,
      delta: 0,
    });
  }
}

/**
 * 每回合公会逻辑（引擎在「世界事件之后、个体阶段之前」调用一次）。
 *
 * 顺序固定：① 成员缴金 → ② 濒临破产兜底/开除 → ③ 招收新成员 → ④ 等级更新 → ⑤ 团体战。
 * 只修改 store.assets / store.guild；不扩容 store、不重建 aliveList；全部为资产转移。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {GuildSystem} guildSys 公会系统
 * @param {import('./rng.js').Rng} rng 随机源
 * @param {object} cfg 归一化配置
 * @param {number} round 当前回合
 * @returns {{events:Array<{round:number,type:string,title:string,detail:string,delta:number}>,covered:number,expelled:number,recruited:number,wars:number,treasuryTotal:number}}
 */
export function tickGuilds(store, guildSys, rng, cfg, round) {
  const report = {
    events: [],
    covered: 0,
    expelled: 0,
    recruited: 0,
    wars: 0,
    treasuryTotal: guildSys.treasuryTotal,
  };
  const g = cfg.guilds;
  if (!g.enabled) return report;
  const count = guildSys.count;
  const n = store.aliveCount;
  if (n <= 0) return report;

  const guild = store.guild;
  const assets = store.assets;
  const debtLimit = store.debtLimit;
  const alive = store.alive;
  const list = store.aliveList;
  const treasury = guildSys.treasury;
  const memberCount = guildSys._memberCount;
  memberCount.fill(0);

  const contributeRate = g.contributeRate;
  const doContribute = contributeRate > 0;
  const coverRatio = g.coverRatio;
  const expelBelowRatio = g.expelBelowRatio;
  const recruitRate = g.recruitChance;
  const recruitAll = recruitRate >= 1;
  const recruitLog = recruitRate > 0 && recruitRate < 1 ? Math.log1p(-recruitRate) : 0;
  let recruitCountdown = recruitAll ? 0 : recruitLog !== 0 ? nextRecruitGap(rng, recruitLog) : -1;
  let covered = 0;
  let expelled = 0;
  let recruited = 0;

  // ── ① 缴金 / ② 兜底+开除 / ③ 招收（单次 O(aliveCount) 扫描）──
  // 热点循环：非成员走招收分支（不读 assets），成员只读一次 assets 并在本地变量上完成
  // 缴金/兜底/成员统计，避免重复的 TypedArray 读取。
  for (let i = 0; i < n; i++) {
    const s = list[i];
    if (alive[s] === 0) continue; // 防御：调用方尚未重建 aliveList 时的死亡墓碑
    let gid = guild[s];
    if (gid < 0) {
      // ③ 招收非成员：几何间隔计数，只对实际招到的人消耗随机数
      if (recruitCountdown >= 0) {
        if (recruitCountdown === 0) {
          const gid2 = rng.int(count);
          guild[s] = gid2;
          memberCount[gid2]++;
          recruited++;
          recruitCountdown = recruitAll ? 0 : nextRecruitGap(rng, recruitLog);
        } else {
          recruitCountdown--;
        }
      }
      continue;
    }
    if (gid >= count) {
      guild[s] = -1; // 防御：非法公会 ID（按非成员处理，本回合不招收）
      continue;
    }
    let a = assets[s];
    // ① 缴金：把正资产的一部分缴入公会金库
    if (doContribute && a > 0) {
      const cut = a * contributeRate;
      a -= cut;
      assets[s] = a;
      treasury[gid] += cut;
    }
    // ② 濒临破产：金库兜底（coverRatio × 债务缺口，受金库余额限制）
    //    债务缺口 = -资产（即负资产规模）；兜底后仍低于开除线则开除。
    //    例：资产 -480、负债上限 500、expelBelowRatio 0.9（开除线 -450）、coverRatio 0.8
    //    → 金库最多补 384，资产回到 -96（安全）；若金库不足补到 -450 以下则开除。
    if (a < 0) {
      const line = -debtLimit[s] * expelBelowRatio;
      if (a < line) {
        if (coverRatio > 0) {
          const avail = treasury[gid];
          if (avail > 0) {
            const want = -a * coverRatio;
            const cover = want < avail ? want : avail;
            if (cover > 0) {
              treasury[gid] = avail - cover;
              a += cover;
              assets[s] = a;
              covered++;
            }
          }
        }
        // 兜底后仍低于开除线 → 开除（guild = -1，本回合不参与招收）
        if (a < line) {
          guild[s] = -1;
          expelled++;
          continue;
        }
      }
    }
    // 成员统计（用于团体战按成员数加权选公会；等级只看金库，不再累加成员资产）
    memberCount[gid]++;
  }

  // ── ④ 公会等级更新 ──
  updateGuildLevels(guildSys, cfg);

  // ── ⑤ 公会团体战 ──
  if (g.warChance > 0 && count >= 2) runGuildWar(store, guildSys, rng, cfg, round, report);

  // 金库总额：O(count) 求和（count ≤ 256），供引擎记账/快照使用
  let treasuryTotal = 0;
  for (let gi = 0; gi < count; gi++) treasuryTotal += treasury[gi];
  guildSys.treasuryTotal = treasuryTotal;
  report.treasuryTotal = treasuryTotal;
  report.covered = covered;
  report.expelled = expelled;
  report.recruited = recruited;
  return report;
}

/**
 * 确保聚合输出对象池存在（对象只创建一次，之后复用）。
 *
 * @param {GuildSystem} guildSys 公会系统
 * @returns {{wealth:object[],members:object[],wars:object[]}} 对象池
 */
function ensureStatPools(guildSys) {
  if (guildSys._statPools) return guildSys._statPools;
  const topN = guildSys.topN;
  const wealth = new Array(topN);
  const members = new Array(topN);
  const warItems = new Array(topN);
  for (let i = 0; i < topN; i++) {
    wealth[i] = { id: 0, name: '', level: 0, members: 0, treasury: 0, memberAssets: 0, totalWealth: 0, wins: 0 };
    members[i] = { id: 0, name: '', level: 0, members: 0, treasury: 0, wins: 0 };
    warItems[i] = { id: 0, name: '', level: 0, members: 0, wins: 0 };
  }
  guildSys.lastStats = {
    enabled: false,
    total: 0,
    wars: 0,
    treasuryTotal: 0,
    avgLevel: 0,
    topWealth: [],
    topMembers: [],
    topWars: [],
  };
  guildSys._statPools = { wealth, members, wars: warItems };
  return guildSys._statPools;
}

/**
 * 聚合并返回快照用公会榜（字段严格按 CONTRACTS §10 / PROTOCOL §3）。
 *
 * 复用 guildSys.lastStats 对象与对象池：每次调用只刷新字段/数组内容，不新建榜单对象；
 * 一次 O(aliveCount) 扫描统计成员数与成员资产，再对 ≤256 个公会排序取 TopN。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {GuildSystem} guildSys 公会系统
 * @param {object} cfg 归一化配置
 * @returns {{enabled:boolean,total:number,wars:number,treasuryTotal:number,avgLevel:number,topWealth:object[],topMembers:object[],topWars:object[]}}
 */
export function aggregateGuilds(store, guildSys, cfg) {
  const pools = ensureStatPools(guildSys);
  const stats = guildSys.lastStats;
  const count = guildSys.count;
  const enabled = !!(cfg.guilds && cfg.guilds.enabled);
  stats.enabled = enabled;
  stats.total = count;
  stats.wars = guildSys.wars;
  if (!enabled) {
    stats.treasuryTotal = 0;
    stats.avgLevel = 0;
    stats.topWealth.length = 0;
    stats.topMembers.length = 0;
    stats.topWars.length = 0;
    return stats;
  }

  const memberCount = guildSys._memberCount;
  const memberAssets = guildSys._memberAssets;
  memberCount.fill(0);
  memberAssets.fill(0);
  const guild = store.guild;
  const alive = store.alive;
  const assets = store.assets;
  const list = store.aliveList;
  const n = store.aliveCount;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    if (alive[s] === 0) continue;
    const gid = guild[s];
    if (gid < 0 || gid >= count) continue;
    memberCount[gid]++;
    memberAssets[gid] += assets[s];
  }

  const treasury = guildSys.treasury;
  const level = guildSys.level;
  const wins = guildSys.wins;
  const total = guildSys._guildTotal;
  let treasuryTotal = 0;
  let levelSum = 0;
  for (let gi = 0; gi < count; gi++) {
    const t = treasury[gi] + memberAssets[gi];
    total[gi] = t;
    treasuryTotal += treasury[gi];
    levelSum += level[gi];
  }
  stats.treasuryTotal = treasuryTotal;
  stats.avgLevel = count > 0 ? levelSum / count : 0;
  guildSys.treasuryTotal = treasuryTotal;

  const topN = Math.min(guildSys.topN, count);
  const idx = guildSys._idx;
  for (let gi = 0; gi < count; gi++) idx[gi] = gi;
  const view = idx.subarray(0, count);
  const names = guildSys.names;

  // 资产榜：按 金库+成员资产 降序
  view.sort((a, b) => total[a] - total[b]);
  const wealthItems = pools.wealth;
  for (let i = 0; i < topN; i++) {
    const gid = idx[count - 1 - i];
    const it = wealthItems[i];
    it.id = gid;
    it.name = names[gid];
    it.level = level[gid];
    it.members = memberCount[gid];
    it.treasury = treasury[gid];
    it.memberAssets = memberAssets[gid];
    it.totalWealth = total[gid];
    it.wins = wins[gid];
  }
  stats.topWealth.length = topN;
  for (let i = 0; i < topN; i++) stats.topWealth[i] = wealthItems[i];

  // 人数榜
  view.sort((a, b) => memberCount[a] - memberCount[b]);
  const memberItems = pools.members;
  for (let i = 0; i < topN; i++) {
    const gid = idx[count - 1 - i];
    const it = memberItems[i];
    it.id = gid;
    it.name = names[gid];
    it.level = level[gid];
    it.members = memberCount[gid];
    it.treasury = treasury[gid];
    it.wins = wins[gid];
  }
  stats.topMembers.length = topN;
  for (let i = 0; i < topN; i++) stats.topMembers[i] = memberItems[i];

  // 胜场榜
  view.sort((a, b) => wins[a] - wins[b]);
  const warItems = pools.wars;
  for (let i = 0; i < topN; i++) {
    const gid = idx[count - 1 - i];
    const it = warItems[i];
    it.id = gid;
    it.name = names[gid];
    it.level = level[gid];
    it.members = memberCount[gid];
    it.wins = wins[gid];
  }
  stats.topWars.length = topN;
  for (let i = 0; i < topN; i++) stats.topWars[i] = warItems[i];

  return stats;
}
