/**
 * test/analytics.test.js — 统计分析与可视化数据生产模块（src/core/analytics.js）单元测试
 *
 * 覆盖：
 *  1. sections 名称/顺序/类型/长度严格对齐 docs/PROTOCOL.md §4
 *  2. 采样点 pts/ids 逐点字段映射（laneX / wealthY / classId / talentId / streakNorm / stratX / stratY）
 *  3. Snapshot JSON 字段自洽与取值域（gini、洛伦兹首末点与单调性、阶层/天赋占比、序列长度一致等）
 *  4. 时间序列环形缓冲（≤600 点、升序、最新点与全量扫描结果一致、回绕）
 *  5. 确定性（同配置同状态输出一致）与 store 只读性（校验和不变）
 *  6. reset / setConfig 行为、空人口快照容错
 *  7. onRound 廉价性、snapshot 性能（宽松阈值，实测数字直接打印）
 *
 * 运行：node test/analytics.test.js   （或 node --test test/analytics.test.js）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, CLASS_NAMES } from '../src/core/config.js';
import { Rng, hashLane } from '../src/core/rng.js';
import { AgentStore, GENE_COUNT, TALENT_COUNT } from '../src/core/store.js';
import { createAnalytics } from '../src/core/analytics.js';

// ─────────────────────────── 测试工具 ───────────────────────────

const TRI_Y = 0.8660254037844386;
const LN3 = Math.log(3);

/**
 * 构造一个已填好随机资产/基因/天赋的 AgentStore（id 从 1 连续递增，全部存活）。
 * @param {number} n 个体数
 * @param {object} cfg 配置
 * @param {number} [seed] 随机种子（同 seed ⇒ 同数据）
 * @returns {AgentStore}
 */
function buildStore(n, cfg, seed = 12345) {
  const store = new AgentStore(Math.ceil(n * 1.2) + 8, cfg);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) {
    const s = store.alloc(0);
    // 资产：约 8% 负资产，其余对数正态分布（覆盖 log 轴负半轴与巨大值）
    let asset;
    if (rng.chance(0.08)) asset = -rng.float() * cfg.maxDebt * 1.2;
    else asset = Math.exp(rng.gauss() * 1.1 + Math.log(cfg.initialWealth));
    store.assets[s] = asset;
    // 策略基因：三个概率归一化，风险/保守/激进阈值随机
    let pr = 0.01 + rng.float();
    let psc = 0.01 + rng.float();
    let pp = 0.01 + rng.float();
    const sum = pr + psc + pp;
    pr /= sum;
    psc /= sum;
    pp /= sum;
    const g = s * GENE_COUNT;
    store.gene[g] = pr;
    store.gene[g + 1] = psc;
    store.gene[g + 2] = pp;
    store.gene[g + 3] = 0.2 + rng.float() * 2.8;
    store.gene[g + 4] = rng.float() * cfg.initialWealth * 5;
    store.gene[g + 5] = cfg.initialWealth + rng.float() * cfg.initialWealth * 49;
    store.talent[s] = rng.int(TALENT_COUNT);
    store.winStreak[s] = rng.int(20);
    store.lossStreak[s] = rng.int(20);
    store.age[s] = rng.int(500);
    store.debtLimit[s] = cfg.maxDebt * (0.8 + rng.float() * 0.4);
    store.costAffinity[s] = 1;
  }
  store.rebuildAliveList();
  return store;
}

/** 统计 store 全部存活个体的资产总和 */
function sumAssets(store) {
  let sum = 0;
  for (let j = 0; j < store.aliveCount; j++) sum += store.assets[store.aliveList[j]];
  return sum;
}

/**
 * 构造引擎每回合传入的 summary（字段见 CONTRACTS §6；对象可复用）。
 * moveUsage 依回合变化，便于校验 strategy.usage。
 */
function makeSummary(store, round, extra) {
  const mu = new Int32Array(3);
  mu[0] = 10 + ((round * 7) % 31);
  mu[1] = 5 + ((round * 11) % 17);
  mu[2] = 3 + ((round * 13) % 23);
  return {
    round,
    aliveCount: store.aliveCount,
    births: round * 3,
    deaths: round % 97,
    bankruptcies: round % 53,
    frozenCount: 0,
    totalWealth: sumAssets(store),
    maxAsset: 0,
    aboveThreshold: 0,
    cost: 10,
    inflationFactor: 1,
    moveUsage: mu,
    outcomes: { wins: 0, losses: 0, draws: 0 },
    avgBet: 10,
    avgWinStreak: 0,
    avgLossStreak: 0,
    pool: { amount: 0, created: 0, destroyed: 0 },
    plague: { enabled: false, active: false, infected: 0, antibodies: 0 },
    events: [],
    endCondition: { mode: 'C', label: '', progress: 0, ended: false },
    perf: { tickMs: 0, roundsPerSec: 0, analyticsMs: 0 },
    ...extra,
  };
}

