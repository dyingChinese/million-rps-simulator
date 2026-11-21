/**
 * protocol.js — 二进制帧协议（PROTOCOL §2 ~ §5）
 *
 * 帧结构（全部小端 little-endian）：
 *   偏移 0   u32 magic = 0x52505331（"RPS1"）
 *   偏移 4   u32 frameLength   整帧字节数（含 header）
 *   偏移 8   u32 jsonLen       JSON 头字节数
 *   偏移 12  u32 dataStart     sections 起始偏移 = 16 + align4(jsonLen)
 *   偏移 16  jsonLen 字节 UTF-8 JSON（含 sections 描述表）
 *   dataStart 起：各 section 依次紧密排列（4 字节对齐）
 *
 * sections 表元素 {name, type:'f32'|'i32', offset, length}：
 *   - offset 相对 dataStart 的**字节**偏移（Lead 已确认；同时兼容按元素偏移的旧示例）
 *   - length 是元素个数
 * 建立 TypedArray 视图时不复制元素（零拷贝），只做边界 / 对齐校验。
 */

export const MAGIC = 0x52505331; // "RPS1"
export const HEADER_BYTES = 16;
export const PTS_STRIDE = 7; // [laneX, wealthY, classId, talentId, streakNorm, stratX, stratY]
export const HIST_BINS = 128;

/** 阶层 / 天赋 / 出拳调色板（PROTOCOL §6，与 config.js 一致） */
export const CLASS_NAMES = ['底层', '中层', '上层', '顶层'];
export const CLASS_COLORS = ['#5b6b8c', '#3fa7d6', '#f5b942', '#ff5d73'];
export const TALENT_NAMES = ['无', '幸运儿', '节俭者', '生育达人', '学习天才', '负债抗性'];
export const TALENT_COLORS = ['#7f8c9b', '#f7d343', '#42d392', '#ff9f43', '#5b8cff', '#c56cf0'];
export const MOVE_NAMES = ['石头', '剪刀', '布'];
export const MOVE_COLORS = ['#5b8cff', '#42d392', '#f5b942'];
export const CLASS_RGB = CLASS_COLORS.map(hexToRgb);
export const MOVE_RGB = MOVE_COLORS.map(hexToRgb);

