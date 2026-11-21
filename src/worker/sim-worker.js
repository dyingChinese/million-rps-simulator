/**
 * sim-worker.js — 模拟引擎 Worker 线程
 *
 * 主线程（HTTP 服务）通过消息与它通信：
 *   主 → Worker : {type:'control', id, payload:{action, ...}}  控制指令（带请求 id）
 *                {type:'viewers', count}                       当前观看流的前端数量
 *   Worker → 主 : {type:'frame', buffer}                       新快照帧（ArrayBuffer，transfer）
 *                {type:'frameSingle', id, buffer}              请求式单帧（/api/frame 用）
 *                {type:'controlResult', id, result}            控制指令结果
 *                {type:'status', data}                         轻量状态（/api/status）
 *                {type:'config', config}                       配置已变化（/api/config 缓存）
 *                {type:'error', message}                       未捕获异常
 *
 * 循环策略：
 *   - 运行中：每次事件循环跑一小批回合（全速时约 11ms 一批，限速时按目标 rps 批量+休眠），
 *     然后主动让出线程，保证主线程能及时推送帧与处理 HTTP。
 *   - 只有存在观看者（或显式请求）时才构建快照，headless/bench 场景零快照开销。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { Engine } from '../core/engine.js';
import { createConfig, presetPatch } from '../core/config.js';

const patch = (workerData && workerData.configPatch) || {};
let engine;
try {
  engine = new Engine(createConfig(patch));
} catch (err) {
  parentPort.postMessage({ type: 'error', message: '引擎初始化失败: ' + (err && err.stack ? err.stack : err) });
  throw err;
}

let viewers = 0;
let seq = 0;
let lastSnapshotAt = 0;
let lastFrameRound = -1;
let lastRoundForRps = engine.round;
let lastRpsAt = performance.now();
let stopped = false;
let statusInterval = null;
let lastSentStatus = '';

function post(msg, transfer) {
  try {
    if (transfer && transfer.length) parentPort.postMessage(msg, transfer);
    else parentPort.postMessage(msg);
  } catch (err) {
    process.stderr.write('[sim-worker] postMessage 失败: ' + err + '\n');
  }
}

/** 自适应快照间隔：分析耗时越大，间隔越长（保证每帧分析 CPU 占比 ≤ ~20%） */
function adaptiveSnapshotInterval() {
  const base = engine.cfg.performance.snapshotIntervalMs;
  const analyticsMs = (engine.summary && engine.summary.perf && engine.summary.perf.analyticsMs) || 0;
  return Math.min(600, Math.max(base, analyticsMs * 6));
}

function computeRps() {
  const now = performance.now();
  const dt = now - lastRpsAt;
  if (dt >= 250) {
    const dr = engine.round - lastRoundForRps;
    engine.roundsPerSec = dt > 0 ? (dr / dt) * 1000 : 0;
    lastRoundForRps = engine.round;
    lastRpsAt = now;
  }
}

/**
 * 构建并推送一帧快照。
 * @param {boolean} force 忽略间隔限制
 * @returns {boolean} 是否发出
 */
function pushFrame(force) {
  const now = performance.now();
  if (!force) {
    if (engine.round === lastFrameRound) return false;
    if (now - lastSnapshotAt < adaptiveSnapshotInterval()) return false;
  }
  computeRps();
  const t0 = performance.now();
  const { buffer } = engine.snapshot(++seq);
  lastSnapshotAt = now;
  lastFrameRound = engine.round;
  // 记录构建耗时（下次自适应间隔可见）
  if (engine.summary && engine.summary.perf) {
    engine.summary.perf.frameBuildMs = performance.now() - t0;
  }
  post({ type: 'frame', buffer }, [buffer]);
  return true;
}

function sendStatus(force) {
  const st = engine.getStatus();
  st.rps = engine.roundsPerSec || 0;
  st.seq = seq;
  st.viewers = viewers;
  const s = JSON.stringify(st);
  if (!force && s === lastSentStatus) return;
  lastSentStatus = s;
  post({ type: 'status', data: st });
}

function sendConfig() {
  post({ type: 'config', config: engine.cfg });
}

/**
 * 把引擎置为「暂停」状态，且不跑任何回合。
 * engine 没有直接设置 paused 的 API，这里 start→pause 把状态归位为 paused
 * （同步调用之间不会执行 tick），用于「重置 / 切预设后保持暂停、不自动开跑」的语义。
 */
function forcePaused() {
  engine.start();
  engine.pause();
}

/** 主循环 */
function pump() {
  if (stopped) return;
  const status = engine.status;
  if (status !== 'running') {
    if (viewers > 0) pushFrame(false);
    setTimeout(pump, 60);
    return;
  }
  const t0 = performance.now();
  const target = engine.cfg.speed.targetRoundsPerSec || 0;
  try {
    if (target > 0) {
      const batch = Math.max(1, Math.min(4000, Math.ceil(target * 0.012)));
      for (let i = 0; i < batch; i++) {
        if (engine.tick()) break;
      }
      computeRps();
      if (viewers > 0) pushFrame(false);
      const want = (batch / target) * 1000;
      const work = performance.now() - t0;
      setTimeout(pump, Math.max(0, want - work));
    } else {
      do {
        if (engine.tick()) break;
      } while (performance.now() - t0 < 11);
      computeRps();
      if (viewers > 0) pushFrame(false);
      setImmediate(pump);
    }
  } catch (err) {
    post({ type: 'error', message: '模拟循环异常: ' + (err && err.stack ? err.stack : err) });
    engine.pause();
    setTimeout(pump, 200);
  }
  if (engine.status === 'ended') sendStatus(true);
}

