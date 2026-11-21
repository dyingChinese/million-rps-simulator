/**
 * app.js — 入口：连接 /api/stream、下发 /api/control、rAF 合批渲染、状态管理
 *
 * 数据流：
 *   真实模式： fetch('/api/stream') → FrameReader 切帧 → parseFrame（零拷贝视图）
 *   mock 模式： mock.js 合成快照 → encodeFrame → 同一套 parseFrame 路径
 *   → state.latestFrame（只保留最新一帧）→ rAF：stage.setFrame 上传 GPU → stage.render 每帧绘制
 *   → 每 ≥80ms 节流一次 panels.update（DOM + Canvas2D 图表合批）
 *
 * 断线：1s 起指数退避（上限 8s）重连；连接状态显示在底栏，不崩溃。
 */

import { FrameReader, parseFrame, createWealthMapping } from './protocol.js';
import { GlStage } from './glview.js';
import { createPanels } from './panels.js';
import { createMockBackend } from './mock.js';
import { runSelfTest } from './selftest.js';

const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const SELFTEST = params.get('selftest') === '1';
const MOCK_DELAY = Math.max(0, Number(params.get('delay')) || 0);
/** DOM / 图表更新节流下限（UI-SPEC：≥80ms） */
const DOM_INTERVAL_MS = 90;

const state = {
  mode: MOCK ? 'mock' : 'real',
  running: true,
  connected: false,
  meta: null,
  configReady: false,
  latestFrame: null,
  uploadedFrame: null,
  parseMs: 0,
  uploadMs: 0,
  mapping: null,
  frames: 0,
  chunks: 0,
  view: 'galaxy',
  trackedKey: '',
  domUpdates: [],
  bootAt: performance.now(),
  lastFrameAt: 0,
  reconnectAttempt: 0,
  waitingHintShown: false,
  glOk: false,
  error: null,
  /** 控制指令后的乐观状态（暂停/重置后服务端不再推帧，UI 需要立即反映） */
  statusOverride: null,
  streamErrors: 0,
  streamWarnAt: 0,
  streamAlertShown: false,
};

let panels = null;
let stage = null;
/** @type {import('./mock.js').MockBackend|null} */
let mock = null;
let streamAbort = null;
let configTimer = null;
let reconnectTimer = null;
let selftestRan = false;

/* ────────────────────────────── 错误兜底 ────────────────────────────── */

function showCrash(message, stack) {
  try {
    const box = document.getElementById('crash');
    if (!box) return;
    box.textContent = '前端脚本错误（请把此信息反馈给开发者）\n' + message + (stack ? '\n' + stack : '');
    box.classList.remove('hidden');
    console.error('[crash]', message, stack || '');
  } catch (err) {
    /* 兜底里再出错就放弃 */
  }
}

window.addEventListener('error', (e) => showCrash(e.message || String(e.error), e.error && e.error.stack));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  showCrash(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
});

/* ────────────────────────────── 启动 ────────────────────────────── */

boot();

function boot() {
  panels = createPanels({
    control,
    preset: (name) => control('preset', { name }),
    view: setView,
    applyConfig,
    applyReset: applyConfigThenReset,
  });

  const glCanvas = document.getElementById('gl-canvas');
  const overlayCanvas = document.getElementById('overlay-canvas');
  stage = new GlStage(glCanvas, overlayCanvas);
  state.glOk = stage.init();
  stage.onPick = (hit) => trackIndividual(hit.id);
  stage.setView(state.view);
  panels.setView(state.view);

  if (!state.glOk) {
    panels.setAlert('WebGL2 不可用：主舞台已切换为 2D 回退渲染（图表与数据不受影响）');
  }

  window.addEventListener('resize', () => stage.resize());
  if (typeof ResizeObserver !== 'undefined') {
    const wrap = document.getElementById('stage-wrap');
    if (wrap) {
      const ro = new ResizeObserver(() => stage.resize());
      ro.observe(wrap);
    }
  }

  // 键盘快捷键：空格 运行/暂停，1/2 切视图，R 重置
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      const st = state.latestFrame ? state.latestFrame.snap.engine.status : 'idle';
      control(st === 'running' ? 'pause' : 'start');
    } else if (e.key === '1') setView('galaxy');
    else if (e.key === '2') setView('skyline');
    else if (e.key === 'r' || e.key === 'R') control('reset');
  });

  if (MOCK) initMock();
  else initReal();

  startRenderLoop();
}