/** '#5b6b8c' → [0.357, 0.42, 0.55] */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();
const EMPTY = Object.freeze([]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (isNum(v) ? v : d);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const arr = (v) => (Array.isArray(v) ? v : EMPTY);
const clamp01 = (v) => (!isNum(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 流式帧切分器：解决 chunk 边界、粘包、magic 校验与坏帧重同步。
 * push() 返回本轮读到的完整帧（Uint8Array；常见情况下是入参 chunk 的零拷贝子视图）。
 *
 * 性能要点：内部用「队列 + 头指针」而不是 Array.shift()，
 * 大帧跨上百个 chunk 时仍为 O(chunks)，不会退化成 O(n²)。
 */
export class FrameReader {
  /**
   * @param {{maxFrameBytes?:number, onError?:(reason:string)=>void}} [opts]
   */
  constructor(opts = {}) {
    this.maxFrameBytes = opts.maxFrameBytes || 32 * 1024 * 1024;
    this.onError = opts.onError || null;
    /** @type {Uint8Array[]} 未消费的 chunk 队列（消费后惰性压缩） */
    this.queue = [];
    this.head = 0; // 队首 chunk 下标
    this.headOff = 0; // 队首 chunk 内已消费字节数
    this.pending = 0; // 未消费字节数
    this.frameCount = 0;
    this.corruptCount = 0;
  }

  /** 追加一块流数据，返回其中包含的完整帧列表 */
  push(chunk) {
    if (!chunk || chunk.length === 0) return EMPTY;
    this.queue.push(chunk);
    this.pending += chunk.length;
    /** @type {Uint8Array[]} */
    const frames = [];
    let resyncBytes = 0; // 单次 push 内因重同步丢弃的上限（防病态数据卡死主线程）
    for (;;) {
      const head = this._peek(HEADER_BYTES);
      if (!head || head.length < HEADER_BYTES) break;
      const dv = new DataView(head.buffer, head.byteOffset, HEADER_BYTES);
      const magic = dv.getUint32(0, true);
      const frameLength = dv.getUint32(4, true);
      if (magic !== MAGIC) {
        // 批量向后找到下一个 magic（而不是逐字节回调 onError）
        const dropped = this._dropUntilMagic();
        resyncBytes += dropped;
        this.corruptCount++;
        if (this.onError) this.onError('bad-magic');
        if (resyncBytes > 64 * 1024 * 1024) break;
        if (dropped === 0 && this.pending < HEADER_BYTES) break;
        continue;
      }
      if (frameLength < HEADER_BYTES || frameLength > this.maxFrameBytes) {
        this.corruptCount++;
        if (this.onError) this.onError('bad-length');
        this._drop(4); // 跳过可疑 magic，继续向后重同步
        resyncBytes += 4;
        if (resyncBytes > 64 * 1024 * 1024) break;
        continue;
      }
      if (this.pending < frameLength) break; // 等下一块
      const bytes = this._take(frameLength);
      if (bytes) {
        frames.push(bytes);
        this.frameCount++;
      }
    }
    return frames;
  }

  reset() {
    this.queue.length = 0;
    this.head = 0;
    this.headOff = 0;
    this.pending = 0;
  }

  /** 跳过已消费完的 chunk；队列很长时压缩数组，保持 O(1) 摊销 */
  _normalize() {
    while (this.head < this.queue.length && this.headOff >= this.queue[this.head].length) {
      this.head++;
      this.headOff = 0;
    }
    if (this.head > 256) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * 批量向后重同步到下一个 magic 起点（找不到则丢弃到队尾）。
   * @returns {number} 丢弃的字节数
   */
  _dropUntilMagic() {
    const b0 = MAGIC & 0xff;
    let dropped = 0;
    for (let iter = 0; iter < 20000; iter++) {
      this._normalize();
      if (this.pending < HEADER_BYTES) return dropped;
      const first = this.queue[this.head];
      const start = this.headOff;
      const idx = first.indexOf(b0, start);
      if (idx < 0) {
        // 本块不含 magic 首字节：保留末尾 3 字节（magic 可能跨块），其余整块丢弃
        const keep = Math.min(3, first.length);
        const dropTo = first.length - keep;
        if (dropTo <= start) return dropped;
        const n = dropTo - start;
        this._drop(n);
        dropped += n;
        continue;
      }
      if (idx > start) {
        this._drop(idx - start);
        dropped += idx - start;
      }
      const head = this._peek(4);
      if (!head || head.length < 4) return dropped;
      const dv = new DataView(head.buffer, head.byteOffset, 4);
      if (dv.getUint32(0, true) === MAGIC) return dropped;
      this._drop(1);
      dropped++;
    }
    return dropped;
  }

  /** 读取队首 n 字节（n 通常为 16；跨 chunk 时复制到临时数组，仅 header 场景） */
  _peek(n) {
    this._normalize();
    if (this.pending === 0 || this.head >= this.queue.length) return null;
    const first = this.queue[this.head];
    const avail = first.length - this.headOff;
    if (avail >= n) return first.subarray(this.headOff, this.headOff + n);
    const need = Math.min(n, this.pending);
    const out = new Uint8Array(need);
    let got = 0;
    let qi = this.head;
    let off = this.headOff;
    while (got < need && qi < this.queue.length) {
      const c = this.queue[qi];
      const take = Math.min(c.length - off, need - got);
      out.set(c.subarray(off, off + take), got);
      got += take;
      off = 0;
      qi++;
    }
    return got === need ? out : out.subarray(0, got);
  }

  /** 取走完整 frameLength 字节：队首够长时零拷贝，否则拼接一次 */
  _take(frameLength) {
    if (this.pending < frameLength) return null;
    this._normalize();
    const first = this.queue[this.head];
    const avail = first.length - this.headOff;
    if (avail >= frameLength) {
      const slice = first.subarray(this.headOff, this.headOff + frameLength);
      this.headOff += frameLength;
      this.pending -= frameLength;
      this._normalize();
      return slice;
    }
    const out = new Uint8Array(frameLength);
    let got = 0;
    let qi = this.head;
    let off = this.headOff;
    while (got < frameLength && qi < this.queue.length) {
      const cur = this.queue[qi];
      const take = Math.min(cur.length - off, frameLength - got);
      out.set(cur.subarray(off, off + take), got);
      got += take;
      off += take;
      if (off >= cur.length) {
        qi++;
        off = 0;
      }
    }
    this.head = qi;
    this.headOff = off;
    this.pending -= frameLength;
    this._normalize();
    return out;
  }

  _drop(n) {
    let remain = Math.min(n, this.pending);
    this._normalize();
    while (remain > 0 && this.head < this.queue.length) {
      const cur = this.queue[this.head];
      const availCur = cur.length - this.headOff;
      const take = Math.min(availCur, remain);
      this.headOff += take;
      remain -= take;
      if (this.headOff >= cur.length) {
        this.head++;
        this.headOff = 0;
      }
    }
    this.pending -= Math.min(n, this.pending);
    this._normalize();
  }
}

/**
 * 解析单个完整帧（bytes.length 应等于 frameLength）。
 * @param {Uint8Array} bytes
 * @returns {object|null} 解析失败返回 null（不抛异常，UI 不崩）
 */
export function parseFrame(bytes) {
  try {
    if (!bytes || bytes.length < HEADER_BYTES) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const frameLength = dv.getUint32(4, true);
    const jsonLen = dv.getUint32(8, true);
    const dataStart = dv.getUint32(12, true);
    if (frameLength < HEADER_BYTES || frameLength > bytes.byteLength) return null;
    if (jsonLen < 2 || jsonLen > frameLength - HEADER_BYTES) return null;
    if (dataStart < HEADER_BYTES + jsonLen || dataStart > frameLength) return null;

    let json;
    try {
      json = JSON.parse(TEXT_DECODER.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonLen)));
    } catch (err) {
      return null;
    }
    if (!json || typeof json !== 'object') return null;

    const sections = resolveSections(bytes, dataStart, frameLength, json.sections);
    const pts = sections.pts || null;
    const sampleCount = pts ? Math.floor(pts.length / PTS_STRIDE) : 0;
    const grid = sections.strategyGrid || null;
    const gridCount = grid ? grid.length : 0;
    const dims = guessGridDims(json, gridCount);

    return {
      bytes,
      byteLength: bytes.length,
      seq: num(json.seq, 0),
      round: num(json.round, 0),
      wallTime: num(json.wallTime, 0),
      simVersion: num(json.simVersion, 1),
      json,
      sections,
      meta: {
        sampleCount,
        ptsStride: PTS_STRIDE,
        gridW: dims[0],
        gridH: dims[1],
        gridCount: dims[0] * dims[1],
        histBins: sections.hist ? sections.hist.length : 0,
      },
      snap: normalizeSnapshot(json),
    };
  } catch (err) {
    return null;
  }
}

/**
 * 把 sections 描述表解析成 TypedArray 视图（零拷贝）。
 * 兼容两种 offset 语义：字节偏移（协议权威）与元素偏移（历史文档示例）。
 */
export function resolveSections(bytes, dataStart, frameLength, table) {
  const views = Object.create(null);
  if (!Array.isArray(table) || table.length === 0) return views;
  let cursor = dataStart;
  for (let i = 0; i < table.length; i++) {
    const sec = table[i];
    if (!sec || typeof sec.name !== 'string') continue;
    const Ctor = sec.type === 'i32' ? Int32Array : sec.type === 'u32' ? Uint32Array : sec.type === 'f32' ? Float32Array : null;
    if (!Ctor) continue; // 未知类型：跳过，容忍
    const len = Math.max(0, Math.floor(num(sec.length, 0)));
    if (len === 0) {
      views[sec.name] = new Ctor(0);
      continue;
    }
    const bytesLen = len * 4;
    const declared = Math.max(0, Math.floor(num(sec.offset, 0)));
    // 候选字节偏移：字节语义优先，其次元素语义；取「紧接上一段、间隔最小」的合法者
    const candidates = [declared, declared * 4];
    let byteOff = -1;
    let bestGap = Infinity;
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c];
      if (cand % 4 !== 0) continue;
      if (cand < cursor) continue;
      if (cand + bytesLen > frameLength) continue;
      const gap = cand - cursor;
      if (gap > 256) continue; // 允许少量对齐填充，不允许大跳跃
      if (gap < bestGap) {
        bestGap = gap;
        byteOff = cand;
      }
    }
    if (byteOff < 0) {
      // 回退：按 sections 顺序紧密排列（容忍服务端 offset 写错）
      byteOff = cursor + ((4 - (cursor % 4)) % 4);
      if (byteOff + bytesLen > frameLength) break;
    }
    try {
      views[sec.name] = new Ctor(bytes.buffer, bytes.byteOffset + byteOff, len);
    } catch (err) {
      break; // 越界/未对齐：停止解析后续段
    }
    cursor = byteOff + bytesLen;
  }
  return views;
}