/** 处理控制指令 */
function handleControl(msg) {  const { id, payload } = msg;
  const action = payload && payload.action;
  let result;
  try {
    switch (action) {
      case 'start': {
        engine.start();
        result = { ok: true, status: engine.status };
        break;
      }
      case 'pause': {
        engine.pause();
        result = { ok: true, status: engine.status };
        break;
      }
      case 'resume': {
        engine.resume();
        result = { ok: true, status: engine.status };
        break;
      }
      case 'step': {
        result = engine.step(Math.max(1, Math.min(100_000, Number(payload.rounds) || 1)));
        result.status = engine.status;
        pushFrame(true);
        break;
      }
      case 'reset': {
        engine.reset(engine.cfg);
        seq = 0;
        lastFrameRound = -1;
        lastRoundForRps = 0;
        lastRpsAt = performance.now();
        // 默认重置后停在「暂停」（可单步）；显式 autostart 才继续运行
        if (payload && payload.autostart === true) engine.start();
        else forcePaused();
        sendConfig();
        sendStatus(true);
        pushFrame(true);
        result = { ok: true, round: engine.round, status: engine.status };
        break;
      }
      case 'setConfig': {
        const prevStatus = engine.status;
        const r = engine.setConfig(payload.patch || {});
        if (r && r.reset) {
          seq = 0;
          lastFrameRound = -1;
          lastRoundForRps = 0;
          lastRpsAt = performance.now();
          sendConfig();
          // 重置型参数变更后保持原来的「暂停」语义，不要自动开跑；
          // 原本在运行的由 engine.setConfig 内部自动恢复运行（保持原行为）。
          if (prevStatus === 'paused' || prevStatus === 'ended') forcePaused();
        }
        sendStatus(true);
        pushFrame(true);
        result = r && r.ok !== false
          ? { ok: true, reset: !!r.reset, status: engine.status, config: engine.cfg }
          : { ok: false, error: (r && r.error) || '应用失败' };
        break;
      }
      case 'preset': {
        const wasRunning = engine.status === 'running';
        const patchObj = presetPatch(String(payload.name || 'standard'));
        engine.reset(createConfig(patchObj));
        // 保持原运行/暂停状态：原本在运行则继续运行；原本暂停则保持暂停（不自动开跑）
        if (wasRunning || (payload && payload.autostart === true)) engine.start();
        else forcePaused();
        seq = 0;
        lastFrameRound = -1;
        lastRoundForRps = 0;
        lastRpsAt = performance.now();
        sendConfig();
        sendStatus(true);
        pushFrame(true);
        result = { ok: true, status: engine.status, config: engine.cfg, round: engine.round };
        break;
      }
      case 'speed': {
        const v = Math.max(0, Number(payload.targetRoundsPerSec) || 0);
        const r = engine.setConfig({ speed: { targetRoundsPerSec: v } });
        result = { ok: true, targetRoundsPerSec: v, reset: !!(r && r.reset) };
        break;
      }
      case 'trigger': {
        const report = engine.triggerMacro(String(payload.macro || 'average'));
        pushFrame(true);
        sendStatus(true);
        result = { ok: true, events: (report && report.events) || [], created: (report && report.created) || 0, destroyed: (report && report.destroyed) || 0 };
        break;
      }
      case 'track': {
        const agent = engine.trackById(Number(payload.id));
        pushFrame(true);
        result = agent ? { ok: true, agent } : { ok: false, error: '个体不存在或已死亡' };
        break;
      }
      case 'untrack': {
        const ok = engine.untrackById(Number(payload.id));
        pushFrame(true);
        result = { ok: ok };
        break;
      }
      case 'snapshot': {
        const { buffer } = engine.snapshot(++seq);
        lastSnapshotAt = performance.now();
        lastFrameRound = engine.round;
        computeRps();
        post({ type: 'frameSingle', id, buffer }, [buffer]);
        return;
      }
      case 'status': {
        result = { ok: true, status: engine.getStatus() };
        break;
      }
      default:
        result = { ok: false, error: '未知操作: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  // 开始/暂停/恢复后立即推一帧，让前端状态徽章立刻同步（暂停后引擎不再推进回合，
  // 若不主动推帧，前端会一直停留在旧帧的 running 状态，看起来像"自己又跑起来了"）。
  if (action === 'start' || action === 'pause' || action === 'resume') pushFrame(true);
  // 每次控制指令后立刻推送最新状态，保证 /api/status 与控制响应同步
  sendStatus(true);
  post({ type: 'controlResult', id, result });
  if (engine.status === 'ended') sendStatus(true);
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'viewers') {
    viewers = msg.count | 0;
    if (viewers > 0) pushFrame(true);
    return;
  }
  if (msg.type === 'control') {
    handleControl(msg);
    return;
  }
  if (msg.type === 'shutdown') {
    stopped = true;
    if (statusInterval) clearInterval(statusInterval);
    try {
      engine.close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  }
});

// 启动
sendConfig();
if (workerData && workerData.autostart !== false) {
  engine.start();
}
sendStatus(true);
statusInterval = setInterval(() => {
  computeRps();
  sendStatus(false);
}, 300);
statusInterval.unref?.();
pump();
