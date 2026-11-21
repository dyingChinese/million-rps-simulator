/**
 * test/guilds.test.js — 公会模式子系统单元测试
 *
 * 运行：node test/guilds.test.js
 *
 * 覆盖：
 *  - GUILD_NAMES / createGuildSystem 结构、关闭模式；
 *  - 建号入会与后代继承（joinChance 概率、父系优先）；
 *  - 缴金为资产转移（成员减少 = 金库增加，全系统总资产守恒）；
 *  - 濒临破产金库兜底 / 金库不足仍超限则开除 / coverRatio 足够时避免破产；
 *  - 招收新成员（recruitChance=1 与概率模式、同 seed 可复现）；
 *  - 等级 = floor((金库+成员资产)/levelUpAssets)，上限 maxLevel；
 *  - 公会团体战：金库间转移守恒、wins、guild.war 事件、下注受对方金库余额限制；
 *  - aggregateGuilds：字段/排序正确、复用 lastStats 对象、禁用时空榜单；
 *  - 不扩容 store、不重建 aliveList；
 *  - 1M 人口 tickGuilds 单次耗时（目标 <10ms）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createConfig } from '../src/core/config.js';
import { Rng } from '../src/core/rng.js';
import { AgentStore } from '../src/core/store.js';
import {
  GUILD_NAMES,
  createGuildSystem,
  guildForNewAgent,
  inheritGuild,
  tickGuilds,
  aggregateGuilds,
} from '../src/core/guilds.js';

// ────────────────────────────── 测试工具 ──────────────────────────────

/** 相对误差断言 */
function assertClose(actual, expected, eps, msg) {
  const tol = eps * Math.max(1, Math.abs(expected));
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${msg || ''} 期望 ${expected}，实际 ${actual}（容差 ${tol}）`
  );
}

/** 构造 n 个存活个体（资产 1000、负债上限 cfg.maxDebt、默认石头基因、无公会） */
function makeGuildStore(n, cfg) {
  const store = new AgentStore(Math.max(4, n), cfg);
  for (let i = 0; i < n; i++) {
    const s = store.alloc(0);
    store.assets[s] = cfg.initialWealth;
    store.debtLimit[s] = cfg.maxDebt;
    store.costAffinity[s] = 1;
    store.guild[s] = -1;
    const off = s * 6;
    store.gene[off] = 1; // 石头
    store.gene[off + 1] = 0;
    store.gene[off + 2] = 0;
    store.gene[off + 3] = 1;
    store.gene[off + 4] = cfg.initialWealth * 0.5;
    store.gene[off + 5] = cfg.initialWealth * 2;
  }
  store.rebuildAliveList();
  return store;
}

/** 全系统总资产 = 所有公会金库 + 所有存活个体资产 */
function totalSystemWealth(store, guildSys) {
  let sum = 0;
  for (let g = 0; g < guildSys.count; g++) sum += guildSys.treasury[g];
  const list = store.aliveList;
  const n = store.aliveCount;
  const assets = store.assets;
  for (let i = 0; i < n; i++) sum += assets[list[i]];
  return sum;
}

/** 常用「安静」公会配置（不缴金/不兜底/不招收/不战争，便于单测机械化） */
function quietGuilds(patch) {
  return {
    enabled: true,
    count: 4,
    joinChance: 1,
    contributeRate: 0,
    coverRatio: 0,
    recruitChance: 0,
    warChance: 0,
    levelUpAssets: 1e9,
    ...patch,
  };
}

// ────────────────────────────── 测试 ──────────────────────────────

test('guilds: GUILD_NAMES ≥32 且互不重复；createGuildSystem 结构完整', () => {
  assert.ok(GUILD_NAMES.length >= 32, `公会名数量 ${GUILD_NAMES.length} 应 ≥32`);
  assert.equal(new Set(GUILD_NAMES).size, GUILD_NAMES.length, '公会名不应重复');

  const cfg = createConfig({ guilds: { enabled: true, count: 8 } });
  const sys = createGuildSystem(cfg);
  assert.equal(sys.enabled, true);
  assert.equal(sys.count, 8);
  assert.equal(sys.names.length, 8);
  assert.equal(sys.names[0], '青龙会');
  assert.ok(sys.treasury instanceof Float64Array && sys.treasury.length === 8, 'treasury 长度');
  assert.ok(sys.level instanceof Int32Array && sys.level.length === 8, 'level 长度');
  assert.ok(sys.wins instanceof Int32Array && sys.wins.length === 8, 'wins 长度');
  assert.equal(sys.wars, 0);
  assert.equal(sys.treasuryTotal, 0);
  assert.equal(sys.lastStats, null);

  // count 超过名字表长度（最多 256）时也能生成互不重复的展示名
  const big = createGuildSystem(createConfig({ guilds: { enabled: true, count: 128 } }));
  assert.equal(big.count, 128);
  assert.equal(new Set(big.names).size, 128, '128 个公会名应互不重复');

  // 关闭模式
  const off = createGuildSystem(createConfig({ guilds: { enabled: false } }));
  assert.equal(off.enabled, false);
});

test('guilds: 建号入会与后代继承（enabled / joinChance / 父系优先）', () => {
  const rng = new Rng(11);

  // 关闭公会模式：恒为 -1
  const cfgOff = createConfig({ guilds: { enabled: false } });
  const sysOff = createGuildSystem(cfgOff);
  assert.equal(guildForNewAgent(sysOff, rng, cfgOff), -1);
  assert.equal(inheritGuild(sysOff, rng, 0, cfgOff), -1);

  // joinChance = 0：恒不入会、父系无公会时也不入会
  const cfg0 = createConfig({ guilds: { enabled: true, count: 8, joinChance: 0 } });
  const sys0 = createGuildSystem(cfg0);
  for (let i = 0; i < 100; i++) assert.equal(guildForNewAgent(sys0, rng, cfg0), -1);
  assert.equal(inheritGuild(sys0, rng, -1, cfg0), -1);

  // joinChance = 1：必然入会，且 8 个公会都会被抽到
  const cfg1 = createConfig({ guilds: { enabled: true, count: 8, joinChance: 1 } });
  const sys1 = createGuildSystem(cfg1);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const g = guildForNewAgent(sys1, rng, cfg1);
    assert.ok(Number.isInteger(g) && g >= 0 && g < 8, `非法公会 ID ${g}`);
    seen.add(g);
  }
  assert.equal(seen.size, 8, '500 次抽签应覆盖全部 8 个公会');

  // 父系有公会 → 直接继承；无则随机入会
  assert.equal(inheritGuild(sys1, rng, 3, cfg1), 3);
  assert.equal(inheritGuild(sys1, rng, 7, cfg1), 7);
  for (let i = 0; i < 50; i++) {
    const g = inheritGuild(sys1, rng, -1, cfg1);
    assert.ok(g >= 0 && g < 8);
  }

  // 默认 joinChance=0.5：加入率约 50%
  const cfgHalf = createConfig({ guilds: { enabled: true, count: 8, joinChance: 0.5 } });
  const sysHalf = createGuildSystem(cfgHalf);
  let joined = 0;
  const draws = 4000;
  for (let i = 0; i < draws; i++) if (guildForNewAgent(sysHalf, rng, cfgHalf) >= 0) joined++;
  assert.ok(Math.abs(joined / draws - 0.5) < 0.03, `加入率 ${(joined / draws).toFixed(3)} 应≈0.5`);
});

test('guilds: 缴金为资产转移（成员减少 = 金库增加、总量守恒、非成员不缴）', () => {
  const cfg = createConfig({
    guilds: quietGuilds({ count: 4, contributeRate: 0.1, levelUpAssets: 1e9 }),
  });
  const store = makeGuildStore(100, cfg);
  for (let i = 0; i < 100; i++) store.guild[i] = 0;
  store.guild[99] = -1; // 留一个非成员
  const sys = createGuildSystem(cfg);
  const rng = new Rng(21);
  const before = totalSystemWealth(store, sys);
  const capBefore = store.capacity;
  const countBefore = store.count;
  const listCopy = Int32Array.from(store.aliveList.subarray(0, store.aliveCount));

  const rep = tickGuilds(store, sys, rng, cfg, 1);

  // 99 名成员 × 1000 × 10% = 9900 缴入金库
  assertClose(sys.treasury[0], 9900, 1e-9, '金库应收到缴金');
  for (let i = 0; i < 99; i++) assertClose(store.assets[i], 900, 1e-9, `成员 ${i} 缴金后资产`);
  assertClose(store.assets[99], 1000, 1e-9, '非成员不缴金');
  assertClose(rep.treasuryTotal, 9900, 1e-9, 'report.treasuryTotal');
  assertClose(totalSystemWealth(store, sys), before, 1e-9, '缴金前后全系统总资产守恒');
  assert.equal(rep.covered, 0);
  assert.equal(rep.expelled, 0);
  assert.equal(rep.recruited, 0);
  assert.equal(rep.wars, 0);
  // 不扩容、不重建 aliveList
  assert.equal(store.capacity, capBefore, '不得扩容');
  assert.equal(store.count, countBefore, '不得分配新槽位');
  assert.deepEqual(Array.from(store.aliveList.subarray(0, store.aliveCount)), Array.from(listCopy));

  // 第二回合：资产 900 → 每人缴 90
  tickGuilds(store, sys, rng, cfg, 2);
  assertClose(sys.treasury[0], 9900 + 99 * 90, 1e-9, '第二回合按 900×10% 续缴');
});

test('guilds: 濒临破产金库兜底 / 仍超限开除 / 兜底足额时避免破产', () => {
  // ── 场景 A：资产 -480 < 开除线 -450，金库 1000，coverRatio 0.8 → 补 384 → -96 安全 ──
  const cfg = createConfig({
    guilds: quietGuilds({ count: 4, coverRatio: 0.8, expelBelowRatio: 0.9 }),
  });
  {
    const store = makeGuildStore(3, cfg);
    for (let i = 0; i < 3; i++) store.guild[i] = 0;
    store.assets[0] = -480;
    store.assets[1] = -460;
    store.assets[2] = 100;
    const sys = createGuildSystem(cfg);
    sys.treasury[0] = 1000;
    const before = totalSystemWealth(store, sys);
    const rep = tickGuilds(store, sys, new Rng(22), cfg, 1);
    assertClose(store.assets[0], -96, 1e-9, '兜底后资产 -96');
    assertClose(store.assets[1], -92, 1e-9, '兜底后资产 -92');
    assert.equal(rep.covered, 2, '两人被兜底');
    assert.equal(rep.expelled, 0, '兜底后不应对其开除');
    assert.equal(store.guild[0], 0);
    assert.equal(store.guild[1], 0);
    assertClose(sys.treasury[0], 1000 - 384 - 368, 1e-9, '金库扣减总额');
    assertClose(totalSystemWealth(store, sys), before, 1e-9, '兜底为资产转移，总量守恒');
  }
  // ── 场景 B：金库为 0 → 无法兜底 → 开除 ──
  {
    const store = makeGuildStore(2, cfg);
    store.guild[0] = 0;
    store.guild[1] = 0;
    store.assets[0] = -480;
    store.assets[1] = 100;
    const sys = createGuildSystem(cfg);
    const rep = tickGuilds(store, sys, new Rng(23), cfg, 1);
    assert.equal(rep.covered, 0);
    assert.equal(rep.expelled, 1);
    assert.equal(store.guild[0], -1, '开除后 guild = -1');
    assertClose(store.assets[0], -480, 1e-9, '开除不改变资产（由引擎做破产处理）');
    assertClose(sys.treasury[0], 0, 1e-9);
  }
  // ── 场景 C：金库不足（-600，金库 100 → 补 100 → -500 < -450 → 开除）──
  {
    const store = makeGuildStore(2, cfg);
    store.guild[0] = 0;
    store.assets[0] = -600;
    store.assets[1] = 100;
    const sys = createGuildSystem(cfg);
    sys.treasury[0] = 100;
    const before = totalSystemWealth(store, sys);
    const rep = tickGuilds(store, sys, new Rng(24), cfg, 1);
    assert.equal(rep.covered, 1);
    assert.equal(rep.expelled, 1);
    assertClose(store.assets[0], -500, 1e-9);
    assertClose(sys.treasury[0], 0, 1e-9);
    assert.equal(store.guild[0], -1);
    assertClose(totalSystemWealth(store, sys), before, 1e-9);
  }
  // ── 场景 D：coverRatio=1 且金库充足 → -600 补到 0，避免破产 ──
  {
    const cfgFull = createConfig({
      guilds: quietGuilds({ count: 4, coverRatio: 1, expelBelowRatio: 0.9 }),
    });
    const store = makeGuildStore(2, cfgFull);
    store.guild[0] = 0;
    store.assets[0] = -600;
    store.assets[1] = 100;
    const sys = createGuildSystem(cfgFull);
    sys.treasury[0] = 1000;
    const rep = tickGuilds(store, sys, new Rng(25), cfgFull, 1);
    assertClose(store.assets[0], 0, 1e-9, '全额兜底后债务清零');
    assert.equal(rep.covered, 1);
    assert.equal(rep.expelled, 0);
    assert.equal(store.guild[0], 0, '未开除');
    assert.ok(store.assets[0] > -cfg.maxDebt, '兜底后高于破产线（引擎不会判破产）');
    assertClose(sys.treasury[0], 400, 1e-9);
  }
});

test('guilds: 招收新成员（recruitChance=1 与概率模式、同 seed 可复现）', () => {
  // ── recruitChance=1：所有非成员本回合全部入会 ──
  const cfgAll = createConfig({
    guilds: quietGuilds({ count: 4, joinChance: 0, recruitChance: 1 }),
  });
  const store = makeGuildStore(200, cfgAll);
  const sys = createGuildSystem(cfgAll);
  const before = totalSystemWealth(store, sys);
  const rep = tickGuilds(store, sys, new Rng(31), cfgAll, 1);
  assert.equal(rep.recruited, 200, '200 名非成员应全部被招收');
  for (let i = 0; i < 200; i++) {
    assert.ok(store.guild[i] >= 0 && store.guild[i] < 4, `个体 ${i} 应已入会`);
  }
  assertClose(totalSystemWealth(store, sys), before, 1e-9, '招收不改变总资产');
  // 已入会者不会重复招收
  assert.equal(tickGuilds(store, sys, new Rng(32), cfgAll, 2).recruited, 0);

  // ── 概率模式 recruitChance=0.1：1000 非成员约 100 人被招收，同 seed 可复现 ──
  const cfgP = createConfig({
    guilds: quietGuilds({ count: 4, joinChance: 0, recruitChance: 0.1 }),
  });
  const storeP = makeGuildStore(1000, cfgP);
  const sysP = createGuildSystem(cfgP);
  const repP = tickGuilds(storeP, sysP, new Rng(33), cfgP, 1);
  assert.ok(repP.recruited > 60 && repP.recruited < 140, `10% 招收人数 ${repP.recruited} 应≈100`);

  const storeP2 = makeGuildStore(1000, cfgP);
  const sysP2 = createGuildSystem(cfgP);
  const repP2 = tickGuilds(storeP2, sysP2, new Rng(33), cfgP, 1);
  assert.equal(repP2.recruited, repP.recruited, '同 seed 招收人数应一致');
  assert.deepEqual(
    Array.from(storeP2.guild.subarray(0, 1000)),
    Array.from(storeP.guild.subarray(0, 1000)),
    '同 seed 入会结果应完全一致'
  );
});

test('guilds: 等级 = floor(金库/levelUpAssets)（仅金库、上限 maxLevel、金库消耗可降级）', () => {
  const cfg = createConfig({
    guilds: quietGuilds({
      count: 4,
      levelUpAssets: 1000,
      maxLevel: 5,
    }),
  });
  const store = makeGuildStore(4, cfg);
  store.guild[0] = 0;
  store.guild[1] = 0;
  store.guild[2] = 1;
  store.guild[3] = 1;
  store.assets[0] = 500;
  store.assets[1] = 500;
  store.assets[2] = 100;
  store.assets[3] = 100;
  const sys = createGuildSystem(cfg);
  sys.treasury[0] = 1000; // 仅金库计级：1000/1000 = 1
  sys.treasury[1] = 500; // 0
  sys.treasury[2] = 1e9; // 封顶 maxLevel
  const rng = new Rng(41);
  tickGuilds(store, sys, rng, cfg, 1);
  assert.equal(sys.level[0], 1, '公会0 等级只看金库：1000/1000=1（不计成员资产）');
  assert.equal(sys.level[1], 0, '公会1 等级');
  assert.equal(sys.level[2], 5, '公会2 等级应封顶 maxLevel');
  assert.equal(sys.level[3], 0, '空公会等级为 0');

  // 成员个人资产不计入等级：把成员资产拉到 100 万，等级仍只由金库决定
  store.assets[0] = 1e6;
  store.assets[1] = 1e6;
  tickGuilds(store, sys, rng, cfg, 2);
  assert.equal(sys.level[0], 1, '成员个人资产不影响公会等级');

  // 金库增长 → 升级
  sys.treasury[0] = 3500;
  tickGuilds(store, sys, rng, cfg, 3);
  assert.equal(sys.level[0], 3, '金库 3500 → 3 级');

  // 金库被兜底/团体战消耗 → 等级允许下降（特性）
  sys.treasury[0] = 400;
  tickGuilds(store, sys, rng, cfg, 4);
  assert.equal(sys.level[0], 0, '金库消耗后等级允许下降');

  // aggregate 的 avgLevel 使用等级数组平均值
  const stats = aggregateGuilds(store, sys, cfg);
  assert.equal(stats.total, 4);
  const expectAvg = (sys.level[0] + sys.level[1] + sys.level[2] + sys.level[3]) / 4;
  assertClose(stats.avgLevel, expectAvg, 1e-12, 'avgLevel');
  assert.equal(stats.topWealth[0].id, 2, '总资产最高的公会应排第一');
});

test('guilds: 公会团体战——金库间转移守恒、wins、guild.war 事件、下注受限', () => {
  const cfg = createConfig({
    guilds: quietGuilds({ count: 4, warChance: 1, warChampionCount: 2, warStake: 50 }),
  });
  const makeWarStore = (rockPaper) => {
    const store = makeGuildStore(100, cfg);
    for (let i = 0; i < 50; i++) store.guild[i] = 0;
    for (let i = 50; i < 100; i++) store.guild[i] = 1;
    if (rockPaper) {
      // 公会0 全出石头，公会1 全出布（布胜石头，结果确定）
      for (let i = 0; i < 50; i++) {
        const off = i * 6;
        store.gene[off] = 1;
        store.gene[off + 1] = 0;
        store.gene[off + 2] = 0;
      }
      for (let i = 50; i < 100; i++) {
        const off = i * 6;
        store.gene[off] = 0;
        store.gene[off + 1] = 0;
        store.gene[off + 2] = 1;
      }
    }
    return store;
  };

  // ── 正常开战：guild1（布）两场全胜 guild0（石头），每场赢 50 ──
  const store = makeWarStore(true);
  const sys = createGuildSystem(cfg);
  sys.treasury[0] = 1000;
  sys.treasury[1] = 1000;
  const before = totalSystemWealth(store, sys);
  const rep = tickGuilds(store, sys, new Rng(51), cfg, 7);

  assert.equal(rep.wars, 1, '本回合应发生 1 次团体战');
  assert.equal(sys.wars, 1, '累计团体战次数');
  assert.equal(rep.events.length, 1);
  assert.equal(rep.events[0].type, 'guild.war');
  assert.equal(rep.events[0].round, 7);
  assert.equal(rep.events[0].delta, 0, '公会战是内部转移，delta=0');
  assert.equal(sys.wins[1], 2, 'guild1 应赢下 2 场对决胜场');
  assert.equal(sys.wins[0], 0);
  assertClose(sys.treasury[1], 1100, 1e-9, 'guild1 金库 +100');
  assertClose(sys.treasury[0], 900, 1e-9, 'guild0 金库 -100');
  assertClose(totalSystemWealth(store, sys), before, 1e-9, '团体战为金库间转移，总资产守恒');
  assertClose(rep.treasuryTotal, 2000, 1e-9, '金库总额');
  assert.ok(rep.events[0].detail.includes('青龙会') && rep.events[0].detail.includes('白虎堂'), '事件文案含双方公会名');

  // 同 seed 可复现：金库 / 胜场 / 累计次数 / 事件文案完全一致
  const store2 = makeWarStore(true);
  const sys2 = createGuildSystem(cfg);
  sys2.treasury[0] = 1000;
  sys2.treasury[1] = 1000;
  const rep2 = tickGuilds(store2, sys2, new Rng(51), cfg, 7);
  assert.deepEqual(Array.from(sys2.treasury), Array.from(sys.treasury), '同 seed 金库结果一致');
  assert.deepEqual(Array.from(sys2.wins), Array.from(sys.wins), '同 seed 胜场一致');
  assert.equal(sys2.wars, sys.wars);
  assert.equal(rep2.events[0].detail, rep.events[0].detail, '同 seed 事件文案一致');

  // ── 下注上限 = 对方金库余额：guild0 金库只有 30 → 每场最多输 30 ──
  const store3 = makeWarStore(true);
  const sys3 = createGuildSystem(cfg);
  sys3.treasury[0] = 30;
  sys3.treasury[1] = 1000;
  const before3 = totalSystemWealth(store3, sys3);
  const rep3 = tickGuilds(store3, sys3, new Rng(52), cfg, 8);
  assert.equal(rep3.wars, 1);
  assertClose(sys3.treasury[0], 0, 1e-9, '输方金库最多扣到 0');
  assertClose(sys3.treasury[1], 1000 + 30, 1e-9, '赢方最多赢走对方全部金库');
  assertClose(totalSystemWealth(store3, sys3), before3, 1e-9);
});

test('guilds: 关闭模式不修改状态；aggregateGuilds 返回空榜单', () => {
  const cfg = createConfig({ guilds: { enabled: false, count: 4 } });
  const store = makeGuildStore(50, cfg);
  for (let i = 0; i < 50; i++) store.guild[i] = i % 4;
  const sys = createGuildSystem(cfg);
  const before = totalSystemWealth(store, sys);
  const rep = tickGuilds(store, sys, new Rng(61), cfg, 1);
  assert.equal(rep.covered + rep.expelled + rep.recruited + rep.wars, 0);
  assert.equal(rep.events.length, 0);
  assertClose(totalSystemWealth(store, sys), before, 1e-9);
  for (let i = 0; i < 50; i++) assert.equal(store.guild[i], i % 4, '关闭模式不得改动 guild 字段');

  const stats = aggregateGuilds(store, sys, cfg);
  assert.equal(stats.enabled, false);
  assert.equal(stats.total, 4);
  assert.deepEqual(stats.topWealth, []);
  assert.deepEqual(stats.topMembers, []);
  assert.deepEqual(stats.topWars, []);
});

test('guilds: aggregateGuilds 字段/排序正确且复用 lastStats 对象', () => {
  const cfg = createConfig({
    guilds: { enabled: true, count: 4 },
    performance: { topFamilies: 2 },
  });
  const store = makeGuildStore(6, cfg);
  // 公会0：2 名成员（100 + 200），金库 100 → 总 400
  store.guild[0] = 0;
  store.guild[1] = 0;
  store.assets[0] = 100;
  store.assets[1] = 200;
  // 公会1：1 名成员（500），金库 200 → 总 700
  store.guild[2] = 1;
  store.assets[2] = 500;
  // 公会2：3 名成员（各 50），金库 0 → 总 150
  store.guild[3] = 2;
  store.guild[4] = 2;
  store.guild[5] = 2;
  store.assets[3] = 50;
  store.assets[4] = 50;
  store.assets[5] = 50;
  // 公会3：无成员，金库 5000 → 总 5000
  const sys = createGuildSystem(cfg);
  sys.treasury[0] = 100;
  sys.treasury[1] = 200;
  sys.treasury[3] = 5000;
  sys.level[0] = 1;
  sys.level[1] = 2;
  sys.level[3] = 3;
  sys.wins[1] = 4;
  sys.wars = 2;

  const stats = aggregateGuilds(store, sys, cfg);
  assert.equal(stats.enabled, true);
  assert.equal(stats.total, 4, 'total = 公会数');
  assert.equal(stats.wars, 2);
  assertClose(stats.treasuryTotal, 5300, 1e-9, 'treasuryTotal');
  assertClose(stats.avgLevel, (1 + 2 + 0 + 3) / 4, 1e-12, 'avgLevel');
  assert.equal(stats.topWealth.length, 2, 'topN 由 performance.topFamilies 决定');
  // 资产榜：公会3(5000) > 公会1(700)；topN=2
  assert.deepEqual(stats.topWealth.map((x) => x.id), [3, 1]);
  assert.equal(stats.topWealth[0].name, '玄武盟');
  assertClose(stats.topWealth[0].totalWealth, 5000, 1e-9);
  assertClose(stats.topWealth[0].treasury, 5000, 1e-9);
  assert.equal(stats.topWealth[0].members, 0);
  assertClose(stats.topWealth[1].totalWealth, 700, 1e-9);
  assertClose(stats.topWealth[1].memberAssets, 500, 1e-9);
  assert.equal(stats.topWealth[1].members, 1);
  assert.equal(stats.topWealth[1].wins, 4);
  // 人数榜：公会2(3) > 公会0(2)
  assert.deepEqual(stats.topMembers.map((x) => x.id), [2, 0]);
  assert.equal(stats.topMembers[0].members, 3);
  // 胜场榜：公会1(4) 第一
  assert.equal(stats.topWars.length, 2);
  assert.equal(stats.topWars[0].id, 1);
  assert.equal(stats.topWars[0].wins, 4);
  // 字段齐全且为有限数
  for (const item of [stats.topWealth[0], stats.topWealth[1]]) {
    for (const key of ['id', 'name', 'level', 'members', 'treasury', 'memberAssets', 'totalWealth', 'wins']) {
      assert.ok(item[key] !== undefined, `topWealth 缺少字段 ${key}`);
    }
    for (const key of ['level', 'members', 'treasury', 'memberAssets', 'totalWealth', 'wins']) {
      assert.ok(Number.isFinite(item[key]), `topWealth.${key} 应为有限数`);
    }
  }

  // 复用 lastStats 对象与榜单条目对象（每帧不新建）
  const stats2 = aggregateGuilds(store, sys, cfg);
  assert.equal(stats2, stats, 'aggregateGuilds 应复用同一 lastStats 对象');
  assert.equal(stats2.topWealth[0], stats.topWealth[0], '榜单条目对象应复用');
  assert.equal(stats2.topMembers[0], stats.topMembers[0]);
  assert.equal(stats2.topWars[0], stats.topWars[0]);
});

test('guilds: 综合 500 个体单回合（缴金+兜底+招收+等级+团体战）总量守恒且可复现', () => {
  const cfg = createConfig({
    guilds: {
      enabled: true,
      count: 8,
      joinChance: 0.5,
      recruitChance: 0.05,
      contributeRate: 0.02,
      coverRatio: 0.8,
      expelBelowRatio: 0.9,
      levelUpAssets: 1000,
      maxLevel: 10,
      warChance: 1,
      warChampionCount: 3,
      warStake: 50,
    },
  });
  const n = 500;
  const run = () => {
    const store = makeGuildStore(n, cfg);
    const rng = new Rng(71);
    for (let i = 0; i < n; i++) {
      store.guild[i] = i % 10 === 0 ? -1 : i % 8;
      if (i % 37 === 0) store.assets[i] = -480; // 制造濒临破产成员
      if (i % 53 === 0) store.assets[i] = -520; // 制造需开除成员
    }
    store.rebuildAliveList();
    const sys = createGuildSystem(cfg);
    for (let gi = 0; gi < sys.count; gi++) sys.treasury[gi] = 200;
    const before = totalSystemWealth(store, sys);
    const capBefore = store.capacity;
    const listBefore = Int32Array.from(store.aliveList.subarray(0, store.aliveCount));
    const rep = tickGuilds(store, sys, rng, cfg, 1);
    // 全部是资产转移：总资产守恒
    assertClose(totalSystemWealth(store, sys), before, 1e-9, '综合场景总资产守恒');
    assertClose(rep.treasuryTotal, sys.treasuryTotal, 1e-9, 'report.treasuryTotal 与系统一致');
    // 不扩容、不重建 aliveList、不产生 NaN
    assert.equal(store.capacity, capBefore);
    assert.deepEqual(Array.from(store.aliveList.subarray(0, store.aliveCount)), Array.from(listBefore));
    for (let i = 0; i < store.aliveCount; i++) assert.ok(Number.isFinite(store.assets[store.aliveList[i]]));
    // 公会等级范围
    for (let gi = 0; gi < sys.count; gi++) {
      assert.ok(sys.level[gi] >= 0 && sys.level[gi] <= cfg.guilds.maxLevel, `公会 ${gi} 等级 ${sys.level[gi]} 越界`);
    }
    // 有成员的公会 id 必须合法
    for (let i = 0; i < n; i++) {
      const gid = store.guild[i];
      assert.ok(gid >= -1 && gid < sys.count, `个体 ${i} 公会 ID ${gid} 非法`);
    }
    assert.ok(rep.covered >= 0 && rep.expelled >= 0 && rep.recruited >= 0 && rep.wars >= 0);
    assert.ok(rep.wars <= 1, '单回合最多 1 场团体战');
    return {
      treasury: Array.from(sys.treasury),
      level: Array.from(sys.level),
      wins: Array.from(sys.wins),
      wars: sys.wars,
      guild: Array.from(store.guild.subarray(0, n)),
      assets: Array.from(store.assets.subarray(0, n)),
      events: rep.events.map((e) => e.detail),
    };
  };
  const a = run();
  const b = run();
  assert.deepEqual(b, a, '同 seed 的公会单回合结果应完全可复现');
});

test('guilds: 1M 人口 tickGuilds 单次耗时 < 10ms（目标性能）', () => {
  const cfg = createConfig({ initialPopulation: 1000000, guilds: { enabled: true, count: 32 } });
  const n = 1000000;
  const store = new AgentStore(n, cfg);
  store.count = n;
  const guildRng = new Rng(99);
  for (let s = 0; s < n; s++) {
    store.id[s] = s + 1;
    store.alive[s] = 1;
    store.assets[s] = 1000;
    store.debtLimit[s] = cfg.maxDebt;
    store.costAffinity[s] = 1;
    const off = s * 6;
    store.gene[off] = 0.34;
    store.gene[off + 1] = 0.33;
    store.gene[off + 2] = 0.33;
    store.gene[off + 3] = 1;
    store.gene[off + 4] = 500;
    store.gene[off + 5] = 2000;
    store.guild[s] = guildRng.float() < 0.5 ? guildRng.int(32) : -1;
  }
  store.rebuildAliveList();
  const sys = createGuildSystem(cfg);
  const rng = new Rng(123);
  const capBefore = store.capacity;
  const countBefore = store.count;
  tickGuilds(store, sys, rng, cfg, 1); // 预热
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    tickGuilds(store, sys, rng, cfg, k + 2);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const best = times[0];
  const median = times[2];
  assert.equal(store.capacity, capBefore, 'tickGuilds 不得扩容');
  assert.equal(store.count, countBefore, 'tickGuilds 不得分配新槽位');
  assert.ok(Number.isFinite(sys.treasuryTotal));
  // 目标 <10ms；这里按要求实测并断言一个宽松阈值（防慢机器/CI 抖动）
  assert.ok(best < 12, `1M 人口 tickGuilds 最优耗时 ${best.toFixed(2)}ms 应 < 12ms（目标 <10ms）`);

  // 快照聚合（每帧 1~2 次）在 1M 下同样应是 O(aliveCount) 的廉价扫描
  aggregateGuilds(store, sys, cfg); // 预热
  const aggTimes = [];
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    const stats = aggregateGuilds(store, sys, cfg);
    aggTimes.push(performance.now() - t0);
    assert.equal(stats.total, sys.count);
    assert.equal(stats.enabled, true);
    assert.ok(stats.topWealth.length > 0);
  }
  aggTimes.sort((a, b) => a - b);
  const aggBest = aggTimes[0];
  assert.ok(aggBest < 20, `1M 人口 aggregateGuilds 最优耗时 ${aggBest.toFixed(2)}ms 应 < 20ms`);
  console.log(
    `[perf] guilds.tickGuilds 1M 人口：最优 ${best.toFixed(2)}ms / 中位 ${median.toFixed(2)}ms；aggregateGuilds 最优 ${aggBest.toFixed(2)}ms`
  );
});