/** 精确资产轴映射（与 PROTOCOL §5 公式一致） */
function fExact(a) {
  const v = Math.log10(1 + Math.abs(a));
  return a < 0 ? -v : v;
}

/** 按配置阈值计算阶层 */
function classOf(asset, thresholds) {
  if (asset < thresholds[0]) return 0;
  if (asset < thresholds[1]) return 1;
  if (asset < thresholds[2]) return 2;
  return 3;
}

/** 深度遍历 JSON，断言不存在 NaN / Infinity */
function assertAllFinite(value, path = '$') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} 不是有限数字: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertAllFinite(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) assertAllFinite(value[key], `${path}.${key}`);
  }
}

/** store 校验和（用于验证 analytics 只读） */
function storeChecksum(store) {
  let assetSum = 0;
  let idSum = 0;
  let aliveSum = 0;
  let geneSum = 0;
  const n = store.aliveCount;
  for (let j = 0; j < n; j++) {
    const s = store.aliveList[j];
    assetSum += store.assets[s];
    idSum += store.id[s];
    aliveSum += s;
  }
  const geneLen = store.count * GENE_COUNT;
  for (let i = 0; i < geneLen; i++) geneSum += store.gene[i];
  return {
    capacity: store.capacity,
    count: store.count,
    aliveCount: store.aliveCount,
    freeCount: store.freeCount,
    assetSum,
    idSum,
    aliveSum,
    geneSum,
    nextId: store.nextId,
  };
}

/** 按名称取 section */
function sectionMap(sections) {
  const map = new Map();
  for (const s of sections) map.set(s.name, s);
  return map;
}

// ─────────────────────────── 1. sections 契约 ───────────────────────────

test('sections 名称/顺序/类型/长度严格对齐 PROTOCOL §4', () => {
  const cfg = createConfig({
    initialPopulation: 10000,
    performance: { sampleSize: 4096, gridStrategy: { w: 64, h: 48 }, historyRounds: 400 },
  });
  const store = buildStore(10000, cfg);
  const an = createAnalytics(cfg);
  const summary = makeSummary(store, 1);
  an.onRound(store, summary);
  const { json, sections } = an.snapshot(store, summary);

  assert.deepEqual(
    sections.map((s) => s.name),
    ['pts', 'ids', 'hist', 'strategyGrid', 'strategyGridWealth'],
    'section 顺序必须固定（前端按顺序解析）',
  );
  assert.deepEqual(sections.map((s) => s.type), ['f32', 'i32', 'f32', 'f32', 'f32']);
  for (const s of sections) {
    assert.deepEqual(Object.keys(s).sort(), ['data', 'name', 'type'], 'section 只应含 name/type/data');
    assert.ok(ArrayBuffer.isView(s.data), `${s.name}.data 必须是 TypedArray`);
  }

  const k = 4096; // sampleCount = min(sampleSize, aliveCount)
  const cells = 64 * 48;
  assert.equal(sectionMap(sections).get('pts').data.length, k * 7, 'pts 长度 = 7 × sampleCount');
  assert.equal(sectionMap(sections).get('ids').data.length, k, 'ids 长度 = sampleCount');
  assert.equal(sectionMap(sections).get('hist').data.length, 128, 'hist 固定 128 箱');
  assert.equal(sectionMap(sections).get('strategyGrid').data.length, cells, 'grid 长度 = w×h');
  assert.equal(sectionMap(sections).get('strategyGridWealth').data.length, cells);
  assert.ok(sectionMap(sections).get('pts').data instanceof Float32Array);
  assert.ok(sectionMap(sections).get('ids').data instanceof Int32Array);

  // json 中补充的网格元数据（前端据此解码 sections）
  assert.deepEqual(json.grids.strategy, { w: 64, h: 48 });
  assert.equal(json.grids.sampleCount, k);
  assert.equal(json.perf.sampleCount, k);
  assert.equal(json.wealth.histogram.bins, 128);

  // aliveCount < sampleSize 时 sampleCount = aliveCount
  const smallStore = buildStore(500, cfg, 999);
  const smallAn = createAnalytics(cfg);
  smallAn.onRound(smallStore, makeSummary(smallStore, 1));
  const small = smallAn.snapshot(smallStore, makeSummary(smallStore, 1));
  assert.equal(sectionMap(small.sections).get('pts').data.length, 500 * 7);
  assert.equal(sectionMap(small.sections).get('ids').data.length, 500);
  assert.equal(small.json.perf.sampleCount, 500);
});

// ─────────────────────────── 2. 采样点映射 ───────────────────────────