/** 由 JSON 推断策略网格尺寸（用于纹理） */
function guessGridDims(json, count) {
  const g = json && json.grids && json.grids.strategy;
  if (g && isNum(g.w) && isNum(g.h) && g.w > 0 && g.h > 0) return [Math.floor(g.w), Math.floor(g.h)];
  const pg = json && json.performance && json.performance.gridStrategy;
  if (pg && isNum(pg.w) && isNum(pg.h) && pg.w > 0 && pg.h > 0) return [Math.floor(pg.w), Math.floor(pg.h)];
  if (count > 0) {
    const w = 192;
    if (count % w === 0) return [w, count / w];
    const s = Math.max(1, Math.round(Math.sqrt(count)));
    return [s, Math.ceil(count / s)];
  }
  return [0, 0];
}

/**
 * 把 Snapshot JSON 补齐默认值，UI 侧无需到处写 `x?.y ?? 0`。
 * 只做浅层包装，不复制大数组（避免每帧分配）。
 * @param {object} raw
 */
export function normalizeSnapshot(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const engine = j.engine || {};
  const pop = j.population || {};
  const wealth = j.wealth || {};
  const strategy = j.strategy || {};
  const series = j.series || {};
  const families = j.families || {};
  const infl = j.inflation || {};
  const resource = j.resource || {};
  const plague = j.plague || {};
  const end = j.endCondition || {};
  const perf = j.perf || {};
  const grids = j.grids || {};

  const classes = [];
  const rawClasses = Array.isArray(j.classes) ? j.classes : EMPTY;
  for (let i = 0; i < 4; i++) {
    const c = rawClasses[i] || {};
    classes.push({
      id: num(c.id, i),
      name: str(c.name, CLASS_NAMES[i]),
      count: num(c.count, 0),
      share: num(c.share, 0),
      wealthShare: num(c.wealthShare, 0),
      flowIn: num(c.flowIn, 0),
      flowOut: num(c.flowOut, 0),
    });
  }

  const talents = [];
  for (let i = 0; i < 6; i++) talents.push(num((j.talents || EMPTY)[i], 0));

  // ── 阶层流动（第 2 轮新增；旧服务端/缺字段时全部 0）──
  const classFlowRaw = j.classFlow || {};
  const classFlow = {
    up: num(classFlowRaw.up, 0),
    down: num(classFlowRaw.down, 0),
    stay: num(classFlowRaw.stay, 0),
    total: num(classFlowRaw.total, 0),
    mobility: clamp01(num(classFlowRaw.mobility, 0)),
  };

  // ── 公会（第 2 轮新增；enabled=false 或字段缺失时榜单为空，不报错）──
  const guildsRaw = j.guilds || {};
  const guildRows = (list) =>
    (Array.isArray(list) ? list : EMPTY).map((g) => ({
      id: num(g.id, -1),
      name: str(g.name, '?'),
      level: num(g.level, 0),
      members: num(g.members, 0),
      treasury: num(g.treasury, 0),
      memberAssets: num(g.memberAssets, 0),
      totalWealth: num(g.totalWealth, num(g.memberAssets, 0) + num(g.treasury, 0)),
      wins: num(g.wins, 0),
    }));
  const guilds = {
    enabled: !!guildsRaw.enabled,
    total: num(guildsRaw.total, 0),
    wars: num(guildsRaw.wars, 0),
    treasuryTotal: num(guildsRaw.treasuryTotal, 0),
    avgLevel: num(guildsRaw.avgLevel, 0),
    topWealth: guildRows(guildsRaw.topWealth),
    topMembers: guildRows(guildsRaw.topMembers),
    topWars: guildRows(guildsRaw.topWars),
  };

  const familiesTop = (list) =>
    (Array.isArray(list) ? list : EMPTY).map((f) => ({
      id: num(f.id, -1),
      name: str(f.name, '?'),
      wealth: num(f.wealth, 0),
      members: num(f.members, 0),
      avgWealth: num(f.avgWealth, 0),
      generation: num(f.generation, 0),
    }));

  const tracked = (Array.isArray(j.tracked) ? j.tracked : EMPTY).map((t) => ({
    id: num(t.id, -1),
    name: str(t.name, '#' + num(t.id, -1)),
    asset: num(t.asset, 0),
    age: num(t.age, 0),
    alive: t.alive !== false,
    classId: num(t.classId, 0),
    talentId: num(t.talentId, 0),
    talentName: str(t.talentName, TALENT_NAMES[num(t.talentId, 0)] || '无'),
    strategy: [num((t.strategy || EMPTY)[0], 1 / 3), num((t.strategy || EMPTY)[1], 1 / 3), num((t.strategy || EMPTY)[2], 1 / 3)],
    wins: num(t.wins, 0),
    losses: num(t.losses, 0),
    draws: num(t.draws, 0),
    reproCount: num(t.reproCount, 0),
    generation: num(t.generation, 0),
    family: t.family ? { id: num(t.family.id, -1), name: str(t.family.name, '') } : null,
    parents: arr(t.parents).slice(0, 4).map((x) => num(x, 0)),
    history: Array.isArray(t.history) ? t.history : EMPTY,
  }));

  const events = (Array.isArray(j.events) ? j.events : EMPTY).map((e) => ({
    round: num(e.round, 0),
    type: str(e.type, 'event'),
    title: str(e.title, '事件'),
    detail: str(e.detail, ''),
    delta: num(e.delta, 0),
  }));

  return {
    raw: j,
    seq: num(j.seq, 0),
    round: num(j.round, 0),
    wallTime: num(j.wallTime, 0),
    simVersion: num(j.simVersion, 1),
    engine: {
      status: ['idle', 'running', 'paused', 'ended'].includes(engine.status) ? engine.status : 'idle',
      endReason: typeof engine.endReason === 'string' ? engine.endReason : null,
      tickMs: num(engine.tickMs, 0),
      roundsPerSec: num(engine.roundsPerSec, 0),
      uptimeMs: num(engine.uptimeMs, 0),
      speedTarget: num(engine.speedTarget, 0),
      parallelWorkers: num(engine.parallelWorkers, 0),
      shared: !!engine.shared,
    },
    population: {
      alive: num(pop.alive, 0),
      initial: num(pop.initial, 0),
      capacity: num(pop.capacity, 0),
      births: num(pop.births, 0),
      deaths: num(pop.deaths, 0),
      bankruptcies: num(pop.bankruptcies, 0),
      frozen: num(pop.frozen, 0),
      birthRate: num(pop.birthRate, 0),
      deathRate: num(pop.deathRate, 0),
      bankruptRate: num(pop.bankruptRate, 0),
      families: num(pop.families, 0),
    },
    wealth: {
      total: num(wealth.total, 0),
      mean: num(wealth.mean, 0),
      median: num(wealth.median, 0),
      p90: num(wealth.p90, 0),
      max: num(wealth.max, 0),
      min: num(wealth.min, 0),
      gini: num(wealth.gini, 0),
      lorenz: arr(wealth.lorenz),
      classWealthShare: arr(wealth.classWealthShare).length ? arr(wealth.classWealthShare) : [0, 0, 0, 0],
      negativeShare: num(wealth.negativeShare, 0),
    },
    strategy: {
      usage: nums3(strategy.usage),
      preference: nums3(strategy.preference),
      dominant: nums3(strategy.dominant),
      entropy: num(strategy.entropy, 0),
    },
    classes,
    talents,
    series: {
      round: arr(series.round),
      alive: arr(series.alive),
      births: arr(series.births),
      deaths: arr(series.deaths),
      bankruptcies: arr(series.bankruptcies),
      totalWealth: arr(series.totalWealth),
      meanWealth: arr(series.meanWealth),
      gini: arr(series.gini),
      rock: arr(series.rock),
      scissors: arr(series.scissors),
      paper: arr(series.paper),
      class0: arr(series.class0),
      class1: arr(series.class1),
      class2: arr(series.class2),
      class3: arr(series.class3),
    },
    families: {
      topWealth: familiesTop(families.topWealth),
      topSize: familiesTop(families.topSize),
      topGeneration: familiesTop(families.topGeneration),
      familyCount: num(families.familyCount, 0),
      totalMembers: num(families.totalMembers, 0),
    },
    classFlow,
    guilds,
    events,
    inflation: {
      factor: num(infl.factor, 1),
      cost: num(infl.cost, 0),
      baseCost: num(infl.baseCost, 0),
    },
    resource: {
      enabled: !!resource.enabled,
      pool: num(resource.pool, 0),
      created: num(resource.created, 0),
      destroyed: num(resource.destroyed, 0),
    },
    plague: {
      enabled: !!plague.enabled,
      active: !!plague.active,
      infected: num(plague.infected, 0),
      infectedShare: num(plague.infectedShare, 0),
      antibodies: num(plague.antibodies, 0),
    },
    tracked,
    endCondition: {
      mode: str(end.mode, 'C'),
      label: str(end.label, ''),
      progress: isNum(end.progress) ? Math.max(0, Math.min(1, end.progress)) : 0,
      ended: !!end.ended,
    },
    perf: {
      analyticsMs: num(perf.analyticsMs, 0),
      frameBytes: num(perf.frameBytes, 0),
      sampleCount: num(perf.sampleCount, 0),
      heapUsedMB: num(perf.heapUsedMB, 0),
      aliveScanMs: num(perf.aliveScanMs, 0),
    },
    grids: {
      strategy: {
        w: num(grids.strategy && grids.strategy.w, 0),
        h: num(grids.strategy && grids.strategy.h, 0),
      },
      wealth: {
        w: num(grids.wealth && grids.wealth.w, 0),
        h: num(grids.wealth && grids.wealth.h, 0),
      },
      sampleCount: num(grids.sampleCount, 0),
    },
  };
}