/* ────────────────────────────── mock 模式 ────────────────────────────── */

function initMock() {
  mock = createMockBackend({
    onFrame: onRawFrame,
    delay: MOCK_DELAY,
    intervalMs: 130,
  });
  applyMeta(mock.getMeta());
  panels.setConnection('connected', 'mock 本地合成数据 · 无需后端');
  if (MOCK_DELAY > 0) {
    panels.setConnection('connecting', 'mock 首帧延迟 ' + MOCK_DELAY + 'ms');
  }
  mock.start();
}

/* ────────────────────────────── 真实模式 ────────────────────────────── */

function initReal() {
  loadConfig();
  connectStream();
}

/** GET /api/config，失败指数退避重试（服务器可能还没起来） */
async function loadConfig() {
  if (configTimer) {
    clearTimeout(configTimer);
    configTimer = null;
  }
  try {
    const resp = await fetch('/api/config', { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const meta = await resp.json();
    if (!meta || !meta.config) throw new Error('返回缺少 config 字段');
    applyMeta(meta);
    panels.setAlert(null);
    return true;
  } catch (err) {
    state.configReady = false;
    if (state.latestFrame === null) {
      panels.setConnection('connecting', '等待模拟服务器 /api/config');
      panels.setAlert('等待模拟服务器启动…（' + (err && err.message ? err.message : err) + '）');
    }
    const delay = Math.min(8000, 1000 * Math.pow(2, Math.min(3, state.reconnectAttempt)));
    state.reconnectAttempt++;
    configTimer = setTimeout(loadConfig, delay);
    return false;
  }
}

/** 连接二进制流；断线后指数退避重连 */
async function connectStream() {
  if (streamAbort) {
    try {
      streamAbort.abort();
    } catch (err) {
      /* 忽略 */
    }
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ac = new AbortController();
  streamAbort = ac;
  if (state.latestFrame === null) {
    panels.setConnection('connecting', '等待 /api/stream 首帧（可能需要 1~2 秒）');
  }
  try {
    const resp = await fetch('/api/stream', {
      signal: ac.signal,
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream' },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (!resp.body) throw new Error('响应没有可读流（浏览器不支持 ReadableStream？）');
    state.connected = true;
    state.reconnectAttempt = 0;
    panels.setConnection('connected', '');
    panels.setAlert(null);
    const reader = resp.body.getReader();
    const frameReader = new FrameReader({
      onError: (reason) => {
        state.streamErrors++;
        const now = performance.now();
        if (now - state.streamWarnAt > 2000) {
          // 限流：坏帧重同步不应刷屏（严重时顶部提示一次）
          console.warn('[stream] 数据流校验失败并已重同步（原因: ' + reason + '，近 2s 累计 ' + state.streamErrors + ' 次）');
          state.streamWarnAt = now;
          if (state.streamErrors > 20 && !state.streamAlertShown) {
            state.streamAlertShown = true;
            panels.setAlert('数据流格式异常，已自动重同步；请检查服务端帧格式是否与 PROTOCOL 一致。');
          }
          state.streamErrors = 0;
        }
      },
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      state.chunks++;
      const frames = frameReader.push(value);
      for (let i = 0; i < frames.length; i++) onRawFrame(frames[i]);
      if (state.latestFrame && !state.waitingHintShown) {
        state.waitingHintShown = true;
        panels.setAlert(null);
      }
    }
    throw new Error('流已关闭');
  } catch (err) {
    if (ac.signal.aborted) return;
    state.connected = false;
    panels.setConnection('disconnected', err && err.message ? err.message : String(err));
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (configTimer) return; // 配置都还没拿到时，loadConfig 自己在重试
  const attempt = state.reconnectAttempt++;
  const delay = Math.min(8000, 1000 * Math.pow(2, Math.min(3, attempt)));
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStream();
    if (!state.configReady) loadConfig();
  }, delay);
}

/* ────────────────────────────── 帧接收 / 解析 ────────────────────────────── */

/**
 * 收到一个完整二进制帧（真实流或 mock 都走这里）。
 * 解析后只保留最新一帧，渲染在 rAF 中统一执行（合批）。
 * @param {Uint8Array} bytes
 */
function onRawFrame(bytes) {
  const t0 = performance.now();
  const frame = parseFrame(bytes);
  state.parseMs = performance.now() - t0;
  if (!frame) return; // magic / 长度校验失败：静默丢弃（不崩）
  state.frames++;
  state.latestFrame = frame;
  state.lastFrameAt = performance.now();
  // 收到合法帧：清掉数据流异常提示
  if (state.streamAlertShown) {
    state.streamAlertShown = false;
    panels.setAlert(null);
  }
  // 乐观状态与服务端真实状态对齐后即失效（最多保持 2s）
  if (state.statusOverride) {
    const age = performance.now() - state.statusOverride.at;
    if (frame.snap.engine.status === state.statusOverride.status || age > 2000) state.statusOverride = null;
  }
  // mock 首帧晚于连接提示时，收到数据即视为已连接
  if (MOCK && !state.connected) {
    state.connected = true;
    panels.setConnection('connected', 'mock 本地合成数据 · 无需后端');
  }
}

/* ────────────────────────────── rAF 渲染循环 ────────────────────────────── */

function startRenderLoop() {
  let lastDomUpdate = 0;
  const loop = (now) => {
    if (!state.running) return;
    requestAnimationFrame(loop);

    const frame = state.latestFrame;
    // ① GPU 上传（只在新帧时；上传/绘制分离，避免重复上传）
    if (frame && frame !== state.uploadedFrame) {
      const t0 = performance.now();
      stage.setFrame(frame, state.mapping);
      state.uploadMs = performance.now() - t0;
      state.uploadedFrame = frame;
      const tracked = (frame.snap.tracked || []).map((t) => t.id);
      const key = tracked.join(',');
      if (key !== state.trackedKey) {
        state.trackedKey = key;
        stage.setTracked(tracked);
      }
    }

    // ② WebGL 每帧绘制（60fps 目标）
    stage.render(now);

    // ③ DOM + 图表：rAF 合批 + ≥80ms 节流
    if (frame && now - lastDomUpdate >= DOM_INTERVAL_MS) {
      lastDomUpdate = now;
      state.domUpdates.push(now);
      if (state.domUpdates.length > 300) state.domUpdates.shift();
      // 控制指令后的乐观状态：服务端暂停/重置后不推帧，UI 先反映
      if (state.statusOverride) {
        frame.snap.engine.status = state.statusOverride.status;
        if (state.statusOverride.endReason !== undefined) frame.snap.engine.endReason = state.statusOverride.endReason;
      }
      const glStats = stage.getStats();
      panels.update(frame, {
        fps: glStats.fps,
        glOk: glStats.glOk,
        glStats,
        mapping: state.mapping,
        parseMs: state.parseMs,
        uploadMs: state.uploadMs,
        mode: state.mode,
        frames: state.frames,
      });
    }

    // ④ 真实模式：长时间没有首帧 → 提示但保持重连
    if (!MOCK && !state.waitingHintShown && now - state.bootAt > 6000) {
      state.waitingHintShown = true;
      if (state.frames === 0) {
        panels.setAlert('仍没有收到数据帧：请确认模拟服务器已启动（npm start）或使用 ?mock=1 预览界面。');
      }
    }

    // ⑤ 自检模式：跑完若干帧后执行页面内断言（无后端时超时也跑，便于定位）
    const selftestTrigger = SELFTEST && !selftestRan &&
      ((state.frames >= 4 && now - state.bootAt > 700) || (!MOCK && now - state.bootAt > 6000));
    if (selftestTrigger) {
      selftestRan = true;
      runSelfTest({ state, stage, panels, mock, setView, control }).catch((err) => showCrash('自检异常: ' + (err && err.message), err && err.stack));
    }
  };
  requestAnimationFrame(loop);
}

/* ────────────────────────────── 视图切换 ────────────────────────────── */

function setView(view) {
  state.view = view === 'skyline' ? 'skyline' : 'galaxy';
  stage.setView(state.view);
  panels.setView(state.view);
}

/* ────────────────────────────── 追踪 ────────────────────────────── */

function trackIndividual(id) {
  if (!Number.isFinite(id) || id < 0) return;
  if (state.trackedKey) {
    const ids = state.trackedKey.split(',').map(Number);
    if (ids.length >= 8 && !ids.includes(id)) {
      panels.setAlert('最多同时追踪 8 个个体，请先取消部分追踪。');
      return;
    }
  }
  stage.setSelected(id);
  control('track', { id }).then((res) => {
    if (res && res.ok === false) {
      stage.setSelected(-1);
      panels.setAlert('追踪失败：' + (res.error || '未知原因'));
    }
  });
}

function untrack(id) {
  stage.setSelected(-1);
  control('untrack', { id });
}

/* ────────────────────────────── 控制指令 ────────────────────────────── */

/**
 * 下发控制指令（mock / 真实模式统一入口）。
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<object>}
 */
async function control(action, payload) {
  // 暂停状态点"运行"用 resume（协议区分 start / resume；mock 两者等价）
  if (action === 'start' && state.latestFrame && state.latestFrame.snap.engine.status === 'paused') {
    action = 'resume';
  }
  const body = Object.assign({ action }, payload || {});
  if (MOCK && mock) {
    const res = mock.control(action, body);
    handleControlResult(action, res);
    return res;
  }
  try {
    const resp = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await resp.json();
    handleControlResult(action, res);
    return res;
  } catch (err) {
    panels.setAlert('控制指令失败：' + (err && err.message ? err.message : err) + '（服务器可能未启动）');
    return { ok: false, error: String(err) };
  }
}

function handleControlResult(action, res) {
  if (!res) return;
  if (res.ok === false) {
    panels.setAlert('指令失败：' + (res.error || '未知错误'));
    return;
  }
  // 悲观推送：优先采用服务端返回的真实状态；服务端没带 status 时才用本地猜测
  // （重置/切预设后引擎可能不再推帧，先把状态徽章切过去）
  const OPTIMISTIC_STATUS = {
    pause: 'paused',
    start: 'running',
    resume: 'running',
    reset: 'paused',
    preset: 'paused',
    step: 'paused',
  };
  const status = typeof res.status === 'string' ? res.status : OPTIMISTIC_STATUS[action];
  if (status) {
    state.statusOverride = { status, at: performance.now() };
  }
  if (action === 'track') {
    state.trackedKey = ''; // 下一帧快照同步
    panels.setAlert(null);
  } else if (action === 'untrack') {
    state.trackedKey = '';
    panels.setAlert(null);
  } else if (action === 'setConfig') {
    if (res.config) applyConfigToMeta(res.config);
  } else if (action === 'preset') {
    if (res.config) applyConfigToMeta(res.config);
    panels.setAlert(null);
  } else if (action === 'reset') {
    state.trackedKey = '';
    stage.setSelected(-1);
    stage.setTracked([]);
  }
}

/** 应用参数（POST setConfig），失败提示、成功以响应 config 回填 */
async function applyConfig(patch) {
  const res = await control('setConfig', { patch });
  if (res && res.ok && res.config) {
    panels.setAlert(res.reset ? '参数已应用：部分参数需要重置，当前对局已重开。' : null);
  }
}

/** 应用参数并重置（左栏"重置并应用"） */
async function applyConfigThenReset(patch) {
  const res = await control('setConfig', { patch });
  if (!res || !res.ok) return;
  await control('reset');
  panels.setAlert(null);
}

function applyMeta(meta) {
  if (!meta || !meta.config) return;
  state.meta = meta;
  state.configReady = true;
  panels.setMeta(meta);
  state.mapping = createWealthMapping(meta.config);
}

function applyConfigToMeta(cfg) {
  if (!cfg) return;
  if (state.meta) state.meta.config = cfg;
  panels.applyConfig(cfg);
  state.mapping = createWealthMapping(cfg);
}

/** 停止所有循环与连接（页面卸载 / 测试收尾用） */
function shutdown() {
  state.running = false;
  if (mock) mock.stop();
  if (streamAbort) {
    try {
      streamAbort.abort();
    } catch (err) {
      /* 忽略 */
    }
  }
  if (configTimer) clearTimeout(configTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
}

/* 调试 / 自检入口（浏览器控制台可用） */
window.__RPS_APP__ = {
  state,
  get panels() {
    return panels;
  },
  get stage() {
    return stage;
  },
  get mock() {
    return mock;
  },
  control,
  setView,
  trackIndividual,
  untrack,
  shutdown,
};