test('pts/ids 每个采样点字段映射正确', () => {
  const cfg = createConfig({
    initialPopulation: 3000,
    performance: { sampleSize: 2048, gridStrategy: { w: 32, h: 24 }, historyRounds: 200 },
  });
  const store = buildStore(3000, cfg);
  const an = createAnalytics(cfg);
  const summary = makeSummary(store, 7);
  an.onRound(store, summary);
  const { json, sections } = an.snapshot(store, summary);
  const sec = sectionMap(sections);
  const pts = sec.get('pts').data;
  const ids = sec.get('ids').data;
  const k = ids.length;

  // 期望的财富轴参考范围（PROTOCOL §5）
  const fLo = fExact(-cfg.maxDebt * 1.5);
  const fHi = fExact(cfg.initialWealth * 1000);
  const thresholds = cfg._derived.classThresholds;

  // id → slot 映射（本测试中 id 从 1 连续分配、无死亡）
  const slotOfId = new Map();
  for (let s = 0; s < store.count; s++) {
    if (store.alive[s]) slotOfId.set(store.id[s], s);
  }

  const seenIds = new Set();
  for (let i = 0; i < k; i++) {
    const id = ids[i];
    assert.ok(id > 0, `ids[${i}] 非法`);
    assert.ok(!seenIds.has(id), `ids[${i}] 重复: ${id}`);
    seenIds.add(id);
    const slot = slotOfId.get(id);
    assert.ok(slot !== undefined, `ids[${i}]=${id} 不是存活个体`);

    const o = i * 7;
    const laneX = pts[o];
    const wealthY = pts[o + 1];
    const classId = pts[o + 2];
    const talentId = pts[o + 3];
    const streakNorm = pts[o + 4];
    const stratX = pts[o + 5];
    const stratY = pts[o + 6];

    const asset = store.assets[slot];
    const g = slot * GENE_COUNT;
    const pr = store.gene[g];
    const psc = store.gene[g + 1];
    const pp = store.gene[g + 2];

    // laneX = hashLane(id, 1024)（float32 精度内相等）
    assert.ok(Math.abs(laneX - hashLane(id, 1024)) < 1e-6, `laneX 映射错误 (id=${id})`);
    // wealthY = clamp((f(asset)-fLo)/(fHi-fLo), 0, 1)（允许位运算近似误差）
    let wy = (fExact(asset) - fLo) / (fHi - fLo);
    wy = wy < 0 ? 0 : wy > 1 ? 1 : wy;
    assert.ok(Math.abs(wealthY - wy) < 1e-3, `wealthY 映射错误 (id=${id}, asset=${asset}): ${wealthY} vs ${wy}`);
    assert.ok(wealthY >= 0 && wealthY <= 1);
    // classId / talentId
    assert.equal(classId, classOf(asset, thresholds), `classId 错误 (id=${id})`);
    assert.equal(talentId, store.talent[slot], `talentId 错误 (id=${id})`);
    // streakNorm = clamp(win/8 - loss/8, -1, 1)
    let sn = (store.winStreak[slot] - store.lossStreak[slot]) / 8;
    sn = sn < -1 ? -1 : sn > 1 ? 1 : sn;
    assert.ok(Math.abs(streakNorm - sn) < 1e-6, `streakNorm 错误 (id=${id})`);
    // 策略坐标
    assert.ok(Math.abs(stratX - (pp + 0.5 * psc)) < 1e-6, `stratX 错误 (id=${id})`);
    assert.ok(Math.abs(stratY - psc * TRI_Y) < 1e-6, `stratY 错误 (id=${id})`);
    assert.ok(stratX >= 0 && stratX <= 1.0001);
    assert.ok(stratY >= 0 && stratY <= TRI_Y + 1e-4);
    assert.ok(classId >= 0 && classId <= 3);
    assert.ok(talentId >= 0 && talentId < TALENT_COUNT);
  }
  assert.equal(k, 2048);
  assert.equal(json.perf.sampleCount, 2048);
});

// ─────────────────────────── 3. JSON 自洽与取值域 ───────────────────────────

