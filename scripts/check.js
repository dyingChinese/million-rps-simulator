/**
 * scripts/check.js — 全项目零依赖自检
 *  1) 用 `node --check` 对所有 JS 文件做语法检查
 *  2) 动态 import 所有 src/core 模块，检查模块间接口/导入是否可用
 * 用法: node scripts/check.js
 */
import { readdir } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.cwd());

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (extname(e.name) === '.js') out.push(p);
  }
  return out;
}

const files = [];
for (const sub of ['src', 'web/js', 'bench', 'test', 'scripts']) {
  try {
    files.push(...(await walk(join(ROOT, sub))));
  } catch {
    /* 目录不存在则跳过 */
  }
}

let syntaxFail = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
  if (r.status !== 0) {
    syntaxFail++;
    console.error(`SYNTAX FAIL  ${file.slice(ROOT.length + 1)}`);
  }
}
console.log(`语法检查: ${files.length} 个文件, ${syntaxFail} 个失败`);

// 核心模块导入检查（只导入无副作用的 core 模块）
let importFail = 0;
const coreDir = join(ROOT, 'src', 'core');
const coreFiles = files.filter((f) => f.startsWith(coreDir + sep));
for (const file of coreFiles) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  try {
    await import(`${pathToFileURL(file).href}?check=${Date.now()}`);
  } catch (err) {
    importFail++;
    console.error(`IMPORT FAIL  ${rel}: ${err && err.message}`);
  }
}
console.log(`导入检查: ${coreFiles.length} 个核心模块, ${importFail} 个失败`);

if (syntaxFail + importFail > 0) process.exitCode = 1;
else console.log('全部通过 ✅');
