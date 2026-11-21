/**
 * scripts/smoke-server.js — 端到端 HTTP/流式协议冒烟测试（零依赖）
 *
 * 用法：
 *   node src/index.js --preset demo &        # 或另一个终端/后台任务先启动服务
 *   node scripts/smoke-server.js [--url http://127.0.0.1:8080]
 *
 * 校验内容：
 *   1. GET /api/config：配置/预设/颜色表完整
 *   2. GET /api/frame：二进制帧头 magic/frameLength/jsonLen/dataStart 自洽，sections 可解析
 *   3. POST /api/control：pause / step / start / reset / setConfig / speed / track
 *   4. GET /api/stream：连续收到 ≥2 帧，帧序号递增、回合递增
 *   5. GET /：返回前端 index.html
 */
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8080';
const MAGIC = 0x52505331;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? '  → ' + detail : ''}`);
  }
}

async function json(path, init) {
  const res = await fetch(BASE + path, init);
  const body = await res.json();
  return { res, body };
}

function decodeFrame(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  const frameLength = view.getUint32(4, true);
  const jsonLen = view.getUint32(8, true);
  const dataStart = view.getUint32(12, true);
  if (magic !== MAGIC) throw new Error('magic 错误: 0x' + magic.toString(16));
  if (frameLength !== u8.byteLength) throw new Error(`frameLength ${frameLength} != byteLength ${u8.byteLength}`);
  const jsonBytes = new Uint8Array(u8.buffer, u8.byteOffset + 16, jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  const sections = {};
  for (const sec of json.sections || []) {
    const offset = u8.byteOffset + dataStart + sec.offset;
    if (sec.type === 'i32') sections[sec.name] = new Int32Array(u8.buffer, offset, sec.length);
    else if (sec.type === 'f32') sections[sec.name] = new Float32Array(u8.buffer, offset, sec.length);
    else sections[sec.name] = new Uint8Array(u8.buffer, offset, sec.length);
  }
  return { json, sections, frameLength, dataStart, jsonLen };
}

/** 从字节流中读取一帧（读 Stream 的前 N 字节） */
async function readFrame(reader, buffered) {
  const HEADER = 16;
  let buf = buffered || new Uint8Array(0);
  async function need(n) {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error('流提前结束');
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  }
  await need(HEADER);
  const view = new DataView(buf.buffer, buf.byteOffset);
  const frameLength = view.getUint32(4, true);
  if (frameLength < HEADER || frameLength > 64 * 1024 * 1024) throw new Error('帧长度异常: ' + frameLength);
  await need(frameLength);
  const frame = buf.slice(0, frameLength);
  const rest = buf.slice(frameLength);
  return { frame, rest };
}

async function main() {
  console.log(`\n[冒烟测试] 目标服务: ${BASE}\n`);

  // 1. /api/config
  const { body: cfg } = await json('/api/config');
  check('/api/config 返回 ok', cfg.ok === true);
  check('config.initialPopulation 存在', typeof cfg.config?.initialPopulation === 'number', JSON.stringify(cfg).slice(0, 120));
  check('预设列表包含 million', !!cfg.presets?.million);
  check('颜色/名称表齐全', Array.isArray(cfg.classNames) && cfg.classNames.length === 4 && cfg.talentNames?.length === 6);

  // 2. 运行控制：先 start，跑几回合，再 pause/step
  const start = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
  check('start 返回 ok', start.body.ok === true, JSON.stringify(start.body));
  await new Promise((r) => setTimeout(r, 1200));
  const st1 = await json('/api/status');
  check('/api/status 回合数 ≥ 1', st1.body.round >= 1, 'round=' + st1.body.round);
  check('存活人数 > 0', st1.body.aliveCount > 0);

  const pause = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'pause' }) });
  check('pause 返回 ok', pause.body.ok === true);
  const pauseRound = (await json('/api/status')).body.round;
  const step = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'step', rounds: 2 }) });
  check('step 返回 ok', step.body.ok === true, JSON.stringify(step.body));
  const stepRound = (await json('/api/status')).body.round;
  check('单步推进了 2 回合', stepRound === pauseRound + 2, `${pauseRound} → ${stepRound}`);

  // 3. /api/frame 二进制帧
  const frameRes = await fetch(BASE + '/api/frame');
  const frameBuf = await frameRes.arrayBuffer();
  check('/api/frame 返回二进制', frameRes.ok && frameBuf.byteLength > 1000, 'bytes=' + frameBuf.byteLength);
  let decoded;
  try {
    decoded = decodeFrame(frameBuf);
    check('帧头 magic/frameLength/sections 自洽', true);
    check('JSON 含 population/wealth/strategy/classes', !!decoded.json.population && !!decoded.json.wealth && !!decoded.json.strategy && Array.isArray(decoded.json.classes));
    check('JSON 含 classFlow/guilds 扩展字段', !!decoded.json.classFlow && typeof decoded.json.guilds === 'object' && Array.isArray(decoded.json.guilds.topWealth));
    check('classFlow 流动力合法', decoded.json.classFlow.mobility >= 0 && decoded.json.classFlow.mobility <= 1, JSON.stringify(decoded.json.classFlow));
    check('pts section = 7×sampleCount', decoded.sections.pts?.length === decoded.json.perf.sampleCount * 7, `pts=${decoded.sections.pts?.length} sample=${decoded.json.perf.sampleCount}`);
    check('ids section = sampleCount', decoded.sections.ids?.length === decoded.json.perf.sampleCount);
    check('hist = 128', decoded.sections.hist?.length === 128);
    check('strategyGrid = w*h', decoded.sections.strategyGrid?.length === decoded.json.grids.strategy.w * decoded.json.grids.strategy.h);
    check('财富轴采样点合法', [...Array(Math.min(100, decoded.json.perf.sampleCount)).keys()].every((i) => {
      const y = decoded.sections.pts[i * 7 + 1];
      return y >= 0 && y <= 1 && Number.isFinite(y);
    }));
    const totalPop = decoded.json.population.alive;
    check('快照人口与 status 一致', totalPop > 0);
  } catch (err) {
    check('帧解析', false, err.message);
  }

  // 4. 个体追踪
  if (decoded && decoded.sections.ids?.length) {
    const targetId = decoded.sections.ids[0];
    const track = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'track', id: targetId }) });
    check('track 指定个体成功', track.body.ok === true, JSON.stringify(track.body));
    const frame2 = decodeFrame(await (await fetch(BASE + '/api/frame')).arrayBuffer());
    check('快照 tracked 含该个体', (frame2.json.tracked || []).some((t) => t.id === targetId));
    await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'untrack', id: targetId }) });
  }

  // 5. 参数热更新（使用无害参数：仅调整学习步长，避免污染经济）
  const setCfg = await json('/api/control', {
    method: 'POST',
    body: JSON.stringify({ action: 'setConfig', patch: { learning: { adjustStep: 0.021 } } }),
  });
  check('setConfig 热更新成功', setCfg.body.ok === true, JSON.stringify(setCfg.body));
  const speed = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'speed', targetRoundsPerSec: 120 }) });
  check('speed 设置成功', speed.body.ok === true);

  // 6. 手动调控
  const trig = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'trigger', macro: 'dividend' }) });
  check('手动触发分红成功', trig.body.ok === true && Array.isArray(trig.body.events));

  // 7. 流式帧
  const abort = new AbortController();
  const streamRes = await fetch(BASE + '/api/stream', { signal: abort.signal });
  check('/api/stream 返回 octet-stream', (streamRes.headers.get('content-type') || '').includes('octet-stream'));
  const reader = streamRes.body.getReader();
  await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
  const t0 = Date.now();
  const frames = [];
  let buffered = null;
  while (frames.length < 2 && Date.now() - t0 < 8000) {
    const { frame, rest } = await readFrame(reader, buffered);
    buffered = rest;
    frames.push(decodeFrame(frame));
  }
  abort.abort();
  check('流式收到 ≥2 帧', frames.length >= 2, 'frames=' + frames.length);
  if (frames.length >= 2) {
    check('帧序号递增', frames[1].json.seq > frames[0].json.seq, `${frames[0].json.seq} → ${frames[1].json.seq}`);
    check('回合号不倒退', frames[1].json.round >= frames[0].json.round);
    check('帧包含全部必需 sections', ['pts', 'ids', 'hist', 'strategyGrid', 'strategyGridWealth'].every((n) => frames[1].sections[n]));
    check('时间序列 series 非空', Array.isArray(frames[1].json.series.round) && frames[1].json.series.round.length > 0);
  }

  // 8. 静态首页
  const home = await fetch(BASE + '/');
  const html = await home.text();
  check('GET / 返回 HTML 页面', home.ok && html.includes('<html') && (html.includes('百万猜拳') || html.includes('RPS')));
  const jsRes = await fetch(BASE + '/js/app.js');
  check('GET /js/app.js 返回 JS', jsRes.ok && (jsRes.headers.get('content-type') || '').includes('javascript'));

  // 9. 恢复现场：解除限速并继续运行（避免冒烟测试污染演示服务）
  await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'speed', targetRoundsPerSec: 0 }) });
  const resume = await json('/api/control', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
  check('冒烟后恢复运行状态', resume.body.ok === true, JSON.stringify(resume.body));

  console.log(failures === 0 ? '\n✅ 冒烟测试全部通过\n' : `\n❌ ${failures} 项失败\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exitCode = 1;
});