test('Snapshot JSON 字段自洽、取值范围正确且不含 NaN/Infinity', () => {
  const cfg = createConfig({
    initialPopulation: 5000,
    performance: { sampleSize: 1024, gridStrategy: { w: 24, h: 20 }, historyRounds: 300 },
  });
  const store = buildStore(5000, cfg);
  const an = createAnalytics(cfg);
  const summary = makeSummary(store, 3);
  an.onRound(store, summary);
  const { json, sections } = an.snapshot(store, summary);
  const n = store.aliveCount;
  const exactTotal = sumAssets(store);

  // population
  assert.equal(json.population.alive, n);
  assert.equal(json.population.initial, cfg.initialPopulation);
  assert.equal(json.population.capacity, store.capacity);
  assert.equal(json.population.births, summary.births);
  assert.equal(json.population.deaths, summary.deaths);
  assert.equal(json.population.bankruptcies, summary.bankruptcies);
  assert.ok(json.population.birthRate >= 0);
  assert.ok(json.population.deathRate >= 0);
  assert.ok(json.population.bankruptRate >= 0);

  // wealth
  assert.ok(Math.abs(json.wealth.total - exactTotal) < 1, '总资产应等于存活个体资产和（±舍入）');
  assert.ok(Math.abs(json.wealth.mean - exactTotal / n) < 0.02, '人均资产错误');
  assert.ok(json.wealth.gini >= 0 && json.wealth.gini <= 1, 'gini ∈ [0,1]');
  assert.ok(json.wealth.min <= json.wealth.median + 1e-9, 'min ≤ median');
  assert.ok(json.wealth.median <= json.wealth.p90 + 1e-9, 'median ≤ p90');
  assert.ok(json.wealth.p90 <= json.wealth.max + 1e-9, 'p90 ≤ max');
  assert.ok(json.wealth.negativeShare >= 0 && json.wealth.negativeShare <= 1);
  let negative = 0;
  for (let j = 0; j < n; j++) if (store.assets[store.aliveList[j]] < 0) negative++;
  assert.ok(Math.abs(json.wealth.negativeShare - negative / n) < 1e-4);

  // 洛伦兹曲线：102 个数（51 个点）、首点 [0,0]、末点 [1,1]、x 递增、y 单调不减且 ∈[0,1]
  const lorenz = json.wealth.lorenz;
  assert.equal(lorenz.length, 51 * 2, '洛伦兹曲线应为 51 个 x/y 交替点');
  assert.deepEqual([lorenz[0], lorenz[1]], [0, 0], '首点必须为 [0,0]');
  assert.deepEqual([lorenz[lorenz.length - 2], lorenz[lorenz.length - 1]], [1, 1], '末点必须为 [1,1]');
  for (let i = 0; i < 51; i++) {
    const x = lorenz[i * 2];
    const y = lorenz[i * 2 + 1];
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `洛伦兹点越界 i=${i}`);
    if (i > 0) {
      assert.ok(x > lorenz[(i - 1) * 2], '洛伦兹 x 必须严格递增');
      assert.ok(y >= lorenz[(i - 1) * 2 + 1] - 1e-9, '洛伦兹 y 必须单调不减');
    }
  }

  // classes：4 个阶层，count 求和 = 存活数，share/wealthShare 各自和为 1
  assert.equal(json.classes.length, 4);
  let classCountSum = 0;
  let classShareSum = 0;
  let classWealthSum = 0;
  for (let c = 0; c < 4; c++) {
    const cl = json.classes[c];
    assert.equal(cl.id, c);
    assert.equal(cl.name, CLASS_NAMES[c]);
    assert.ok(Number.isInteger(cl.count) && cl.count >= 0);
    assert.ok(cl.share >= 0 && cl.share <= 1);
    assert.ok(cl.wealthShare >= 0 && cl.wealthShare <= 1);
    classCountSum += cl.count;
    classShareSum += cl.share;
    classWealthSum += cl.wealthShare;
  }
  assert.equal(classCountSum, n, '阶层人数和必须等于存活数');
  assert.ok(Math.abs(classShareSum - 1) < 1e-6, `阶层人数占比和≈1（实际 ${classShareSum}）`);
  assert.ok(Math.abs(classWealthSum - 1) < 1e-6, `阶层资产占比和≈1（实际 ${classWealthSum}）`);
  for (let c = 0; c < 4; c++) assert.equal(json.classes[c].wealthShare, json.wealth.classWealthShare[c]);

  // talents：6 个天赋，计数和 = 存活数
  assert.equal(json.talents.length, TALENT_COUNT);
  let talentSum = 0;
  for (const c of json.talents) {
    assert.ok(Number.isInteger(c) && c >= 0);
    talentSum += c;
  }
  assert.equal(talentSum, n, '天赋计数和必须等于存活数');

  // strategy
  const prefSum = json.strategy.preference[0] + json.strategy.preference[1] + json.strategy.preference[2];
  assert.ok(Math.abs(prefSum - 1) < 2e-3, `平均策略概率和≈1（实际 ${prefSum}）`);
  for (const v of json.strategy.preference) assert.ok(v >= 0 && v <= 1);
  const domSum = json.strategy.dominant[0] + json.strategy.dominant[1] + json.strategy.dominant[2];
  assert.ok(Math.abs(domSum - 1) < 2e-3, `主导拳种占比和≈1（实际 ${domSum}）`);
  for (const v of json.strategy.dominant) assert.ok(v >= 0 && v <= 1);
  assert.ok(json.strategy.entropy >= 0 && json.strategy.entropy <= LN3 + 1e-6, `熵越界: ${json.strategy.entropy}`);
  const usageSum = json.strategy.usage[0] + json.strategy.usage[1] + json.strategy.usage[2];
  assert.ok(Math.abs(usageSum - 1) < 2e-3, `本回合出拳占比和≈1（实际 ${usageSum}）`);
  for (const v of json.strategy.usage) assert.ok(v >= 0 && v <= 1);

  // 网格：计数和 = 存活数；wealthY 累加和 ≈ 逐个体 wealthY 之和
  const grid = sectionMap(sections).get('strategyGrid').data;
  const gridWealth = sectionMap(sections).get('strategyGridWealth').data;
  let gridSum = 0;
  for (let i = 0; i < grid.length; i++) gridSum += grid[i];
  assert.equal(gridSum, n, '策略网格计数和必须等于存活数');
  const fLo = fExact(-cfg.maxDebt * 1.5);
  const fHi = fExact(cfg.initialWealth * 1000);
  let expectedWealthY = 0;
  for (let j = 0; j < n; j++) {
    const a = store.assets[store.aliveList[j]];
    let wy = (fExact(a) - fLo) / (fHi - fLo);
    expectedWealthY += wy < 0 ? 0 : wy > 1 ? 1 : wy;
  }
  let gridWealthSum = 0;
  for (let i = 0; i < gridWealth.length; i++) gridWealthSum += gridWealth[i];
  assert.ok(
    Math.abs(gridWealthSum - expectedWealthY) < n * 1e-3,
    `网格 wealthY 累加和偏差过大: ${gridWealthSum} vs ${expectedWealthY}`,
  );

  // hist 计数和 = 存活数
  const hist = sectionMap(sections).get('hist').data;
  let histSum = 0;
  for (let i = 0; i < hist.length; i++) histSum += hist[i];
  assert.equal(histSum, n, '直方图计数和必须等于存活数');

  // 全 JSON 无 NaN / Infinity
  assertAllFinite(json);
  assert.doesNotThrow(() => JSON.stringify(json), 'JSON 必须可序列化');
});

