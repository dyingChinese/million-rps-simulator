/**
 * test/rng.test.js — 随机数发生器质量与确定性测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hashLane } from '../src/core/rng.js';

test('同 seed 序列完全一致，不同 seed 不同', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const c = new Rng(43);
  const seqA = Array.from({ length: 20 }, () => a.nextU32());
  const seqB = Array.from({ length: 20 }, () => b.nextU32());
  const seqC = Array.from({ length: 20 }, () => c.nextU32());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('float 在 [0,1)，int(n) 在 [0,n) 且大范围无越界', () => {
  const rng = new Rng('hello');
  for (let i = 0; i < 20000; i++) {
    const f = rng.float();
    assert.ok(f >= 0 && f < 1, 'float 越界: ' + f);
  }
  for (const n of [1, 2, 3, 6, 1000, 1_000_003, 5_000_000]) {
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(n);
      assert.ok(Number.isInteger(v) && v >= 0 && v < n, `int(${n}) 越界: ${v}`);
    }
  }
});

test('int(6) 分布近似均匀（卡方检验宽松阈值）', () => {
  const rng = new Rng(2024);
  const n = 6;
  const samples = 60000;
  const counts = new Array(n).fill(0);
  for (let i = 0; i < samples; i++) counts[rng.int(n)]++;
  const expected = samples / n;
  const chi2 = counts.reduce((acc, c) => acc + ((c - expected) ** 2) / expected, 0);
  // 自由度 5，p=0.001 临界值约 20.5
  assert.ok(chi2 < 25, `卡方值异常: ${chi2}`);
});

test('float 均值≈0.5，gauss 均值≈0 方差≈1', () => {
  const rng = new Rng(7);
  const N = 100000;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += rng.float();
  assert.ok(Math.abs(sum / N - 0.5) < 0.01, 'float 均值偏差过大');
  let gsum = 0;
  let gsq = 0;
  for (let i = 0; i < N; i++) {
    const g = rng.gauss();
    gsum += g;
    gsq += g * g;
  }
  const mean = gsum / N;
  const variance = gsq / N - mean * mean;
  assert.ok(Math.abs(mean) < 0.03, 'gauss 均值偏差过大: ' + mean);
  assert.ok(Math.abs(variance - 1) < 0.06, 'gauss 方差偏差过大: ' + variance);
});

test('state 序列化后可继续复现', () => {
  const a = new Rng(99);
  for (let i = 0; i < 10; i++) a.nextU32();
  const snap = a.getState();
  const s1 = Array.from({ length: 10 }, () => a.nextU32());
  const b = new Rng(1);
  b.setState(snap);
  const s2 = Array.from({ length: 10 }, () => b.nextU32());
  assert.deepEqual(s1, s2);
});

test('hashLane 稳定且覆盖 [0,1)', () => {
  for (const id of [1, 2, 3, 999999, 123456789]) {
    const a = hashLane(id, 1024);
    const b = hashLane(id, 1024);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 1);
  }
  // 1 万个 id 应有较好分散度（不同值数量接近 1024）
  const set = new Set();
  for (let i = 1; i <= 10000; i++) set.add(Math.floor(hashLane(i, 1024) * 1024));
  assert.ok(set.size > 1000, 'hashLane 分散度不足: ' + set.size);
});
