/**
 * scripts/profile-lines.js — 输出某个函数内部的行级热点（来自 V8 positionTicks）
 * 用法: node scripts/profile-lines.js artifacts/cpu.cpuprofile _battle
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'artifacts/cpu.cpuprofile';
const fnName = process.argv[3] || '_battle';
const prof = JSON.parse(readFileSync(file, 'utf8'));

const fileLines = new Map();

function readSource(url) {
  if (!url || !url.startsWith('file://')) return null;
  if (fileLines.has(url)) return fileLines.get(url);
  try {
    const { readFileSync: rf } = require('node:fs');
    const content = rf(new URL(url), 'utf8');
    fileLines.set(url, content);
    return content;
  } catch {
    fileLines.set(url, null);
    return null;
  }
}

for (const node of prof.nodes) {
  const cf = node.callFrame;
  if ((cf.functionName || '').includes(fnName) && Array.isArray(node.positionTicks) && node.positionTicks.length) {
    const url = cf.url;
    const src = readSource(url);
    const lines = url && src ? src.split(/\r?\n/) : [];
    const sorted = [...node.positionTicks].sort((a, b) => b.ticks - a.ticks);
    const total = sorted.reduce((a, b) => a + b.ticks, 0);
    console.log(`函数 ${cf.functionName}  (${url}) 行级 tick 总数=${total}`);
    for (const pt of sorted.slice(0, 30)) {
      const text = lines[pt.line] ? lines[pt.line].trim().slice(0, 120) : '';
      console.log(`  line ${String(pt.line).padStart(5)}  ticks ${String(pt.ticks).padStart(5)}  ${text}`);
    }
  }
}