// ─────────────────────────── 4. 时间序列 ───────────────────────────

test('series 环形缓冲：长度一致、升序、≤600 点、最新点与扫描结果一致', () => {
  const cfg = createConfig({
    initialPopulation: 1000,
    performance: { sampleSize: 512, gridStrategy: { w: 16, h: 16 }, historyRounds: 1000 },
  });
  const store = buildStore(1000, cfg, 777);
  const an = createAnalytics(cfg);
  let last = null;
  for (let round = 1; round <= 700; round++) {
    // 轻微改变资产分布，让序列有变化
    store.assets[(round * 37) % 1000] += 25;
    const summary = makeSummary(store, round);
    an.onRound(store, summary);
    if (round % 10 === 0) last = an.snapshot(store, summary);
  }
  const ser = last.json.series;
  const fieldNames = [
    'round', 'alive', 'births', 'deaths', 'bankruptcies', 'totalWealth', 'meanWealth',
    'gini', 'rock', 'scissors', 'paper', 'class0', 'class1', 'class2', 'class3',
  ];
  assert.deepEqual(Object.keys(ser), fieldNames, 'series 字段必须齐全且顺序稳定');
  const len = ser.round.length;
  assert.ok(len > 0 && len <= 600, `series 点数必须 ≤600（实际 ${len}）`);
  assert.equal(len, 600, '700 回合历史（<1000 容量）采样后应为 600 点');
  for (const name of fieldNames) assert.equal(ser[name].length, len, `series.${name} 长度不一致`);
  for (let i = 1; i < len; i++) assert.ok(ser.round[i] > ser.round[i - 1], 'series.round 必须严格升序');

  // 最新点 = 本次全量扫描的权威值
  assert.equal(ser.round[len - 1], 700);
  assert.equal(ser.alive[len - 1], last.json.population.alive);
  assert.equal(ser.totalWealth[len - 1], last.json.wealth.total);
  assert.equal(ser.gini[len - 1], last.json.wealth.gini);
  assert.equal(ser.rock[len - 1], last.json.strategy.dominant[0]);
  assert.equal(ser.scissors[len - 1], last.json.strategy.dominant[1]);
  assert.equal(ser.paper[len - 1], last.json.strategy.dominant[2]);
  for (let c = 0; c < 4; c++) assert.equal(ser[`class${c}`][len - 1], last.json.classes[c].count);

  // 环形回绕：继续跑到 1200 回合（> historyRounds），序列仍 ≤600、升序、最新点正确
  let last2 = null;
  for (let round = 701; round <= 1200; round++) {
    const summary = makeSummary(store, round);
    an.onRound(store, summary);
    if (round % 20 === 0) last2 = an.snapshot(store, summary);
  }
  const ser2 = last2.json.series;
  assert.equal(ser2.round.length, 600);
  assert.equal(ser2.round[ser2.round.length - 1], 1200);
  for (let i = 1; i < ser2.round.length; i++) assert.ok(ser2.round[i] > ser2.round[i - 1]);
});

// ─────────────────────────── 5. 确定性与 store 只读 ───────────────────────────