function nums3(v) {
  const out = [0, 0, 0];
  if (Array.isArray(v)) for (let i = 0; i < 3; i++) out[i] = num(v[i], 0);
  return out;
}

/**
 * 编码一个完整帧（mock / 单帧测试用）。与 parseFrame 严格对称。
 * sections 描述表的 offset 使用**字节偏移**（dataStart 起），length 为元素个数。
 * @param {object} json 快照 JSON（会被写入 sections 描述表）
 * @param {{name:string,type?:'f32'|'i32'|'u32',data:TypedArray}[]} sections
 * @returns {Uint8Array}
 */
export function encodeFrame(json, sections) {
  const list = [];
  let offsetBytes = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const data = s.data;
    const type = s.type || (data instanceof Int32Array ? 'i32' : data instanceof Uint32Array ? 'u32' : 'f32');
    list.push({ name: s.name, type, offset: offsetBytes, length: data.length });
    offsetBytes += data.length * 4;
  }
  json.sections = list;
  const jsonBytes = TEXT_ENCODER.encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length;
  const dataStart = HEADER_BYTES + ((jsonLen + 3) & ~3);
  const frameLength = dataStart + offsetBytes;
  const out = new Uint8Array(frameLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, frameLength, true);
  dv.setUint32(8, jsonLen, true);
  dv.setUint32(12, dataStart, true);
  out.set(jsonBytes, HEADER_BYTES);
  let cursor = dataStart;
  for (let i = 0; i < sections.length; i++) {
    const typed = sections[i].data;
    out.set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), cursor);
    cursor += typed.byteLength;
  }
  return out;
}

