/**
 * artifacts/verify-pause.mjs — 独立复核「暂停/预设/参数变更不会自己跑起来」语义
 * 用法: node artifacts/verify-pause.mjs [http://127.0.0.1:8080]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? '  → ' + detail : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(path, init) {
  const res = await fetch(BASE + path, init);
  return res.json();
}
const control = (body) => j('/api/control', { method: 'POST', body: JSON.stringify(body) });
const status = () => j('/api/status');

console.log(`\n[复核] 暂停/预设/参数变更状态语义 @ ${BASE}\n`);

// 0) 起始：确保运行
await control({ action: 'start' });
await sleep(800);
let st = await status();
check('起始状态为 running', st.status === 'running', st.status);

// 1) 暂停后保持暂停（不会被自动恢复）
const r1 = await control({ action: 'pause' });
check('pause 返回 paused', r1.status === 'paused', JSON.stringify(r1));
const roundAtPause = (await status()).round;
await sleep(1600);
st = await status();
check('暂停 1.6s 后仍为 paused', st.status === 'paused', st.status);
check('暂停期间回合数不增长', st.round === roundAtPause, `${roundAtPause} → ${st.round}`);

// 2) 暂停时改普通参数：不重置、保持 paused
const r2 = await control({ action: 'setConfig', patch: { learning: { adjustStep: 0.02 } } });
check('暂停时热更新参数成功（不重置）', r2.ok === true && r2.reset !== true, JSON.stringify(r2));
await sleep(500);
st = await status();
check('热更新后仍为 paused', st.status === 'paused', st.status);

// 3) 暂停时切预设：保持 paused，round=0
const r3 = await control({ action: 'preset', name: 'standard' });
check('暂停时切预设成功', r3.ok === true, JSON.stringify(r3));
await sleep(800);
st = await status();
check('切预设后状态为 paused', st.status === 'paused', st.status);
check('切预设后回合为 0', st.round === 0, 'round=' + st.round);
check('切预设后人口为 20 万', st.aliveCount === 200000 || st.initialPopulation === 200000, `alive=${st.aliveCount} initial=${st.initialPopulation}`);

// 4) reset 默认停在 paused
const r4 = await control({ action: 'reset' });
check('reset 成功', r4.ok === true, JSON.stringify(r4));
await sleep(800);
st = await status();
check('reset 后状态为 paused', st.status === 'paused', st.status);

// 5) resume 后恢复运行
const r5 = await control({ action: 'resume' });
check('resume 成功且 status=running', r5.ok === true && r5.status === 'running', JSON.stringify(r5));
await sleep(1200);
st = await status();
check('resume 后 1.2s 状态为 running', st.status === 'running', st.status);
check('resume 后回合增长', st.round > 0, 'round=' + st.round);

// 6) 暂停时改人口参数（触发重置）：保持 paused、round=0
await control({ action: 'pause' });
const r6 = await control({ action: 'setConfig', patch: { initialPopulation: 20000 } });
check('人口参数变更触发 reset', r6.ok === true && r6.reset === true, JSON.stringify(r6));
await sleep(800);
st = await status();
check('重置型参数变更后仍为 paused', st.status === 'paused', st.status);
check('重置型参数变更后回合为 0', st.round === 0, 'round=' + st.round);

// 7) 运行中切预设：保持 running
await control({ action: 'start' });
await sleep(600);
await control({ action: 'preset', name: 'demo' });
await sleep(1200);
st = await status();
check('运行中切预设后保持 running', st.status === 'running', st.status);
check('运行中切预设后人口为 5 万', st.initialPopulation === 50000, 'initial=' + st.initialPopulation);

// 8) 最新帧中的 engine.status 与 HTTP 状态一致（前端徽章依据）
const buf = await (await fetch(BASE + '/api/frame')).arrayBuffer();
const dv = new DataView(buf);
const jsonLen = dv.getUint32(8, true);
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, jsonLen)));
check('快照 engine.status 与状态一致', json.engine.status === st.status, `frame=${json.engine.status} http=${st.status}`);

// 9) 恢复默认百万预设并保持运行，供演示
await control({ action: 'preset', name: 'million' });
await control({ action: 'start' });
await sleep(1500);
st = await status();
check('演示状态已恢复为百万预设运行中', st.status === 'running' && st.initialPopulation === 1000000, `${st.status} initial=${st.initialPopulation}`);

console.log(failures === 0 ? '\n✅ 暂停/预设/参数变更语义复核全部通过\n' : `\n❌ ${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
