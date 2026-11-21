#!/usr/bin/env node
/**
 * index.js — 启动「百万猜拳演化模拟器」Web 服务
 *
 * 用法：
 *   node src/index.js                          # 默认百万人口、端口 8080，自动开始运行
 *   node src/index.js --port 8080 --preset standard
 *   node src/index.js --preset demo --paused   # 暂停状态启动，等待 UI 点“运行”
 *   node src/index.js --patch '{"matching":{"mode":"wealth"}}'
 */
import { startServer } from './server/server.js';
import { createConfig, mergeConfig, presetPatch, PRESETS } from './core/config.js';

const HELP = `
百万猜拳演化模拟器 · 服务端

选项：
  --port <n>          监听端口（默认 8080）
  --host <addr>       监听地址（默认 127.0.0.1；局域网访问用 0.0.0.0）
  --preset <name>     人口预设：${Object.keys(PRESETS).map((k) => `${k}(${PRESETS[k].label})`).join(' / ')}
  --patch '<json>'    额外配置补丁（JSON），如 '{"matching":{"mode":"wealth"}}'
  --paused            启动后暂停（不自动开始模拟）
  -h, --help          显示帮助
`;

function parseArgs(argv) {
  const out = { port: 8080, host: '127.0.0.1', preset: null, paused: false, patch: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = String(argv[++i]);
    else if (a === '--preset') out.preset = String(argv[++i]);
    else if (a === '--paused') out.paused = true;
    else if (a === '--patch') {
      try {
        out.patch = JSON.parse(String(argv[++i]));
      } catch (err) {
        console.error('--patch 需要合法 JSON:', err.message);
        process.exit(1);
      }
    } else if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.preset && !PRESETS[args.preset]) {
  console.error(`未知预设 "${args.preset}"，可选：${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const basePatch = args.preset ? presetPatch(args.preset) : {};
const configPatch = mergeConfig(basePatch, args.patch);

console.log('');
console.log('  ✊✌️🖐  百万猜拳演化模拟器  MILLION-AGENT RPS EVOLUTION SIMULATOR');
console.log('  ───────────────────────────────────────────────────────────────═');
const preview = createConfig(configPatch);
console.log(`  人口规模: ${preview.initialPopulation.toLocaleString()}  预置: ${args.preset || '默认（百万）'}`);
console.log('  正在初始化模拟引擎（Worker 线程）……');

let instance;
try {
  instance = await startServer({
    port: args.port,
    host: args.host,
    configPatch,
    autostart: !args.paused,
  });
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${args.port} 已被占用，请用 --port 换一个端口。\n`);
  } else {
    console.error('\n  启动失败:', err && err.stack ? err.stack : err);
  }
  process.exit(1);
}

const st = instance.getStatus();
console.log('');
console.log(`  ✅ 服务已启动:  ${instance.url}`);
console.log(`  🌐 打开浏览器访问上面的地址即可看到实时可视化控制台`);
console.log(`  🎛  预设可切换: ${Object.keys(PRESETS).join(' / ')}`);
console.log(`  📊 当前状态: 第 ${st.round} 回合 · 存活 ${Number(st.aliveCount || 0).toLocaleString()} · 回合/秒 ${Number(st.rps || 0).toFixed(1)}`);
console.log('');
console.log('  按 Ctrl+C 退出。\n');

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  正在关闭服务与模拟引擎……');
  try {
    await instance.close();
  } catch {
    /* 忽略 */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
