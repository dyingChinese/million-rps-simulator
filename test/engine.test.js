/**
 * test/engine.test.js — 引擎集成测试：确定性、守恒、不变量、繁殖、结束条件、
 * 个体追踪、配置热更新、手动宏观调控、二进制快照协议。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { createConfig } from '../src/core/config.js';

const MAGIC = 0x52505331;

/** 小规模测试配置（跑得快，同时保留全部机制） */
function testConfig(patch = {}) {
  return createConfig({
    seed: 12345,
    initialPopulation: 2000,
    maxPopulation: 6000,
    initialWealth: 1000,
    maxDebt: 500,
    roundCost: 10,
    maxAge: 400,
    families: { count: 8 },
    macro: {
      average: { enabled: true, startRound: 20, everyRounds: 20, takePct: 5 },
      subsidy: { enabled: true, startRound: 1, everyRounds: 1, count: 20, amount: 10 },
    },
    endCondition: { mode: 'C', rounds: 150, noGrowthRounds: 50, threshold: 50000, pct: 10, maxRounds: 5000 },
    performance: { sampleSize: 512, snapshotIntervalMs: 80 },
    // 单元测试默认关闭并行线程池（避免创建大量 worker；并行模式另有专项测试）
    parallel: { enabled: false },
    ...patch,
  });
}

function relDiff(a, b) {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / scale;
}

test('同 seed 两次运行结果完全一致（确定性）', () => {
  const cfg = testConfig();
  const e1 = new Engine(cfg);
  const e2 = new Engine(cfg);
  for (let i = 0; i < 40; i++) {
    e1.tick();
    e2.tick();
  }
  const s1 = e1.getStatus();
  const s2 = e2.getStatus();
  assert.equal(s1.aliveCount, s2.aliveCount);
  assert.equal(s1.totalWealth, s2.totalWealth);
  assert.equal(s1.births, s2.births);
  assert.equal(s1.deaths, s2.deaths);
  assert.equal(s1.bankruptcies, s2.bankruptcies);
  // 基因/资产指纹一致
  const store1 = e1.store;
  const store2 = e2.store;
  let sum1 = 0;
  let sum2 = 0;
  for (let i = 0; i < store1.aliveCount; i++) {
    const s = store1.aliveList[i];
    sum1 += store1.assets[s] * store1.id[s];
    const t = store2.aliveList[i];
    sum2 += store2.assets[t] * store2.id[t];
  }
  assert.equal(sum1, sum2);
});

test('回合不变量：资产不跌破负债上限、年龄不超上限、无 NaN、ID 唯一', () => {
  const cfg = testConfig();
  const engine = new Engine(cfg);
  for (let r = 0; r < 60; r++) {
    engine.tick();
    const store = engine.store;
    const ids = new Set();
    for (let i = 0; i < store.aliveCount; i++) {
      const s = store.aliveList[i];
      const asset = store.assets[s];
      assert.ok(Number.isFinite(asset), `第 ${r} 回合资产为 NaN: id=${store.id[s]}`);
      // 破产/冻结机制允许跌破的上限：新手保护期内可能暂时超出
      assert.ok(
        asset >= -store.debtLimit[s] - 1e-6 || store.frozen[s] === 1,
        `资产 ${asset} < -负债上限 ${store.debtLimit[s]}（id=${store.id[s]}, age=${store.age[s]}）`,
      );
      assert.ok(store.age[s] <= cfg.maxAge, `年龄超限: ${store.age[s]}`);
      assert.ok(!ids.has(store.id[s]), `重复 ID: ${store.id[s]}`);
      ids.add(store.id[s]);
    }
  }
});

test('财富守恒：总资产变化 = 系统创造 - 系统销毁', () => {
  // 关闭调控/瘟疫等外部注资，走纯对局经济
  const cfg = testConfig({
    macro: {
      average: { enabled: false },
      redistribute: { enabled: false },
      disaster: { enabled: false },
      dividend: { enabled: false },
      subsidy: { enabled: false },
    },
    plague: { enabled: false },
    resourceLimited: { enabled: false },
  });
  const engine = new Engine(cfg);
  const initialTotal = cfg.initialPopulation * cfg.initialWealth;
  for (let r = 0; r < 50; r++) engine.tick();
  const expected = initialTotal + engine.created - engine.destroyed;
  const actual = engine.totalWealth;
  assert.ok(
    relDiff(expected, actual) < 1e-6,
    `财富不守恒: 期望 ${expected.toFixed(3)} 实际 ${actual.toFixed(3)} 差 ${(actual - expected).toFixed(3)}`,
  );
  assert.ok(engine.created >= 0 && engine.destroyed >= 0);
});