test('确定性：同配置同状态输出一致；快照不改写 store', () => {
  const cfg = createConfig({
    initialPopulation: 2000,
    performance: { sampleSize: 256, gridStrategy: { w: 20, h: 16 }, historyRounds: 300 },
  });
  const storeA = buildStore(2000, cfg, 424242);
  const storeB = buildStore(2000, cfg, 424242);
  const anA = createAnalytics(cfg);
  const anB = createAnalytics(cfg);
  const before = storeChecksum(storeA);

  let snapA = null;
  let snapB = null;
  for (let round = 1; round <= 30; round++) {
    const sumA = makeSummary(storeA, round);
    const sumB = makeSummary(storeB, round);
    anA.onRound(storeA, sumA);
    anB.onRound(storeB, sumB);
    if (round % 5 === 0) {
      snapA = anA.snapshot(storeA, sumA);
      snapB = anB.snapshot(storeB, sumB);
    }
  }

  // JSON 除耗时字段外必须完全一致
  const jsonA = structuredClone(snapA.json);
  const jsonB = structuredClone(snapB.json);
  delete jsonA.perf;
  delete jsonB.perf;
  assert.deepEqual(jsonA, jsonB, '同配置同状态的快照 JSON 必须一致');

  // 二进制 sections 必须逐元素一致（采样使用内部固定种子 RNG）
  assert.equal(snapA.sections.length, snapB.sections.length);
  for (let i = 0; i < snapA.sections.length; i++) {
    assert.equal(snapA.sections[i].name, snapB.sections[i].name);
    assert.deepEqual(
      Array.from(snapA.sections[i].data),
      Array.from(snapB.sections[i].data),
      `section ${snapA.sections[i].name} 不一致`,
    );
  }

  // 同一实例重复调用 snapshot：给定相同状态也应得到相同输出（RNG 每帧重置）
  const repeat1 = anA.snapshot(storeA, makeSummary(storeA, 30));
  const repeat2 = anA.snapshot(storeA, makeSummary(storeA, 30));
  const r1 = structuredClone(repeat1.json);
  const r2 = structuredClone(repeat2.json);
  delete r1.perf;
  delete r2.perf;
  assert.deepEqual(r1, r2, '相同状态重复快照输出必须可复现');

  // store 只读：校验和前后一致
  assert.deepEqual(storeChecksum(storeA), before, 'analytics 不得修改 store');
  assert.deepEqual(storeChecksum(storeB), storeChecksum(storeA));
});

// ─────────────────────────── 6. reset / setConfig / 空人口 ───────────────────────────

test('reset 清空序列；setConfig 热更新采样/网格尺寸', () => {
  const cfg = createConfig({
    initialPopulation: 800,
    performance: { sampleSize: 256, gridStrategy: { w: 16, h: 16 }, historyRounds: 500 },
  });
  const store = buildStore(800, cfg, 31);
  const an = createAnalytics(cfg);
  for (let round = 1; round <= 5; round++) {
    an.onRound(store, makeSummary(store, round));
    an.snapshot(store, makeSummary(store, round));
  }
  assert.equal(an.snapshot(store, makeSummary(store, 5)).json.series.round.length, 5);

  an.reset();
  const afterReset = an.snapshot(store, makeSummary(store, 0));
  assert.equal(afterReset.json.series.round.length, 0, 'reset 后时间序列应为空');
  assert.equal(afterReset.sections.find((s) => s.name === 'pts').data.length, 256 * 7);

  // setConfig：采样上限与网格尺寸热更新（historyRounds 不变 ⇒ 时间序列保留）
  const cfg2 = createConfig({
    initialPopulation: 800,
    performance: { sampleSize: 100, gridStrategy: { w: 32, h: 16 }, historyRounds: 500 },
  });
  an.onRound(store, makeSummary(store, 6));
  an.setConfig(cfg2);
  const snap2 = an.snapshot(store, makeSummary(store, 6));
  assert.equal(snap2.json.series.round.length, 1, 'historyRounds 未变 ⇒ 序列保留');
  assert.equal(snap2.sections.find((s) => s.name === 'pts').data.length, 100 * 7);
  assert.equal(snap2.sections.find((s) => s.name === 'strategyGrid').data.length, 32 * 16);
  assert.deepEqual(snap2.json.grids.strategy, { w: 32, h: 16 });

  // historyRounds 变化 ⇒ 序列重置
  const cfg3 = createConfig({
    initialPopulation: 800,
    performance: { sampleSize: 100, gridStrategy: { w: 32, h: 16 }, historyRounds: 120 },
  });
  an.setConfig(cfg3);
  const snap3 = an.snapshot(store, makeSummary(store, 6));
  assert.equal(snap3.json.series.round.length, 0, 'historyRounds 变化应清空序列');
});

