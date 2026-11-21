/**
 * battle-pool.js — 并行对战线程池
 *
 * 设计：
 *  - 引擎把「匹配池 + 全部对战相关数组」放在 SharedArrayBuffer 里（见 store.js 的 shared 模式）；
 *  - 每回合把 pair 区间切成 N 段，分给 N 个 battle worker 同时结算；
 *  - 每个个体每回合只参与一个 pair，因此各段写入的槽位互不相交，无需加锁；
 *  - 主线程用 Atomics.wait 阻塞等待全部 worker 完成（同步接口，不改变 Engine.tick() 语义）；
 *  - 随机源：每个区间用 (seed, round, workerIndex) 派生的独立种子，同一机器/同一 worker 数下可复现。
 *
 * 失败处理：等待超时/worker 异常时标记 broken，引擎回退单线程模式（当回合已部分结算的直接跳过剩余）。
 */
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('../worker/battle-worker.js', import.meta.url);
const WAIT_TIMEOUT_MS = 30_000;
/** 每个 worker 输出区布局：[wins, draws, deaths, move0, move1, move2] */
const OUT_I32_STRIDE = 6;
/** 每个 worker 输出区布局：[destroyed, poolDelta, betSum, betCount, winStreakSum, lossStreakSum] */
const OUT_F64_STRIDE = 6;

/** 由 (seed, round, worker) 派生确定性子种子 */
function deriveSeed(seed, round, workerIndex) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h + Math.imul(round + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  h = (h ^ Math.imul(workerIndex + 1, 0x165667b1)) >>> 0;
  return h >>> 0;
}

export class BattlePool {
  /** @param {number} workerCount */
  constructor(workerCount) {
    this.count = Math.max(1, workerCount | 0);
    this.broken = false;
    /** @type {Worker[]} */
    this.workers = [];
    this.configured = false;
    this.storeVersion = -1;
    this.configVersion = -1;
    this.done = null;
    this.deathListAll = null;
    this.deathTypesAll = null;
    this.moveUsageAll = null;
    this.outI32All = null;
    this.outF64All = null;
    this.regionSize = 0;
    this.ctxs = [];
    for (let i = 0; i < this.count; i++) {
      const w = new Worker(WORKER_URL);
      w.on('error', (err) => {
        console.error('[battle-pool] worker 异常:', err && err.message ? err.message : err);
        this.broken = true;
      });
      // 不阻止进程退出（引擎关闭时显式 terminate）
      w.unref();
      this.workers.push(w);
    }
  }

