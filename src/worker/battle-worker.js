/**
 * battle-worker.js — 并行对战 worker 线程
 *
 * 主线程（BattlePool）把对战上下文（SAB 支撑的数组视图）分发到本线程，
 * 之后每回合发送 pair 区间；本线程用独立随机源结算该区间并把结果写入共享输出区，
 * 最后用 Atomics 通知主线程。
 */
import { parentPort } from 'node:worker_threads';
import { Rng } from '../core/rng.js';
import { processBattleRange, resetOut, createOut } from '../core/battle.js';

let ctx = null;
const out = createOut();

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ctx') {
    ctx = msg.ctx;
    return;
  }
  if (msg.type !== 'run') return;
  if (!ctx) {
    // 没有上下文也要让主线程的等待结束，避免死锁
    parentPort.postMessage({ type: 'error', message: 'battle-worker 未收到 ctx' });
    return;
  }
  ctx.cost = msg.cost;
  ctx.baseBet = msg.baseBet;
  try {
    const rng = new Rng(msg.seed);
    resetOut(out);
    processBattleRange(ctx, out, msg.start, msg.end, rng);
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: '对战区间结算异常: ' + (err && err.stack ? err.stack : err) });
  }
  // 写回共享输出区
  const oi = ctx.outI32;
  const of = ctx.outF64;
  oi[0] = out.wins;
  oi[1] = out.draws;
  oi[2] = out.deathCount;
  oi[3] = ctx.moveUsage[0];
  oi[4] = ctx.moveUsage[1];
  oi[5] = ctx.moveUsage[2];
  of[0] = out.destroyed;
  of[1] = out.poolDelta;
  of[2] = out.betSum;
  of[3] = out.betCount;
  of[4] = out.winStreakSum;
  of[5] = out.lossStreakSum;
  Atomics.add(ctx.done, 0, 1);
  Atomics.notify(ctx.done, 0);
});