test('繁殖：后代代际递增、家族继承、繁殖次数不超限', () => {
  const cfg = testConfig({
    // 赌注倍率 > 1 时胜方净收益为正，才可能出现资产超过繁殖门槛的个体
    betMultiplier: 2.0,
    genetics: {
      reproWealthThreshold: 1050,
      minReproAge: 2,
      maxReproCount: 2,
      baseBirthCost: 50,
      birthCostRatio: 0.01,
      mutationRate: 0.1,
      reproChancePerRound: 0.5,
    },
    endCondition: { mode: 'C', rounds: 60, maxRounds: 5000 },
  });
  const engine = new Engine(cfg);
  for (let r = 0; r < 30; r++) engine.tick();
  assert.ok(engine.births > 0, '30 回合内应产生后代');
  const store = engine.store;
  let checkedChildren = 0;
  for (let i = 0; i < store.aliveCount; i++) {
    const s = store.aliveList[i];
    assert.ok(store.reproCount[s] <= cfg.genetics.maxReproCount, '繁殖次数超限');
    if (store.parentAId[s] > 0) {
      checkedChildren++;
      assert.ok(store.generation[s] > 0, '后代代数应 > 0');
      assert.ok(store.familyId[s] >= 0 && store.familyId[s] < cfg.families.count, '家族 ID 越界');
      assert.ok(store.id[s] > 0);
      // 策略概率归一化
      const g = s * 6;
      const sum = store.gene[g] + store.gene[g + 1] + store.gene[g + 2];
      assert.ok(Math.abs(sum - 1) < 0.35, `策略概率和异常: ${sum}`);
    }
  }
  assert.ok(checkedChildren > 0, '应存在带谱系的后代');
});

test('结束条件 C/A/D 均可正确触发', () => {
  // C：固定回合
  const eC = new Engine(testConfig({ endCondition: { mode: 'C', rounds: 5, maxRounds: 5000 } }));
  for (let i = 0; i < 5; i++) eC.tick();
  assert.equal(eC.getStatus().status, 'ended');
  assert.match(eC.endReason || '', /5 回合/);

  // A：首个资产达阈值（赌注倍率 2.5 时胜方净收益为正，高资产个体出现得快）
  const eA = new Engine(
    testConfig({
      initialPopulation: 500,
      maxPopulation: 2000,
      betMultiplier: 2.5,
      endCondition: { mode: 'A', threshold: 1050, rounds: 500, maxRounds: 5000 },
    }),
  );
  let endedA = false;
  for (let i = 0; i < 80; i++) if (eA.tick()) endedA = true;
  assert.ok(endedA, '模式 A 应在 80 回合内触发');

  // D：存活低于总人口比例
  const eD = new Engine(
    testConfig({
      initialPopulation: 300,
      maxPopulation: 600,
      maxAge: 5,
      genetics: { reproChancePerRound: 0, maxReproCount: 0 },
      endCondition: { mode: 'D', pct: 60, rounds: 500, maxRounds: 5000 },
    }),
  );
  let endedD = false;
  for (let i = 0; i < 30; i++) if (eD.tick()) endedD = true;
  assert.ok(endedD, '模式 D 应触发');
});

test('个体追踪：可追踪、曲线增长、可取消', () => {
  const engine = new Engine(testConfig());
  for (let i = 0; i < 10; i++) engine.tick();
  const store = engine.store;
  const id = store.id[store.aliveList[0]];
  const card = engine.trackById(id);
  assert.ok(card && card.id === id, '追踪应成功');
  for (let i = 0; i < 5; i++) engine.tick();
  const { json } = engine.snapshot(1);
  assert.ok(Array.isArray(json.tracked) && json.tracked.length === 1, '快照应包含追踪个体');
  assert.ok(json.tracked[0].history.length >= 10, '追踪曲线应有历史点');
  assert.equal(engine.untrackById(id), true);
  const { json: json2 } = engine.snapshot(2);
  assert.equal(json2.tracked.length, 0);
});

test('配置热更新：普通参数不重置、人口参数触发重置', () => {
  const engine = new Engine(testConfig());
  for (let i = 0; i < 5; i++) engine.tick();
  const roundBefore = engine.round;
  const r1 = engine.setConfig({ genetics: { mutationRate: 0.3 } });
  assert.equal(r1.ok, true);
  assert.equal(r1.reset, false);
  assert.equal(engine.round, roundBefore, '热更新不应重置回合');
  assert.equal(engine.cfg.genetics.mutationRate, 0.3);
  const r2 = engine.setConfig({ initialPopulation: 800 });
  assert.equal(r2.reset, true);
  assert.equal(engine.round, 0);
  assert.equal(engine.cfg.initialPopulation, 800);
  assert.equal(engine.store.aliveCount, 800);
});

