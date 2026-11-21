/**
 * scripts/profile-summary.js — 解析 V8 .cpuprofile，输出热点函数（自耗时）排行
 * 用法: node scripts/profile-summary.js artifacts/cpu.cpuprofile [topN]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'artifacts/cpu.cpuprofile';
const topN = Number(process.argv[3] || 20);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map();
for (const n of prof.nodes) byId.set(n.id, n);

const self = new Map();
let total = 0;
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i];
  const dt = prof.timeDeltas[i] || 0;
  total += dt;
  self.set(id, (self.get(id) || 0) + dt);
}

const rows = [];
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  const name = cf.functionName || '(anonymous)';
  const url = cf.url ? cf.url.replace(/^file:\/\/\//, '').replace(/^.*CodeRepository\//, '') : '';
  rows.push({ name, url, line: cf.lineNumber + 1, us, pct: (us / total) * 100 });
}
rows.sort((a, b) => b.us - a.us);
console.log(`总采样时间: ${(total / 1000).toFixed(0)} ms`);
console.log('自耗时排名:');
for (const r of rows.slice(0, topN)) {
  console.log(
    `${r.pct.toFixed(2).padStart(6)}%  ${(r.us / 1000).toFixed(1).padStart(8)} ms  ${r.name.padEnd(28)} ${r.url}:${r.line}`,
  );
}
