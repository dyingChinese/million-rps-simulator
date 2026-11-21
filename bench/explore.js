/**
 * bench/explore.js — 经济/演化动态探索脚本（用于调参，不属于产品功能）
 * 用法: node bench/explore.js --pop 200000 --rounds 300 --every 25 [--dividend]
 */
import { Engine } from '../src/core/engine.js';
import { createConfig } from '../src/core/config.js';

const args = { pop: 200_000, rounds: 300, every: 25, dividend: false, mode: 'random', seed: 20241120, patch: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--pop') args.pop = Number(process.argv[++i]);
  else if (a === '--rounds') args.rounds = Number(process.argv[++i]);
  else if (a === '--every') args.every = Number(process.argv[++i]);
  else if (a === '--mode') args.mode = process.argv[++i];
  else if (a === '--seed') args.seed = Number(process.argv[++i]);
  else if (a === '--dividend') args.dividend = true;
  else if (a === '--patch') args.patch = JSON.parse(process.argv[++i]);
}

const basePatch = {
  seed: args.seed,
  initialPopulation: args.pop,
  maxPopulation: args.pop * 2,
  matching: { mode: args.mode },
  endCondition: { mode: 'C', rounds: args.rounds, maxRounds: 1_000_000 },
  ...(args.dividend
    ? {
        macro: {
          average: { enabled: false },
          dividend: { enabled: true, startRound: 1, everyRounds: 10, probability: 0.8, affectedPct: 10, amount: 1200 },
        },
      }
    : {}),
  ...(args.patch || {}),
};
const cfg = createConfig(basePatch);

const engine = new Engine(cfg);
console.log(
  `\n人口=${args.pop.toLocaleString()} 模式=${args.mode} 红利=${args.dividend ? '每10回合*80%*10%个体+1200' : '默认'} 初始总资产=${(cfg.initialPopulation * cfg.initialWealth).toExponential(3)}`,
);
const header = ['回合', '存活', '存活%', '出生', '破产', '总资产', '均值', '中位', 'P90', '最大', '基尼', '有产者>2000', '通胀'];
console.log(header.map((s) => s.padStart(9)).join(' '));
const t0 = performance.now();
for (let r = 1; r <= args.rounds; r++) {
  engine.tick();
  if (r % args.every === 0 || r === args.rounds) {
    const { json } = engine.snapshot(r);
    const w = json.wealth;
    const st = engine.getStatus();
    let rich = 0;
    const store = engine.store;
    for (let i = 0; i < store.aliveCount; i++) if (store.assets[store.aliveList[i]] > 2000) rich++;
    const row = [
      r,
      st.aliveCount,
      ((st.aliveCount / args.pop) * 100).toFixed(1) + '%',
      st.births,
      st.bankruptcies,
      Math.round(w.total),
      Math.round(w.mean),
      Math.round(w.median),
      Math.round(w.p90),
      Math.round(w.max),
      w.gini.toFixed(3),
      rich,
      st.inflationFactor.toFixed(3),
    ];
    console.log(row.map((s) => String(s).padStart(9)).join(' '));
  }
}
const dt = performance.now() - t0;
console.log(`\n耗时 ${(dt / 1000).toFixed(2)}s  平均 ${(dt / args.rounds).toFixed(1)}ms/回合  ${(1000 / (dt / args.rounds)).toFixed(1)} 回合/秒`);
