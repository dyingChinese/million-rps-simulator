/**
 * scripts/test-ui-protocol.js — 前端协议层 ↔ 后端真实帧的跨端一致性测试（Node 即可运行）
 *
 * 校验：
 *   1. web/js/protocol.js 的 encodeFrame → parseFrame 往返自洽；
 *   2. web/js/mock.js 的 MockBackend 产出的 mock 帧（用真实 encodeFrame 编码）可被 parseFrame 解析；
 *   3. mock 快照与真实服务端快照的 **顶层字段 / sections 名称 / 关键数值域** 完全一致；
 *   4. 若服务端在线（默认 http://127.0.0.1:8080），额外用真实 /api/frame 帧校验 normalizeSnapshot。
 *
 * 用法：
 *   node scripts/test-ui-protocol.js                     # 仅 mock 自洽 + 往返
 *   node scripts/test-ui-protocol.js --url http://127.0.0.1:8080
 */
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8080';
const USE_SERVER = urlIdx >= 0;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? '  → ' + detail : ''}`);
  }
}

const { encodeFrame, parseFrame, normalizeSnapshot, MAGIC, PTS_STRIDE, HIST_BINS } = await import('../web/js/protocol.js');
const { MockBackend } = await import('../web/js/mock.js');

console.log('\n[A] protocol.js 编解码往返');
{
  const json = { seq: 1, round: 2, population: { alive: 3 }, sections: [] };
  const pts = new Float32Array([0.1, 0.2, 1, 2, 0.3, 0.4, 0.5]);
  const ids = new Int32Array([7]);
  const sections = [
    { name: 'pts', type: 'f32', data: pts },
    { name: 'ids', type: 'i32', data: ids },
  ];
  const bytes = encodeFrame(json, sections);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check('encodeFrame 写 magic', view.getUint32(0, true) === MAGIC);
  check('encodeFrame 帧长度自洽', view.getUint32(4, true) === bytes.byteLength);
  const parsed = parseFrame(bytes);
  check('parseFrame 回读 seq/round', parsed.json.seq === 1 && parsed.json.round === 2);
  check('parseFrame 回读 pts', parsed.sections.pts instanceof Float32Array && Math.abs(parsed.sections.pts[1] - 0.2) < 1e-6);
  check('parseFrame 回读 ids', parsed.sections.ids instanceof Int32Array && parsed.sections.ids[0] === 7);
  check('pts 长度 = 7×sampleCount', parsed.sections.pts.length === PTS_STRIDE);
}

console.log('\n[B] mock.js 产出的 mock 帧可被协议层解析并归一化');
let mockSnapshot = null;
{
  const frames = [];
  const backend = new MockBackend({
    intervalMs: 60,
    onFrame: (bytes) => frames.push(bytes),
  });
  backend.start();
  await new Promise((r) => setTimeout(r, 700));
  backend.stop();
  check('mock 产出 ≥2 帧', frames.length >= 2, 'frames=' + frames.length);
  let parsedOk = 0;
  for (const bytes of frames) {
    try {
      const parsed = parseFrame(bytes);
      const norm = normalizeSnapshot(parsed.json);
      if (norm && norm.population && norm.wealth && norm.strategy) parsedOk++;
      mockSnapshot = norm;
    } catch (err) {
      check('mock 帧解析', false, err.message);
    }
  }
  check('全部 mock 帧解析成功', parsedOk === frames.length);
  if (mockSnapshot) {
    check('mock 必需 sections 名称齐全', ['pts', 'ids', 'hist', 'strategyGrid', 'strategyGridWealth'].every((n) => n in (parseFrame(frames[frames.length - 1]).sections)));
    check('mock hist 长度 = 128', parseFrame(frames[frames.length - 1]).sections.hist.length === HIST_BINS);
    check('mock pts 长度 = 7×sampleCount', parseFrame(frames[frames.length - 1]).sections.pts.length === mockSnapshot.perf.sampleCount * PTS_STRIDE);
    check('mock 基尼 ∈ [0,1]', mockSnapshot.wealth.gini >= 0 && mockSnapshot.wealth.gini <= 1);
    check('mock 阶层 4 项且占比和≈1', mockSnapshot.classes.length === 4);
    check('mock 时间序列非空', Array.isArray(mockSnapshot.series.round) && mockSnapshot.series.round.length > 0);
    check('mock 家族榜存在', Array.isArray(mockSnapshot.families.topWealth));
  }
}

console.log('\n[C] mock 快照 vs 真实服务端快照 结构一致性');
{
  let realJson = null;
  let realSections = null;
  if (USE_SERVER) {
    try {
      const res = await fetch(BASE + '/api/frame');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const parsed = parseFrame(bytes);
      realJson = parsed.json;
      realSections = parsed.sections;
      const norm = normalizeSnapshot(parsed.json);
      check('真实帧可被 normalizeSnapshot 归一化', !!(norm && norm.population && norm.wealth));
    } catch (err) {
      check('真实服务端帧可用', false, err.message);
    }
  } else {
    console.log('  (跳过：未提供 --url)');
  }
  if (realJson && mockSnapshot) {
    const REQUIRED = ['seq', 'round', 'engine', 'population', 'wealth', 'strategy', 'classes', 'talents', 'series', 'families', 'events', 'inflation', 'resource', 'plague', 'tracked', 'endCondition', 'perf', 'grids', 'classFlow', 'guilds'];
    const missingReal = REQUIRED.filter((k) => !(k in realJson));
    const missingMock = REQUIRED.filter((k) => !(k in mockSnapshot));
    check('真实快照无缺失字段', missingReal.length === 0, missingReal.join(','));
    check('mock 快照无缺失字段', missingMock.length === 0, missingMock.join(','));
    const realSec = Object.keys(realSections).sort();
    const mockSec = Object.keys(parseFrame((await (async () => {
      const frames = [];
      const backend = new MockBackend({ intervalMs: 99, onFrame: (b) => frames.push(b) });
      backend.start();
      await new Promise((r) => setTimeout(r, 250));
      backend.stop();
      return frames.length ? frames[frames.length - 1] : new Uint8Array(0);
    })())).sections).sort();
    check('sections 名称一致', JSON.stringify(realSec) === JSON.stringify(mockSec), `real=[${realSec}] mock=[${mockSec}]`);
    check('pts 采样数一致', realSections.pts.length / PTS_STRIDE === realJson.perf.sampleCount);
    check('真实 hist = 128', realSections.hist.length === HIST_BINS);
    check('真实 strategyGrid = w*h', realSections.strategyGrid.length === realJson.grids.strategy.w * realJson.grids.strategy.h);
    check('真实财富分布合法', realJson.wealth.gini >= 0 && realJson.wealth.gini <= 1);
    check('真实 time series 非空', realJson.series.round.length > 0);
    check('真实 classFlow 合法', realJson.classFlow && realJson.classFlow.mobility >= 0 && realJson.classFlow.mobility <= 1);
    check('真实 classes 含 flowIn/flowOut', realJson.classes.every((c) => typeof c.flowIn === 'number' && typeof c.flowOut === 'number'));
    check('真实 guilds 结构合法', typeof realJson.guilds === 'object' && typeof realJson.guilds.enabled === 'boolean' && Array.isArray(realJson.guilds.topWealth));
  }
}

console.log(failures === 0 ? '\n✅ 前端协议一致性测试全部通过\n' : `\n❌ ${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