/* ────────────────────────── 财富轴映射（PROTOCOL §5） ────────────────────────── */

/** f(a) = sign(a) * log10(1 + |a|) */
export function wealthF(a) {
  const s = a < 0 ? -1 : 1;
  return s * Math.log10(1 + Math.abs(a));
}

/**
 * 根据配置生成财富轴映射器（与 analytics 的直方图/wealthY 完全一致）。
 * @param {object} cfg 完整配置
 */
export function createWealthMapping(cfg) {
  const c = cfg || {};
  const maxDebt = isNum(c.maxDebt) ? c.maxDebt : 500;
  const initialWealth = isNum(c.initialWealth) && c.initialWealth > 0 ? c.initialWealth : 1000;
  const fLo = wealthF(-maxDebt * 1.5);
  const fHi = wealthF(initialWealth * 1000);
  const span = fHi - fLo || 1;
  return {
    fLo,
    fHi,
    span,
    /** 资产 → wealthY ∈ [0,1]（0 = 最穷/负债，1 = 极富） */
    toY(asset) {
      const y = (wealthF(asset) - fLo) / span;
      return y < 0 ? 0 : y > 1 ? 1 : y;
    },
    /** wealthY → 资产（洛伦兹/直方图轴标签用） */
    fromY(y) {
      const f = fLo + y * span;
      const sign = f < 0 ? -1 : 1;
      return sign * (Math.pow(10, Math.abs(f)) - 1);
    },
    /** 资产 → 直方图箱号 */
    binOf(asset, bins) {
      let i = Math.floor(((wealthF(asset) - fLo) / span) * bins);
      if (i < 0) i = 0;
      else if (i >= bins) i = bins - 1;
      return i;
    },
    /** 箱号 → 箱中心资产（对数轴上的几何中点附近，用于标注） */
    binCenterAsset(i, bins) {
      const f = fLo + ((i + 0.5) / bins) * span;
      const sign = f < 0 ? -1 : 1;
      return sign * (Math.pow(10, Math.abs(f)) - 1);
    },
  };
}
