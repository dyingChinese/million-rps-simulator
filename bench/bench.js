#!/usr/bin/env node
/**
 * bench/bench.js — 引擎基准测试（headless，无 HTTP / 无可视化开销）
 *
 * 用法：
 *   node bench/bench.js                                # 默认 100 万人口 × 30 回合
 *   node bench/bench.js --pop 200000 --rounds 100
 *   node bench/bench.js --pop 1000000 --rounds 50 --mode wealth
 *   node bench/bench.js --json
 */
import { performance } from 'node:perf_hooks';
import { Engine } from '../src/core/engine.js';
import { createConfig } from '../src/core/config.js';

function parseArgs(argv) {
  const out = { pop: 1_000_000, rounds: 30, warmup: 3, mode: 'random', json: false, preset: null, patch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pop') out.pop = Math.max(2, Math.floor(Number(argv[++i])));
    else if (a === '--rounds') out.rounds = Math.max(1, Math.floor(Number(argv[++i])));
    else if (a === '--warmup') out.warmup = Math.max(0, Math.floor(Number(argv[++i])));
    else if (a === '--mode') out.mode = String(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--patch') out.patch = JSON.parse(String(argv[++i]));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const cfg = createConfig({
  initialPopulation: args.pop,
  maxPopulation: Math.max(args.pop + 10, Math.round(args.pop * 2)),
  endCondition: { mode: 'C', rounds: Math.max(10_000, args.rounds + 10), maxRounds: 1_000_000 },
  matching: { mode: args.mode },
  balance: {
    // 破产清算启用时会额外分配 lastOpp 缓冲，一并纳入基准
    redistribution: { enabled: false, toLastOpponents: 5 },
  },
  ...(args.patch || {}),
});

const bench = {
  population: args.pop,
  mode: args.mode,
  initMs: 0,
  roundMsAvg: 0,
  roundMsP50: 0,
  roundMsP95: 0,
  roundsPerSec: 0,
  snapshotMsAvg: 0,
  snapshotAnalyticsMs: 0,
  frameBytes: 0,
  sampleCount: 0,
  rssMB: 0,
  heapUsedMB: 0,
  aliveAfter: 0,
  births: 0,
  deaths: 0,
  bankruptcies: 0,
  gini: 0,
  totalWealth: 0,
  parallelWorkers: 0,
};

const tInit = performance.now();
const engine = new Engine(cfg);
bench.initMs = performance.now() - tInit;

// 预热
for (let i = 0; i < args.warmup; i++) engine.tick();

const times = [];
for (let i = 0; i < args.rounds; i++) {
  const t = performance.now();
  engine.tick();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const sum = times.reduce((a, b) => a + b, 0);
bench.roundMsAvg = sum / times.length;
bench.roundMsP50 = times[Math.floor(times.length * 0.5)];
bench.roundMsP95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
bench.roundsPerSec = bench.roundMsAvg > 0 ? 1000 / bench.roundMsAvg : 0;

// 快照（含全量统计 + 帧构建）
const snapTimes = [];
let lastJson = null;
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  const { buffer, json } = engine.snapshot(i + 1);
  snapTimes.push(performance.now() - t);
  bench.frameBytes = buffer.byteLength;
  lastJson = json;
}
snapTimes.sort((a, b) => a - b);
bench.snapshotMsAvg = snapTimes[Math.floor(snapTimes.length / 2)];
bench.snapshotAnalyticsMs = lastJson.perf.analyticsMs;
bench.sampleCount = lastJson.perf.sampleCount;

const mem = process.memoryUsage();
bench.rssMB = Math.round(mem.rss / 1048576);
bench.heapUsedMB = Math.round(mem.heapUsed / 1048576);
const st = engine.getStatus();
bench.aliveAfter = st.aliveCount;
bench.births = st.births;
bench.deaths = st.deaths;
bench.bankruptcies = st.bankruptcies;
bench.gini = lastJson.wealth ? lastJson.wealth.gini : 0;
bench.totalWealth = Math.round(st.totalWealth);
bench.parallelWorkers = st.parallelWorkers || 0;
engine.close();

if (args.json) {
  console.log(JSON.stringify(bench, null, 2));
} else {
  const pad = (s, n = 28) => String(s).padEnd(n, ' ');
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║   百万猜拳演化模拟器 · 引擎基准测试                          ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  ${pad('人口规模')} ${bench.population.toLocaleString()}`);
  console.log(`  ${pad('匹配模式')} ${args.mode}`);
  console.log(`  ${pad('并行对战线程')} ${bench.parallelWorkers} 个${bench.parallelWorkers > 0 ? '（SharedArrayBuffer 无锁并行）' : '（单线程）'}`);
  console.log(`  ${pad('初始化耗时')} ${bench.initMs.toFixed(1)} ms`);
  console.log('');
  console.log(`  ${pad('每回合平均耗时')} ${bench.roundMsAvg.toFixed(2)} ms`);
  console.log(`  ${pad('每回合 P50 / P95')} ${bench.roundMsP50.toFixed(2)} / ${bench.roundMsP95.toFixed(2)} ms`);
  console.log(`  ${pad('模拟速度')} ${bench.roundsPerSec.toFixed(1)} 回合/秒  (${(bench.roundsPerSec * 60).toFixed(0)} 回合/分钟)`);
  console.log('');
  console.log(`  ${pad('快照构建（中位）')} ${bench.snapshotMsAvg.toFixed(2)} ms`);
  console.log(`  ${pad('其中全量统计分析')} ${bench.snapshotAnalyticsMs.toFixed(2)} ms`);
  console.log(`  ${pad('单帧大小')} ${(bench.frameBytes / 1024).toFixed(0)} KB  采样点 ${bench.sampleCount.toLocaleString()}`);
  console.log('');
  console.log(`  ${pad('内存 RSS / Heap')} ${bench.rssMB} MB / ${bench.heapUsedMB} MB`);
  console.log(`  ${pad('存活 / 出生 / 死亡 / 破产')} ${bench.aliveAfter.toLocaleString()} / ${bench.births.toLocaleString()} / ${bench.deaths.toLocaleString()} / ${bench.bankruptcies.toLocaleString()}`);
  console.log(`  ${pad('总资产 / 近似基尼')} ${bench.totalWealth.toLocaleString()} / ${bench.gini.toFixed(4)}`);
  if (engine.phaseMs) {
    const p = engine.phaseMs;
    const fmt = (v) => v.toFixed(2).padStart(7) + ' ms';
    console.log('');
    console.log('  阶段耗时（最近一回合）：');
    console.log(`    ${pad('世界事件(宏观调控/瘟疫)')} ${fmt(p.events)}`);
    console.log(`    ${pad('个体阶段(衰老/利息/淘汰)')} ${fmt(p.individuals)}`);
    console.log(`    ${pad('匹配对战(含结算/学习)')} ${fmt(p.battle)}`);
    console.log(`    ${pad('繁殖(遗传/突变)')} ${fmt(p.reproduce)}`);
    console.log(`    ${pad('汇总(重建存活表/统计钩子)')} ${fmt(p.aggregate)}`);
    console.log(`    ${pad('其他')} ${fmt(p.other)}`);
  }
  console.log('');
}