  /** @private 按容量分配共享输出缓冲 */
  _ensureBuffers(capacity) {
    const workers = this.count;
    if (this.deathListAll && this.regionSize >= Math.ceil(capacity / workers) + 8) return;
    const regionSize = Math.ceil(capacity / workers) + 8;
    this.regionSize = regionSize;
    this.deathListAll = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * workers * regionSize));
    this.deathTypesAll = new Uint8Array(new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * workers * regionSize));
    this.moveUsageAll = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * workers * 3));
    this.outI32All = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * workers * OUT_I32_STRIDE));
    this.outF64All = new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * workers * OUT_F64_STRIDE));
    this.done = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    this.configured = false;
  }

  /**
   * 把基础上下文分发到各 worker（仅在数组/配置版本变化时执行）。
   * @param {object} baseCtx 引擎构建的对战上下文
   * @param {number} storeVersion 数组版本（扩容时变化）
   * @param {number} configVersion 配置版本（热更新时变化）
   * @param {number} capacity store 容量
   */
  _configure(baseCtx, storeVersion, configVersion, capacity) {
    this._ensureBuffers(capacity);
    const workers = this.count;
    const regionSize = this.regionSize;
    for (let i = 0; i < workers; i++) {
      const ctx = { ...baseCtx };
      ctx.deathList = this.deathListAll.subarray(i * regionSize, (i + 1) * regionSize);
      ctx.deathTypes = this.deathTypesAll.subarray(i * regionSize, (i + 1) * regionSize);
      ctx.moveUsage = this.moveUsageAll.subarray(i * 3, (i + 1) * 3);
      ctx.outI32 = this.outI32All.subarray(i * OUT_I32_STRIDE, (i + 1) * OUT_I32_STRIDE);
      ctx.outF64 = this.outF64All.subarray(i * OUT_F64_STRIDE, (i + 1) * OUT_F64_STRIDE);
      ctx.done = this.done;
      this.ctxs[i] = ctx;
      this.workers[i].postMessage({ type: 'ctx', ctx });
    }
    this.configured = true;
    this.storeVersion = storeVersion;
    this.configVersion = configVersion;
  }

  /**
   * 并行结算一回合的对战。
   * @param {object} baseCtx 引擎构建的对战上下文
   * @param {number} storeVersion
   * @param {number} configVersion
   * @param {number} capacity
   * @param {number} pairCount 对数
   * @param {number} round
   * @param {number} seed 模拟种子
   * @returns {{out: object, deaths: Array<{offset:number,count:number}>, dispatched: number}|null}
   *   超时/异常返回 null（引擎应回退）
   */
  run(baseCtx, storeVersion, configVersion, capacity, pairCount, round, seed) {
    if (this.broken) return null;
    if (!this.configured || storeVersion !== this.storeVersion || configVersion !== this.configVersion) {
      this._configure(baseCtx, storeVersion, configVersion, capacity);
    }
    const workers = this.count;
    const done = this.done;
    Atomics.store(done, 0, 0);
    // 清零输出区
    this.outI32All.fill(0);
    this.outF64All.fill(0);
    const chunk = Math.ceil(pairCount / workers);
    let dispatched = 0;
    for (let i = 0; i < workers; i++) {
      const start = i * chunk;
      const end = Math.min(pairCount, start + chunk);
      if (start >= end) continue;
      const ctx = this.ctxs[i];
      ctx.cost = baseCtx.cost;
      ctx.baseBet = baseCtx.baseBet;
      ctx.learnFactorArr = baseCtx.learnFactorArr;
      this.workers[i].postMessage({
        type: 'run',
        start,
        end,
        seed: deriveSeed(seed, round, i),
        cost: baseCtx.cost,
        baseBet: baseCtx.baseBet,
      });
      dispatched++;
    }
    // 等待全部 worker 完成
    const t0 = Date.now();
    const expected = dispatched;
    let spins = 0;
    while (Atomics.load(done, 0) < expected) {
      const r = Atomics.wait(done, 0, Atomics.load(done, 0), 500);
      if (r === 'timed-out') {
        spins++;
        if (Date.now() - t0 > WAIT_TIMEOUT_MS) {
          console.error(`[battle-pool] 等待 worker 超时（${dispatched - Atomics.load(done, 0)} 个未完成），禁用并行`);
          this.broken = true;
          return null;
        }
      }
    }
    // 汇总输出
    const outI32 = this.outI32All;
    const outF64 = this.outF64All;
    const regionSize = this.regionSize;
    const deaths = [];
    let wins = 0;
    let draws = 0;
    let deathCount = 0;
    let move0 = 0;
    let move1 = 0;
    let move2 = 0;
    let destroyed = 0;
    let poolDelta = 0;
    let betSum = 0;
    let betCount = 0;
    let winStreakSum = 0;
    let lossStreakSum = 0;
    for (let i = 0; i < workers; i++) {
      const oi = i * OUT_I32_STRIDE;
      const of = i * OUT_F64_STRIDE;
      wins += outI32[oi];
      draws += outI32[oi + 1];
      const d = outI32[oi + 2];
      if (d > 0) deaths.push({ offset: i * regionSize, count: d });
      deathCount += d;
      move0 += outI32[oi + 3];
      move1 += outI32[oi + 4];
      move2 += outI32[oi + 5];
      destroyed += outF64[of];
      poolDelta += outF64[of + 1];
      betSum += outF64[of + 2];
      betCount += outF64[of + 3];
      winStreakSum += outF64[of + 4];
      lossStreakSum += outF64[of + 5];
    }
    return {
      out: { destroyed, poolDelta, wins, draws, betSum, betCount, winStreakSum, lossStreakSum, deathCount, move0, move1, move2 },
      deaths,
      dispatched,
    };
  }

  /** 关闭线程池 */
  close() {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* 忽略 */
      }
    }
    this.workers.length = 0;
    this.ctxs.length = 0;
    this.configured = false;
  }
}