test('手动宏观调控可用（平均/灾难/分红/保底/再分配）', () => {
  const engine = new Engine(testConfig());
  for (let i = 0; i < 3; i++) engine.tick();
  for (const kind of ['average', 'redistribute', 'disaster', 'dividend', 'subsidy']) {
    const report = engine.triggerMacro(kind);
    assert.ok(report && Array.isArray(report.events), `手动触发 ${kind} 应返回事件`);
  }
});

test('并行对战模式：线程池可用、结果满足不变量、可正常关闭', () => {
  const cfg = testConfig({
    initialPopulation: 20000,
    maxPopulation: 40000,
    parallel: { enabled: true, workers: 2, minPairs: 100 },
    endCondition: { mode: 'C', rounds: 30, maxRounds: 5000 },
  });
  const engine = new Engine(cfg);
  try {
    assert.equal(engine.parallelWorkers, 2, '应创建 2 个并行对战线程');
    assert.equal(engine.store.shared, true, '并行模式必须使用 SharedArrayBuffer');
    for (let r = 0; r < 12; r++) engine.tick();
    const store = engine.store;
    assert.ok(store.aliveCount > 0);
    let sum = 0;
    for (let i = 0; i < store.aliveCount; i++) {
      const s = store.aliveList[i];
      const asset = store.assets[s];
      assert.ok(Number.isFinite(asset), '并行后资产出现 NaN');
      sum += asset;
    }
    assert.ok(Math.abs(sum - engine.totalWealth) < 1e-6, '总资产与逐人求和应一致');
    const { buffer, json } = engine.snapshot(1);
    assert.ok(buffer.byteLength > 1000);
    assert.equal(json.engine.parallelWorkers, 2);
    // 财富守恒
    const expected = cfg.initialPopulation * cfg.initialWealth + engine.created - engine.destroyed;
    assert.ok(Math.abs(expected - engine.totalWealth) / Math.max(1, Math.abs(expected)) < 1e-6, '并行模式财富应守恒');
  } finally {
    engine.close();
  }
});

test('瘟疫死亡：事件标记的死亡由引擎清算，财富守恒', () => {
  const cfg = testConfig({
    initialPopulation: 1500,
    maxPopulation: 4000,
    plague: {
      enabled: true,
      startRound: 1,
      everyRounds: 30,
      probability: 1,
      infectRate: 0.1,
      damagePct: 0.05,
      antibodyChance: 0.05,
      heritable: true,
      lowWealthExtraDeath: 0.5,
    },
    macro: {
      average: { enabled: false },
      redistribute: { enabled: false },
      disaster: { enabled: false },
      dividend: { enabled: false },
      subsidy: { enabled: false },
    },
    endCondition: { mode: 'C', rounds: 200, maxRounds: 5000 },
  });
  const engine = new Engine(cfg);
  try {
    for (let r = 0; r < 40; r++) engine.tick();
    assert.ok(engine.deaths > 0, '瘟疫应造成死亡');
    assert.ok(engine.plagueDeaths > 0, '应统计到瘟疫死亡');
    const expected = cfg.initialPopulation * cfg.initialWealth + engine.created - engine.destroyed;
    assert.ok(
      Math.abs(expected - engine.totalWealth) / Math.max(1, Math.abs(expected)) < 1e-6,
      `瘟疫死亡清算后财富不守恒: 期望 ${expected.toFixed(2)} 实际 ${engine.totalWealth.toFixed(2)}`,
    );
  } finally {
    engine.close();
  }
});

