/**
 * scripts/run-tests.js — 顺序运行全部测试文件（零依赖，兼容受限沙箱）
 * 用法: node scripts/run-tests.js
 *
 * 说明：在部分受限环境（如 Windows 沙箱）中 `node --test` 派生子进程会失败，
 * 这里改为逐个文件直接以子进程运行（stdio: inherit），输出 TAP 结果并汇总退出码。
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.cwd());
const testDir = join(ROOT, 'test');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('未找到测试文件（test/*.test.js）');
  process.exit(1);
}

let failed = 0;
const results = [];
for (const f of files) {
  const full = join(testDir, f);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ file: f, ok, ms });
}

console.log('\n══════════════════════════════════════════════');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'}  ${r.file.padEnd(28)} ${r.ms} ms`);
console.log(`\n共 ${results.length} 个测试文件，${failed} 个失败`);
process.exitCode = failed === 0 ? 0 : 1;
