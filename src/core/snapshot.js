/**
 * snapshot.js — 把引擎 + 统计分析结果组装成一帧二进制快照（协议见 docs/PROTOCOL.md）
 *
 * 帧结构（小端）：
 *   [0..4)   u32 magic = 0x52505331 ("RPS1")
 *   [4..8)   u32 frameLength
 *   [8..12)  u32 jsonLen
 *   [12..16) u32 dataStart
 *   [16..dataStart) JSON 头（UTF-8，补 zero padding 到 4 字节对齐）
 *   [dataStart..)   各 section 数据（每段 4 字节对齐；offset 为相对 dataStart 的字节偏移）
 */
import { performance } from 'node:perf_hooks';

const MAGIC = 0x52505331;
const HEADER_SIZE = 16;

const textEncoder = new TextEncoder();

/**
 * 构建快照帧。
 * @param {import('./engine.js').Engine} engine
 * @param {number} seq 帧序号
 * @returns {{buffer: ArrayBuffer, json: object}}
 */
export function buildFrame(engine, seq) {
  const t0 = performance.now();
  const cfg = engine.cfg;
  const store = engine.store;
  const summary = engine.summary;
  const status = engine.getStatus();

  // ── 1. 统计分析（全量扫描在这里发生）──
  const a0 = performance.now();
  const analyticsResult = engine.analytics.snapshot(store, summary);
  const analyticsMs = performance.now() - a0;
  // 供 worker 自适应快照间隔使用
  if (summary.perf) summary.perf.analyticsMs = analyticsMs;
  const json = analyticsResult.json || {};
  const sections = analyticsResult.sections || [];

  // ── 2. 引擎侧字段 ──
  const totalEver = cfg.initialPopulation + engine.births;
  const familyStats = cfg.families.enabled ? engine.familyStats() : null;

  json.seq = seq;
  json.round = engine.round;
  json.wallTime = Date.now();
  json.simVersion = 1;
  json.engine = {
    status: engine.status,
    endReason: engine.endReason,
    tickMs: r2(engine.tickMs),
    roundsPerSec: r2(engine.roundsPerSec || 0),
    uptimeMs: Math.round(performance.now()),
    speedTarget: cfg.speed.targetRoundsPerSec,
    parallelWorkers: engine.parallelWorkers || 0,
    shared: !!(store && store.shared),
  };
  json.population = {
    alive: store.aliveCount,
    initial: cfg.initialPopulation,
    capacity: store.capacity,
    births: engine.births,
    deaths: engine.deaths,
    bankruptcies: engine.bankruptcies,
    frozen: engine.frozenCount,
    birthRate: totalEver > 0 ? engine.births / totalEver : 0,
    deathRate: totalEver > 0 ? engine.deaths / totalEver : 0,
    bankruptRate: totalEver > 0 ? engine.bankruptcies / totalEver : 0,
    families: familyStats ? familyStats.familyCount : 1,
  };
  json.inflation = {
    factor: r4(engine.inflationFactor),
    cost: r2(engine.cost),
    baseCost: cfg.roundCost,
  };
  json.resource = {
    enabled: !!cfg.resourceLimited.enabled,
    pool: round2(engine.pool.amount),
    created: round2(engine.created),
    destroyed: round2(engine.destroyed),
  };
  json.plague = summary.plague;
  json.events = engine.eventLog;
  json.endCondition = engine.endInfo;
  json.families = familyStats
    ? {
        topWealth: familyStats.topWealth,
        topSize: familyStats.topSize,
        topGeneration: familyStats.topGeneration,
        familyCount: familyStats.familyCount,
        totalMembers: familyStats.totalMembers,
      }
    : { topWealth: [], topSize: [], topGeneration: [], familyCount: 0, totalMembers: 0 };
  json.guilds = cfg.guilds && cfg.guilds.enabled ? engine.guildStats() : {
    enabled: false,
    total: 0,
    wars: 0,
    treasuryTotal: 0,
    avgLevel: 0,
    topWealth: [],
    topMembers: [],
    topWars: [],
  };
  json.tracked = cfg ? engine.tracker.snapshot(store, engine.familySys) : [];
  json.grids = {
    strategy: {
      w: cfg.performance.gridStrategy.w,
      h: cfg.performance.gridStrategy.h,
    },
    sampleCount: getSectionLength(sections, 'pts') / 7,
  };

  // ── 3. 计算 sections 布局（offset 为字节偏移）──
  let dataSize = 0;
  const sectionTable = [];
  for (const sec of sections) {
    const byteLength = sec.data.byteLength;
    const aligned = (dataSize + 3) & ~3;
    sectionTable.push({
      name: sec.name,
      type: sec.type,
      offset: aligned,
      length: sec.data.length,
      byteLength,
    });
    dataSize = aligned + byteLength;
  }
  json.sections = sectionTable;

  const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1048576);
  json.perf = {
    analyticsMs: r2(analyticsMs),
    frameBytes: 0,
    sampleCount: json.grids.sampleCount,
    heapUsedMB,
    buildMs: r2(performance.now() - t0),
  };

  // ── 4. 序列化（frameBytes 自引用：迭代到稳定；之后不再修改 json，保证 jsonLen 一致）──
  let jsonBytes = null;
  let dataStart = 0;
  let frameLength = 0;
  for (let iter = 0; iter < 8; iter++) {
    const raw = textEncoder.encode(JSON.stringify(json));
    const pad = (4 - (raw.length & 3)) & 3;
    const nextDataStart = HEADER_SIZE + raw.length + pad;
    const nextFrameLength = nextDataStart + dataSize;
    jsonBytes = raw;
    dataStart = nextDataStart;
    frameLength = nextFrameLength;
    if (json.perf.frameBytes === nextFrameLength) break; // 数值稳定（字节长度不变）则结束
    json.perf.frameBytes = nextFrameLength;
  }

  // ── 5. 组装 ArrayBuffer ──
  const buffer = new ArrayBuffer(frameLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, frameLength, true);
  view.setUint32(8, jsonBytes.length, true);
  view.setUint32(12, dataStart, true);
  const bytes = new Uint8Array(buffer);
  bytes.set(jsonBytes, HEADER_SIZE);
  for (let i = 0; i < sectionTable.length; i++) {
    const sec = sections[i];
    const meta = sectionTable[i];
    const src = new Uint8Array(sec.data.buffer, sec.data.byteOffset, sec.data.byteLength);
    bytes.set(src, dataStart + meta.offset);
  }

  return { buffer, json };
}

function getSectionLength(sections, name) {
  const sec = sections.find((s) => s.name === name);
  return sec ? sec.data.length : 0;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;

export { MAGIC, HEADER_SIZE };