test('公会模式：入会/缴金/兜底/团体战与财富守恒', () => {
  const cfg = testConfig({
    initialPopulation: 3000,
    maxPopulation: 8000,
    guilds: {
      enabled: true,
      count: 8,
      joinChance: 1,
      recruitChance: 0.01,
      contributeRate: 0.01,
      coverRatio: 0.8,
      expelBelowRatio: 0.9,
      levelUpAssets: 2000,
      maxLevel: 10,
      costDiscountPerLevel: 0.01,
      warChance: 0.5,
      warChampionCount: 2,
      warStake: 10,
    },
    macro: {
      average: { enabled: false },
      redistribute: { enabled: false },
      disaster: { enabled: false },
      dividend: { enabled: false },
      subsidy: { enabled: false },
    },
    endCondition: { mode: 'C', rounds: 150, maxRounds: 5000 },
  });
  const engine = new Engine(cfg);
  try {
    assert.equal(engine.cfg.guilds.enabled, true);
    for (let r = 0; r < 80; r++) engine.tick();
    const store = engine.store;
    let members = 0;
    for (let i = 0; i < store.aliveCount; i++) {
      if (store.guild[store.aliveList[i]] >= 0) members++;
    }
    assert.ok(members > 0, '应有存活个体属于公会');
    assert.ok(engine.guildTreasury >= 0 && Number.isFinite(engine.guildTreasury), '金库总额应为有限非负数');
    assert.ok(engine.guildSys.wars > 0, 'warChance=0.5 时 80 回合内应发生团体战');
    // 财富守恒：存活总资产 = 初始 + created - destroyed - 公会金库（金库是系统外持仓）
    const expected = cfg.initialPopulation * cfg.initialWealth + engine.created - engine.destroyed - engine.guildTreasury;
    assert.ok(
      Math.abs(expected - engine.totalWealth) / Math.max(1, Math.abs(expected)) < 1e-6,
      `公会模式财富不守恒: 期望 ${expected.toFixed(2)} 实际 ${engine.totalWealth.toFixed(2)} 金库 ${engine.guildTreasury.toFixed(2)}`,
    );
    const { json } = engine.snapshot(1);
    assert.equal(json.guilds.enabled, true);
    assert.ok(Array.isArray(json.guilds.topWealth) && json.guilds.topWealth.length > 0, '快照应包含公会榜');
    assert.equal(json.guilds.wars, engine.guildSys.wars);
    assert.ok(json.guilds.topWealth[0].level >= 0 && typeof json.guilds.topWealth[0].name === 'string');
  } finally {
    engine.close();
  }
});

test('二进制快照协议自洽（magic/长度/sections/JSON 字段）', () => {
  const engine = new Engine(testConfig());
  for (let i = 0; i < 8; i++) engine.tick();
  const { buffer, json } = engine.snapshot(7);
  const view = new DataView(buffer);
  assert.equal(view.getUint32(0, true), MAGIC, 'magic 错误');
  assert.equal(view.getUint32(4, true), buffer.byteLength, 'frameLength 与 buffer 长度不一致');
  const jsonLen = view.getUint32(8, true);
  const dataStart = view.getUint32(12, true);
  assert.ok(jsonLen > 100 && dataStart >= 16 + jsonLen);
  assert.equal(jsonLen, new TextEncoder().encode(JSON.stringify(json)).length);

  // JSON 必填字段
  for (const key of ['seq', 'round', 'engine', 'population', 'wealth', 'strategy', 'classes', 'talents', 'series', 'families', 'events', 'inflation', 'resource', 'plague', 'tracked', 'endCondition', 'perf', 'sections', 'grids', 'guilds', 'classFlow']) {
    assert.ok(key in json, `快照 JSON 缺少字段: ${key}`);
  }
  assert.equal(json.seq, 7);
  assert.equal(json.round, engine.round);
  assert.equal(json.population.alive, engine.store.aliveCount);

  // sections 解析
  const names = json.sections.map((s) => s.name);
  for (const required of ['pts', 'ids', 'hist', 'strategyGrid', 'strategyGridWealth']) {
    assert.ok(names.includes(required), `缺少 section: ${required}`);
  }
  const byName = {};
  for (const sec of json.sections) {
    const byteOffset = dataStart + sec.offset;
    assert.ok(byteOffset + sec.length * (sec.type === 'i32' ? 4 : 4) <= buffer.byteLength, `section ${sec.name} 越界`);
    byName[sec.name] =
      sec.type === 'i32' ? new Int32Array(buffer, byteOffset, sec.length) : new Float32Array(buffer, byteOffset, sec.length);
  }
  assert.equal(byName.ids.length, json.perf.sampleCount);
  assert.equal(byName.pts.length, json.perf.sampleCount * 7);
  assert.equal(byName.hist.length, 128);
  const gw = json.grids.strategy.w;
  const gh = json.grids.strategy.h;
  assert.equal(byName.strategyGrid.length, gw * gh);
  assert.equal(byName.strategyGridWealth.length, gw * gh);
  // 采样点数值合理
  for (let i = 0; i < Math.min(50, json.perf.sampleCount); i++) {
    const x = byName.pts[i * 7];
    const y = byName.pts[i * 7 + 1];
    assert.ok(x >= 0 && x <= 1 && Number.isFinite(x), 'pts laneX 越界');
    assert.ok(y >= 0 && y <= 1 && Number.isFinite(y), 'pts wealthY 越界');
  }
  // 洛伦兹曲线首末点
  assert.equal(json.wealth.lorenz[0], 0);
  assert.equal(json.wealth.lorenz[1], 0);
  assert.ok(json.wealth.gini >= 0 && json.wealth.gini <= 1);
  assert.ok(json.wealth.lorenz[json.wealth.lorenz.length - 2] <= 1.0001);
});