test('空人口快照不抛异常且全部字段有效', () => {
  const cfg = createConfig({
    initialPopulation: 100,
    performance: { sampleSize: 64, gridStrategy: { w: 16, h: 16 }, historyRounds: 60 },
  });
  const store = new AgentStore(64, cfg);
  store.rebuildAliveList();
  assert.equal(store.aliveCount, 0);
  const an = createAnalytics(cfg);
  const summary = makeSummary(store, 0);
  an.onRound(store, summary);
  const { json, sections } = an.snapshot(store, summary);

  assert.equal(json.population.alive, 0);
  assert.equal(json.wealth.total, 0);
  assert.equal(json.wealth.mean, 0);
  assert.equal(json.wealth.gini, 0);
  assert.equal(json.wealth.lorenz[0], 0);
  assert.equal(json.wealth.lorenz[json.wealth.lorenz.length - 1], 1);
  for (let c = 0; c < 4; c++) assert.equal(json.classes[c].count, 0);
  for (const v of json.talents) assert.equal(v, 0);
  assert.deepEqual(json.strategy.preference, [0, 0, 0]);
  assert.deepEqual(json.strategy.dominant, [0, 0, 0]);
  assert.equal(json.series.round.length, 1);
  assert.equal(sectionMap(sections).get('pts').data.length, 0);
  assert.equal(sectionMap(sections).get('ids').data.length, 0);
  assert.equal(sectionMap(sections).get('hist').data.length, 128);
  for (const s of sections) {
    for (let i = 0; i < s.data.length; i++) assert.ok(Number.isFinite(s.data[i]));
  }
  assertAllFinite(json);

  // summary 缺省容错
  const an2 = createAnalytics(cfg);
  assert.doesNotThrow(() => {
    an2.onRound(store, undefined);
    an2.snapshot(store, undefined);
  });
});

// ─────────────────────────── 7. onRound 廉价 & snapshot 性能 ───────────────────────────

test('onRound 廉价（20 万存活）且快照性能在宽松阈值内', () => {
  const cfg = createConfig({ initialPopulation: 200000 });
  const store = buildStore(200000, cfg, 2024);
  const an = createAnalytics(cfg);
  const summary = makeSummary(store, 1);

  // onRound：2000 次调用平均耗时（目标 < 0.2ms）
  an.onRound(store, summary);
  const tRound = performance.now();
  for (let i = 0; i < 2000; i++) an.onRound(store, summary);
  const onRoundAvgMs = (performance.now() - tRound) / 2000;

  // snapshot：预热 3 次后测 5 次平均（本测试机用宽松阈值防抖动）
  an.snapshot(store, summary);
  an.snapshot(store, summary);
  an.snapshot(store, summary);
  const tSnap = performance.now();
  const reps = 5;
  let snap = null;
  for (let i = 0; i < reps; i++) snap = an.snapshot(store, summary);
  const snapshotAvgMs = (performance.now() - tSnap) / reps;

  console.log(
    `[perf] 20 万存活：snapshot 平均 ${snapshotAvgMs.toFixed(2)}ms，onRound 平均 ${onRoundAvgMs.toFixed(4)}ms，` +
    `sections=${snap.sections.map((s) => `${s.name}:${s.data.length}`).join(',')}`,
  );

  assert.ok(onRoundAvgMs < 2, `onRound 平均耗时过长: ${onRoundAvgMs}ms`);
  assert.ok(snapshotAvgMs < 150, `snapshot 平均耗时超过宽松阈值: ${snapshotAvgMs}ms`);
  assert.equal(snap.json.population.alive, 200000);
  assert.equal(snap.sections.find((s) => s.name === 'pts').data.length, cfg.performance.sampleSize * 7);
});

// ─────────────────────────── 9. 阶层流动率 ───────────────────────────

test('阶层流动：up/down/stay、flowIn/flowOut、新个体/槽位复用、reset、容量增长', () => {
  const cfg = createConfig({
    initialPopulation: 1000,
    performance: { sampleSize: 64, gridStrategy: { w: 16, h: 16 }, historyRounds: 60 },
  });
  // 手工构造 4 个个体，资产分别落在 4 个阶层（默认阈值 [500, 2000, 10000]）
  const store = new AgentStore(16, cfg);
  const slots = [100, 1000, 5000, 50000].map((a) => {
    const s = store.alloc(0);
    store.assets[s] = a;
    return s;
  });
  store.rebuildAliveList();
  const an = createAnalytics(cfg);
  const mk = (round) => ({
    round,
    aliveCount: store.aliveCount,
    births: 0,
    deaths: 0,
    bankruptcies: 0,
    frozenCount: 0,
    totalWealth: 0,
    moveUsage: new Int32Array([1, 1, 1]),
  });

  /** classFlow 内部自洽 + 数值域校验 */
  function checkSelf(snap) {
    const flow = snap.json.classFlow;
    assert.equal(flow.up + flow.down + flow.stay, flow.total, 'up+down+stay 必须等于 total');
    const inSum = snap.json.classes.reduce((s, c) => s + c.flowIn, 0);
    const outSum = snap.json.classes.reduce((s, c) => s + c.flowOut, 0);
    assert.equal(inSum, flow.up + flow.down, 'Σ flowIn 必须等于迁移人数');
    assert.equal(outSum, flow.up + flow.down, 'Σ flowOut 必须等于迁移人数');
    assert.equal(
      flow.mobility,
      Math.round(((flow.up + flow.down) / Math.max(1, flow.total)) * 10000) / 10000,
      'mobility = (up+down)/max(1,total)',
    );
    assert.ok(flow.mobility >= 0 && flow.mobility <= 1, 'mobility ∈ [0,1]');
    for (const c of snap.json.classes) {
      assert.ok(Number.isInteger(c.flowIn) && c.flowIn >= 0);
      assert.ok(Number.isInteger(c.flowOut) && c.flowOut >= 0);
    }
    assertAllFinite(snap.json);
  }

  // 1) 第一帧：无历史 ⇒ 全 0
  let snap = an.snapshot(store, mk(1));
  assert.deepEqual(snap.json.classFlow, { up: 0, down: 0, stay: 0, total: 0, mobility: 0 });
  assert.deepEqual(snap.json.classes.map((c) => c.flowIn), [0, 0, 0, 0]);
  checkSelf(snap);

  // 2) 制造迁移：s0 底→上（up），s1 中→底（down），s2 上→上（stay），s3 顶→顶（stay）
  store.assets[slots[0]] = 3000;
  store.assets[slots[1]] = 100;
  store.assets[slots[2]] = 6000;
  store.assets[slots[3]] = 40000;
  store.rebuildAliveList();
  snap = an.snapshot(store, mk(2));
  assert.deepEqual(snap.json.classFlow, { up: 1, down: 1, stay: 2, total: 4, mobility: 0.5 });
  // 迁移：s0(底0→上2)、s1(中1→底0)
  assert.deepEqual(snap.json.classes.map((c) => c.flowIn), [1, 0, 1, 0], 'flowIn 错误');
  assert.deepEqual(snap.json.classes.map((c) => c.flowOut), [1, 1, 0, 0], 'flowOut 错误');
  checkSelf(snap);

  // 3) 无迁移 ⇒ 全部 stay，mobility = 0
  snap = an.snapshot(store, mk(3));
  assert.deepEqual(snap.json.classFlow, { up: 0, down: 0, stay: 4, total: 4, mobility: 0 });
  checkSelf(snap);

  // 4) 新个体（新 slot）不计入流动
  const newSlot = store.alloc(0);
  store.assets[newSlot] = 50000;
  store.rebuildAliveList();
  snap = an.snapshot(store, mk(4));
  assert.equal(snap.json.classFlow.total, 4, '新个体不应参与流动统计');
  assert.equal(snap.json.classFlow.stay, 4);
  checkSelf(snap);

  // 5) 槽位复用（同一 slot 换新稳定 ID）不计入流动
  store.freeSlot(slots[3]);
  store.rebuildAliveList();
  const reused = store.alloc(0);
  assert.equal(reused, slots[3], 'freeSlot 后 alloc 应复用同一槽位');
  store.assets[reused] = 100; // 顶→底，但属于新个体，不应计入
  store.rebuildAliveList();
  snap = an.snapshot(store, mk(5));
  // 参与统计：slots[0..2] 三个原有 + 第 4 步新增的 newSlot（上一帧已存在且 id 匹配）；
  // 槽位复用的 slots[3]（新 ID）不计入 ⇒ total = 4
  assert.equal(snap.json.classFlow.total, 4, '槽位复用个体不应参与流动统计');
  assert.deepEqual(snap.json.classFlow, { up: 0, down: 0, stay: 4, total: 4, mobility: 0 });
  checkSelf(snap);

  // 6) reset 清空历史：下一帧全部不计入，flowIn/flowOut 归零
  an.reset();
  snap = an.snapshot(store, mk(6));
  assert.deepEqual(snap.json.classFlow, { up: 0, down: 0, stay: 0, total: 0, mobility: 0 });
  assert.deepEqual(snap.json.classes.map((c) => c.flowIn), [0, 0, 0, 0]);
  checkSelf(snap);

  // 7) capacity 增长：历史缓冲重建后，既有个体仍能正确统计流动，新个体不计入
  snap = an.snapshot(store, mk(7)); // 建立一帧历史
  const matched = store.aliveCount;
  store.assets[slots[1]] = 3000; // 底→上（up）
  for (let i = 0; i < 40; i++) {
    const s = store.alloc(0);
    store.assets[s] = 6000; // 新增个体（新 ID，不计入）
  }
  store.rebuildAliveList();
  assert.ok(store.capacity > 16, 'store 容量应已增长，触发 prevClass/prevId 重建');
  snap = an.snapshot(store, mk(8));
  assert.equal(snap.json.classFlow.up, 1, '扩容当帧既有个体迁移仍应统计');
  assert.equal(snap.json.classFlow.total, matched, '只有既有匹配个体计入流动');
  assert.equal(snap.json.classFlow.stay, matched - 1);
  checkSelf(snap);
});
