/**
 * analytics.js — 统计分析与可视化数据生产模块（负责人：analytics）
 *
 * 职责（严格对应 docs/CONTRACTS.md §6/§11.1 与 docs/PROTOCOL.md §3/§4/§5）：
 *  - `onRound(store, summary)`：每回合调用一次，**必须廉价**（目标 < 0.2ms）。
 *    只写时间序列环形缓冲与累计计数器，不做任何全量扫描。
 *  - `snapshot(store, summary)`：每 80~500ms 调用一次，生成前端一帧数据：
 *      `{ json, sections }`；全量扫描只发生在这里（100 万存活目标 ≤ 15ms）。
 *  - 阶层流动率（CONTRACTS §11.1）：主循环内顺带统计自上一帧以来的 up/down/stay
 *    与各阶层 flowIn/flowOut（按 slot + 稳定 ID 校验，第一帧/新个体/槽位复用不计入）。
 *
 * 设计要点：
 *  1. **只读 store**：绝不写任何个体字段（测试以校验和对比验证）。
 *  2. **一次主循环**：直方图 / 近似基尼 / 洛伦兹 / 阶层 / 阶层流动 / 天赋 / 策略偏好 /
 *     主导拳种 / 策略熵 / 出拳使用率 / 采样点 / 两张策略空间密度网格，同一遍完成。
 *  3. **零全量排序**：分位数/基尼/洛伦兹全部由 128 箱直方图的累计值近似。
 *  4. **预分配复用**：pts/ids/hist/两张网格的 TypedArray 在 setConfig 时一次性分配，
 *     快照期间不 new 任何大数组；主循环内不创建对象/闭包。
 *  5. **独立随机流**：采样使用模块内部独立 `Rng`（固定 seed，每次快照重置），
 *     绝不消耗模拟随机流 ⇒ 相同状态输出完全可复现，点云帧间稳定不闪烁。
 *  6. **资产轴快速映射**：`f(a)=sign(a)·log10(1+|a|)` 用「提取浮点指数 + 尾数查表」
 *     的位运算近似（误差 < 1e-4，远小于 1/128 箱宽），避免 100 万次 Math.log10。
 *  7. **热循环独立成小函数**：V8 对超大函数的分层优化预算很高（大函数要调用很多次
 *     才升到 TurboFan）；把主循环抽成模块级 `scanPopulation(ctx)`，可更快进入优化
 *     并避免闭包上下文读取。同时用无分支写法（阶层/主导拳种/负资产计数）避免
 *     随机数据导致的分支预测失败 —— 实测这几项能带来 2~4 倍的主循环提速。
 *
 * 数据布局（sections，顺序固定，offset 由 Lead 的 snapshot.js 计算）：
 *   pts                    f32  每点 7 个 float：[laneX, wealthY, classId, talentId, streakNorm, stratX, stratY]
 *   ids                    i32  与 pts 顺序对应的稳定个体 ID
 *   hist                   f32  128 箱资产直方图计数
 *   strategyGrid           f32  cfg.performance.gridStrategy.w × h 行优先计数
 *   strategyGridWealth     f32  同尺寸，每格 wealthY 之和
 *
 * 本模块不 import 引擎、不修改 store、不读写全局随机源。
 */

import { Rng, hashLane } from './rng.js';
import { CLASS_NAMES } from './config.js';
import { GENE_COUNT, TALENT_COUNT } from './store.js';

// ─────────────────────────── 常量 ───────────────────────────

/** 资产直方图箱数（PROTOCOL §4：hist = 128 个计数） */
const HIST_BINS = 128;
/** 洛伦兹曲线点数（x/y 交替共 102 个数） */
const LORENZ_POINTS = 51;
/** 时间序列输出给前端的最大点数（减小帧体积） */
const SERIES_MAX_POINTS = 600;
/** 财富天际线横向泳道数（PROTOCOL §5：laneX = hashLane(id, 1024)） */
const SAMPLE_LANES = 1024;
/** 策略三角形 y 轴归一化系数 √3/2 */
const TRI_Y_SCALE = 0.8660254037844386;
/** log10(2)：log2 → log10 换算 */
const LOG10_2 = Math.LN2 * Math.LOG10E;
/** 策略熵 LUT 粒度（输入按 1/4096 量化，误差 < 1e-4，远小于显示精度） */
const ENTROPY_LUT_SIZE = 4096;
/** ln(3)：三拳均匀分布的最大熵 */
const ENTROPY_MAX = Math.log(3);
/** 采样专用固定种子（内部独立流，不影响模拟流；每次快照重置） */
const SAMPLING_SEED = 0x5eed1e55;
/** wealthY = q / 128 的乘法形式 */
const WY_SCALE = 1 / HIST_BINS;
/** 空 summary 占位 */
const EMPTY_SUMMARY = Object.freeze({});

// ─────────────────────── 只读查表（模块级，构造一次）───────────────────────

/**
 * 尾数 log2 查表：MANT_LOG2_LUT[i] = log2(1 + i/4096)。
 * 通过 IEEE754 位提取 `(hi & 0xFFFFF) >>> 8` 得到尾数高 12 位直接查表；
 * 向下取整误差 ≤ 1.44/4096 ≈ 3.5e-4（换算到 log10 轴 ≈ 1e-4），
 * 远小于 128 箱的箱宽（默认约 0.0693），不影响统计与可视化精度。
 */
const MANT_LOG2_LUT = new Float64Array(4096);
for (let i = 0; i < 4096; i++) MANT_LOG2_LUT[i] = Math.log2(1 + i / 4096);

/**
 * 熵查表：ENTROPY_LUT[i] = -p·ln(p)，p = i/4096（p=0 时取 0）。
 * 100 万个体 × 3 个策略概率若直接 Math.log 会超过 15ms 预算，故用查表。
 */
const ENTROPY_LUT = new Float64Array(ENTROPY_LUT_SIZE + 1);
for (let i = 0; i <= ENTROPY_LUT_SIZE; i++) {
  const p = i / ENTROPY_LUT_SIZE;
  ENTROPY_LUT[i] = p > 0 ? -p * Math.log(p) : 0;
}

/** 把 double 拆成两个 u32 用于 IEEE754 指数/尾数提取（小端，与 PROTOCOL §2 一致） */
const BITS_SCRATCH_BUF = new ArrayBuffer(8);
const BITS_F64 = new Float64Array(BITS_SCRATCH_BUF);
const BITS_U32 = new Uint32Array(BITS_SCRATCH_BUF);

/**
 * 主循环上下文（模块级函数 `scanPopulation` 的唯一入参，隐藏类固定）。
 * 全部大数组均为预分配复用，快照时只改内容不改结构。
 */
const SCAN_CTX = {
  aliveList: null, // Int32Array 存活 slot 紧凑表
  id: null, // Int32Array 稳定 ID
  assets: null, // Float64Array 资产
  gene: null, // Float32Array 策略基因（stride 6）
  talent: null, // Uint8Array 天赋
  winStreak: null, // Int16Array
  lossStreak: null, // Int16Array
  n: 0, // 存活人数
  k: 0, // 采样点数 = min(sampleSize, n)
  sampleJ: null, // Int32Array 选中的 aliveList 下标（严格递增）
  pts: null, // Float32Array(stride 7)
  outIds: null, // Int32Array
  hist: null, // Int32Array(128) 计数累加
  grid: null, // Int32Array(w*h) 计数累加
  gridWealth: null, // Float32Array(w*h) wealthY 累加
  w: 0,
  h: 0,
  lo: 0, // fLo
  hi: 0, // fHi
  invBins: 0, // 128/(fHi-fLo)
  tA: 0, // 阶层阈值
  tB: 0,
  tC: 0,
  classCount: null, // Int32Array(4)
  classPos: null, // Float64Array(4)
  talentCount: null, // Int32Array(TALENT_COUNT)
  domCount: null, // Int32Array(3)
  // ── 阶层流动（CONTRACTS §11.1）──
  prevClass: null, // Uint8Array(capacity) 上一帧各 slot 的阶层
  prevId: null, // Int32Array(capacity) 上一帧各 slot 的稳定 ID（校验槽位复用）
  flowIn: null, // Int32Array(4) 本帧流入各阶层人数
  flowOut: null, // Int32Array(4) 本帧流出各阶层人数
  out: null, // 复用结果对象（避免每帧分配）
};

/**
 * 一次遍历完成全部全量统计 + 采样点 + 两张网格。
 *
 * 为什么单独成函数：V8 的分层优化按函数字节码大小分配中断预算，
 * 把热循环从巨大的 snapshot() 中拆出来，可以更快升温到 TurboFan，
 * 并且避免每次迭代读取闭包上下文变量（全部提前展开为局部变量）。
 *
 * @param {typeof SCAN_CTX} ctx 预分配上下文（见 SCAN_CTX）
 * @returns {{sumW:number,minA:number,maxA:number,negCount:number,prefR:number,prefS:number,prefP:number,sumEntropy:number,sampled:number,mvUp:number,mvDown:number,mvStay:number,mvTotal:number}}
 *   结果写入 ctx.out 并返回（同一对象复用，避免每帧分配）
 */
function scanPopulation(ctx) {
  const n = ctx.n;
  const aliveList = ctx.aliveList;
  const storeId = ctx.id;
  const assets = ctx.assets;
  const gene = ctx.gene;
  const talent = ctx.talent;
  const winStreak = ctx.winStreak;
  const lossStreak = ctx.lossStreak;
  const k = ctx.k;
  const sJ = ctx.sampleJ;
  const pts = ctx.pts;
  const outIds = ctx.outIds;
  const hist = ctx.hist;
  const grid = ctx.grid;
  const gridWealth = ctx.gridWealth;
  const w = ctx.w;
  const h = ctx.h;
  const wLast = w - 1;
  const hLast = h - 1;
  const lo = ctx.lo;
  const hi = ctx.hi;
  const invBins = ctx.invBins;
  const tA = ctx.tA;
  const tB = ctx.tB;
  const tC = ctx.tC;
  const classCount = ctx.classCount;
  const classPos = ctx.classPos;
  const talentCount = ctx.talentCount;
  const domCount = ctx.domCount;
  // 阶层流动（CONTRACTS §11.1）：上一帧阶层/ID + 本帧流入流出计数
  const prevClass = ctx.prevClass;
  const prevId = ctx.prevId;
  const flowIn = ctx.flowIn;
  const flowOut = ctx.flowOut;
  const mant = MANT_LOG2_LUT;
  const ent = ENTROPY_LUT;
  const log10_2 = LOG10_2;

  let sumW = 0; // 总资产（净额，含负债）
  let minA = Infinity;
  let maxA = -Infinity;
  let negCount = 0; // 负资产人数
  let prefR = 0; // 策略偏好累加
  let prefS = 0;
  let prefP = 0;
  let sumEntropy = 0; // 策略熵累加
  let si = 0; // 已写入采样点数
  let nextSample = k > 0 ? sJ[0] : -1; // 下一个采样点对应的 aliveList 下标
  // 阶层流动计数：up/down/stay/total（只统计「上一帧也存在且 id 一致」的个体）
  let mvUp = 0;
  let mvDown = 0;
  let mvTotal = 0;

  for (let j = 0; j < n; j++) {
    const s = aliveList[j];
    const a = assets[s];
    const sid = storeId[s]; // 稳定 ID（阶层流动校验 + 采样 ids 共用一次读取）

    // ── 资产轴映射 f(a) = sign(a)·log10(1+|a|)：位提取指数 + 尾数查表 ──
    BITS_F64[0] = a < 0 ? 1 - a : 1 + a; // 1 + |a| ≥ 1，指数恒非负
    const bits = BITS_U32[1]; // 小端：高 32 位（符号位恒 0）
    const log2x = ((bits >>> 20) - 1023 + mant[(bits & 0xfffff) >>> 8]) * log10_2;
    let f = a < 0 ? -log2x : log2x;
    if (f < lo) f = lo;
    else if (f > hi) f = hi;
    const q = (f - lo) * invBins; // [0, 128]
    let bin = q | 0;
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    hist[bin] += 1;
    const wealthY = q * WY_SCALE; // [0, 1]（网格财富着色用）

    // ── 财富总量 / 极值 / 负资产（极值分支几乎总是预测失败，保留预测成功的 if）──
    sumW += a;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    negCount += (a < 0) | 0; // 无分支

    // ── 阶层（无分支：等于「越过的阈值个数」）──
    const cls = (a >= tA) + (a >= tB) + (a >= tC);
    classCount[cls] += 1;
    if (a > 0) classPos[cls] += a;



    // ── 天赋计数 ──
    talentCount[talent[s]] += 1;

    // ── 策略偏好 / 熵 / 主导拳种 ──
    const g = s * GENE_COUNT;
    const pr = gene[g];
    const psc = gene[g + 1];
    const pp = gene[g + 2];
    prefR += pr;
    prefS += psc;
    prefP += pp;
    // 熵：-Σ p·ln(p)，三查表（概率已归一化，p∈[0,1]）
    sumEntropy += ent[(pr * ENTROPY_LUT_SIZE) | 0];
    sumEntropy += ent[(psc * ENTROPY_LUT_SIZE) | 0];
    sumEntropy += ent[(pp * ENTROPY_LUT_SIZE) | 0];
    // 主导拳种索引（无分支）：石 0 / 剪 1 / 布 2；平局规则：石>剪、剪>布（与旧实现一致）
    domCount[2 - 2 * ((pr >= psc) & (pr >= pp)) - ((pr < psc) & (psc >= pp))] += 1;

    // ── 策略空间密度网格（stratX = p_paper + 0.5·p_scissors；纵向等价 p_scissors）──
    const sx = pp + 0.5 * psc;
    let gx = (sx * w) | 0;
    if (gx >= w) gx = wLast;
    let gy = (psc * h) | 0;
    if (gy >= h) gy = hLast;
    const cell = gy * w + gx;
    grid[cell] += 1;
    gridWealth[cell] += wealthY;

    // ── 采样点（stride 7；ids 与 pts 顺序一一对应）──
    if (j === nextSample) {
      const o = si * 7;
      pts[o] = hashLane(sid, SAMPLE_LANES);
      pts[o + 1] = wealthY;
      pts[o + 2] = cls;
      pts[o + 3] = talent[s];
      let sn = (winStreak[s] - lossStreak[s]) * 0.125; // winStreak/8 - lossStreak/8
      if (sn < -1) sn = -1;
      else if (sn > 1) sn = 1;
      pts[o + 4] = sn;
      pts[o + 5] = sx;
      pts[o + 6] = psc * TRI_Y_SCALE;
      outIds[si] = sid;
      si++;
      nextSample = si < k ? sJ[si] : -1;
    }

    // ── 阶层流动（自上一帧）：按 slot + 稳定 id 校验，新个体/槽位复用不计入 ──
    // 说明：prevId[s] 为上一帧该 slot 的稳定 ID，只有 ID 一致才说明是同一个体；
    // 放在循环体末尾以缩短临时变量存活区间，减少主循环寄存器压力。
    const pid = prevId[s];
    if (pid === sid) {
      const pc = prevClass[s];
      mvTotal++;
      if (cls !== pc) {
        if (cls > pc) mvUp++;
        else mvDown++;
        flowIn[cls] += 1;
        flowOut[pc] += 1;
        prevClass[s] = cls; // 仅阶层变化时写回，减少热路径写流量
      }
    } else {
      // 新个体 / 槽位复用 / 第一帧：建立本帧历史，不计入流动
      prevId[s] = sid;
      prevClass[s] = cls;
    }
  }

  const out = ctx.out;
  out.sumW = sumW;
  out.minA = minA;
  out.maxA = maxA;
  out.negCount = negCount;
  out.prefR = prefR;
  out.prefS = prefS;
  out.prefP = prefP;
  out.sumEntropy = sumEntropy;
  out.sampled = si;
  // 阶层流动统计
  out.mvUp = mvUp;
  out.mvDown = mvDown;
  out.mvStay = mvTotal - mvUp - mvDown; // stay = total - up - down
  out.mvTotal = mvTotal;
  return out;
}

// ─────────────────────── 热循环预热（V8 分层优化）───────────────────────

/** 是否已完成预热（V8 优化状态挂在共享函数上，全进程只需一次） */
let scanWarmedUp = false;
/** 预热合成数据规模（个） */
const WARMUP_SIZE = 64;
/** 预热调用次数（数百次即可让 V8 升温到优化层；微型数据下单次成本极低） */
const WARMUP_CALLS = 2000;

/**
 * 预热 `scanPopulation`，让它提前进入 TurboFan。
 *
 * 背景：V8 对「大字节码函数」的分层优化预算按函数体量缩放，把热循环抽成
 * 模块级小函数后仍需数百次调用才升温；开局头几十帧若还在解释器/基线层，
 * 百万人口单帧可达 60~80ms，造成明显卡顿。这里用微型合成上下文（64 个体，
 * 调用数千次）廉价地耗尽邀请预算，使真正开局后的第一帧就走优化代码。
 *
 * 说明：合成数据与真实数据使用相同的 TypedArray 种类与相同形状的上下文对象，
 * 不会污染类型反馈（类型反馈按函数共享，数据值不影响）。
 */
function warmupScanPopulation() {
  if (scanWarmedUp) return;
  scanWarmedUp = true;

  const cap = WARMUP_SIZE;
  const aliveList = new Int32Array(cap);
  const ids = new Int32Array(cap);
  const assets = new Float64Array(cap);
  const gene = new Float32Array(cap * GENE_COUNT);
  const talent = new Uint8Array(cap);
  const winStreak = new Int16Array(cap);
  const lossStreak = new Int16Array(cap);
  const sampleJ = new Int32Array(cap);
  const hist = new Int32Array(HIST_BINS);
  const grid = new Int32Array(16);
  const gridWealth = new Float32Array(16);
  const classCount = new Int32Array(4);
  const classPos = new Float64Array(4);
  const talentCount = new Int32Array(TALENT_COUNT);
  const domCount = new Int32Array(3);
  const pts = new Float32Array(cap * 7);
  const outIds = new Int32Array(cap);
  // 阶层流动：合成数据也循环写入 prevClass/prevId，让热循环覆盖流动分支
  const prevClass = new Uint8Array(cap);
  const prevId = new Int32Array(cap);
  const flowIn = new Int32Array(4);
  const flowOut = new Int32Array(4);
  for (let i = 0; i < cap; i++) {
    prevId[i] = (i & 1) === 0 ? ids[i] : -1; // 一半匹配（计入流动），一半视为新个体
    prevClass[i] = (i + 1) % 4; // 与当前阶层错位，制造 up/down/stay 三种分支
  }
  const out = {
    sumW: 0, minA: 0, maxA: 0, negCount: 0,
    prefR: 0, prefS: 0, prefP: 0, sumEntropy: 0, sampled: 0,
    mvUp: 0, mvDown: 0, mvStay: 0, mvTotal: 0,
  };
  for (let i = 0; i < cap; i++) {
    aliveList[i] = i;
    ids[i] = i + 1;
    assets[i] = (i - cap / 4) * 173.5; // 含负资产与不同量级
    const g = i * GENE_COUNT;
    gene[g] = 0.3 + (i % 5) * 0.01;
    gene[g + 1] = 0.3;
    gene[g + 2] = 0.4 - (i % 5) * 0.01;
    gene[g + 3] = 1; // 风险
    gene[g + 4] = 500; // 保守阈值
    gene[g + 5] = 2000; // 激进阈值
    talent[i] = i % TALENT_COUNT;
    winStreak[i] = i % 11;
    lossStreak[i] = (i * 3) % 11;
    sampleJ[i] = i;
  }

  // 临时把同一个上下文对象指向合成数据（隐藏类不变），预热后由调用方恢复
  const ctx = SCAN_CTX;
  const saved = {
    aliveList: ctx.aliveList, id: ctx.id, assets: ctx.assets, gene: ctx.gene, talent: ctx.talent,
    winStreak: ctx.winStreak, lossStreak: ctx.lossStreak, n: ctx.n, k: ctx.k,
    sampleJ: ctx.sampleJ, pts: ctx.pts, outIds: ctx.outIds,
    hist: ctx.hist, grid: ctx.grid, gridWealth: ctx.gridWealth, w: ctx.w, h: ctx.h,
    lo: ctx.lo, hi: ctx.hi, invBins: ctx.invBins, tA: ctx.tA, tB: ctx.tB, tC: ctx.tC,
    classCount: ctx.classCount, classPos: ctx.classPos, talentCount: ctx.talentCount,
    domCount: ctx.domCount, prevClass: ctx.prevClass, prevId: ctx.prevId,
    flowIn: ctx.flowIn, flowOut: ctx.flowOut, out: ctx.out,
  };
  ctx.aliveList = aliveList;
  ctx.id = ids;
  ctx.assets = assets;
  ctx.gene = gene;
  ctx.talent = talent;
  ctx.winStreak = winStreak;
  ctx.lossStreak = lossStreak;
  ctx.n = cap;
  ctx.k = cap;
  ctx.sampleJ = sampleJ;
  ctx.pts = pts;
  ctx.outIds = outIds;
  ctx.hist = hist;
  ctx.grid = grid;
  ctx.gridWealth = gridWealth;
  ctx.w = 4;
  ctx.h = 4;
  ctx.lo = -3;
  ctx.hi = 7;
  ctx.invBins = HIST_BINS / 10;
  ctx.tA = 500;
  ctx.tB = 2000;
  ctx.tC = 10_000;
  ctx.classCount = classCount;
  ctx.classPos = classPos;
  ctx.talentCount = talentCount;
  ctx.domCount = domCount;
  ctx.prevClass = prevClass;
  ctx.prevId = prevId;
  ctx.flowIn = flowIn;
  ctx.flowOut = flowOut;
  ctx.out = out;

  for (let i = 0; i < WARMUP_CALLS; i++) scanPopulation(ctx);

  // 恢复真实数据引用（值由调用方随后 setConfig 重新同步）
  Object.assign(ctx, saved);
}

// ─────────────────────────── 小工具 ───────────────────────────

/** @returns {number} 高性能时钟（Node worker / 浏览器均可用） */
const nowFn = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now();

/** 有限数字取默认值 */
function numOr(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

/** 夹取整数到 [lo, hi] */
function clampInt(v, lo, hi) {
  const x = Math.round(numOr(v, lo));
  return x < lo ? lo : x > hi ? hi : x;
}

/** 保留 m 位小数（非有限值归零，-0 归一为 0） */
function roundTo(v, m) {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * m) / m;
  return r === 0 ? 0 : r;
}
const round2 = (v) => roundTo(v, 100);
const round4 = (v) => roundTo(v, 10000);
const round6 = (v) => roundTo(v, 1e6);

/**
 * 精确资产轴映射（仅初始化时用，热路径用查表近似）：
 * f(a) = sign(a)·log10(1+|a|)
 * @param {number} a
 * @returns {number}
 */
function fExact(a) {
  const v = Math.log10(1 + Math.abs(a));
  return a < 0 ? -v : v;
}

/**
 * f 轴逆映射：由 f 反推资产近似值（直方图分位数/洛伦兹代表值用）。
 * @param {number} f
 * @returns {number}
 */
function fToAsset(f) {
  const ab = f < 0 ? -f : f;
  const a = Math.pow(10, ab) - 1;
  return f < 0 ? -a : a;
}

/**
 * 四舍五入后的占比四元组收尾：保证和恰好为 1（浮点误差 < 1e-9）。
 * 前三项舍入进位导致和 > 1 时从最大项扣回，避免 UI 堆叠条溢出。
 * @param {[number, number, number]} parts 已 round4 的前三项
 * @returns {number[]} 长度 4，和 = 1
 */
function finalizeShares(parts) {
  let a = parts[0];
  let b = parts[1];
  let c = parts[2];
  let d = 1 - a - b - c;
  if (d < 0) {
    const excess = -d;
    if (a >= b && a >= c) a = round4(Math.max(0, a - excess));
    else if (b >= c) b = round4(Math.max(0, b - excess));
    else c = round4(Math.max(0, c - excess));
    d = round4(Math.max(0, 1 - a - b - c));
  }
  return [a, b, c, d];
}

/**
 * 创建统计/采样/可视化数据生产器。
 *
 * @param {object} cfg `createConfig()` 产出的归一化配置（只读）
 * @returns {{
 *   setConfig: (cfg: object) => void,
 *   reset: () => void,
 *   onRound: (store: object, summary: object) => void,
 *   snapshot: (store: object, summary: object) => { json: object, sections: Array<{name: string, type: 'f32'|'i32', data: TypedArray}> }
 * }}
 */
export function createAnalytics(cfg) {
  // ── 配置派生状态（setConfig 时更新）──
  let conf = cfg;
  /** 采样点上限 = cfg.performance.sampleSize */
  let sampleSize = 0;
  /** 策略网格宽高 = cfg.performance.gridStrategy */
  let gridW = 192;
  let gridH = 160;
  /** 时间序列环形缓冲容量 = cfg.performance.historyRounds */
  let historyCap = 2000;
  /** 资产轴参考范围（PROTOCOL §5 固定定义） */
  let fLo = fExact(-750);
  let fHi = fExact(1_000_000);
  /** 每箱对应的 f 轴宽度 */
  let binWidthF = (fHi - fLo) / HIST_BINS;
  /** 128 箱 / f 轴总宽（一次乘加同时得到箱号与 wealthY） */
  let invRangeBins = HIST_BINS / (fHi - fLo);
  /** 阶层资产阈值（底层/中层/上层上限；顶层为剩余） */
  let classT0 = 500;
  let classT1 = 2000;
  let classT2 = 10_000;
  /** 每箱代表资产（用于近似基尼/洛伦兹） */
  const binRep = new Float64Array(HIST_BINS);

  // ── 预分配缓冲区（快照热路径零分配）──
  /** @type {Int32Array} 直方图计数累加（整数更快，最后转 f32 section） */
  let histInt = null;
  /** @type {Float32Array} 128 箱直方图输出（section） */
  let histArr = null;
  /** @type {Int32Array} 策略网格计数累加 */
  let gridInt = null;
  /** @type {Float32Array} 策略网格计数输出（section） */
  let gridArr = null;
  /** @type {Float32Array} 策略网格 wealthY 累加（直接作为 section） */
  let gridWealthArr = null;
  /** @type {Float32Array} 采样点（stride 7，section） */
  let ptsArr = null;
  /** @type {Int32Array} 采样点 ID（section） */
  let idsArr = null;
  /** @type {Int32Array} 分层随机采样选中的 aliveList 下标 */
  let sampleJ = null;

  // ── 快照临时数组（复用，避免每帧分配）──
  const classCount = new Int32Array(4); // 阶层人数
  const classPosWealth = new Float64Array(4); // 阶层正资产累加
  const talentCount = new Int32Array(TALENT_COUNT); // 天赋人数
  const domCount = new Int32Array(3); // 主导拳种人数
  const cumCountFrac = new Float64Array(HIST_BINS + 1); // 洛伦兹 x 边界
  const cumWealthFrac = new Float64Array(HIST_BINS + 1); // 洛伦兹 y 边界
  /** 主循环结果复用对象 */
  const scanOut = {
    sumW: 0, minA: 0, maxA: 0, negCount: 0,
    prefR: 0, prefS: 0, prefP: 0, sumEntropy: 0, sampled: 0,
    mvUp: 0, mvDown: 0, mvStay: 0, mvTotal: 0,
  };
  /** 本帧流入/流出各阶层人数（CONTRACTS §11.1） */
  const flowIn = new Int32Array(4);
  const flowOut = new Int32Array(4);
  /** @type {Uint8Array|null} 上一帧各 slot 阶层（懒分配，capacity 增长时重建） */
  let prevClass = null;
  /** @type {Int32Array|null} 上一帧各 slot 稳定 ID（校验槽位复用/新个体） */
  let prevId = null;

  // ── 时间序列环形缓冲（列式存储，onRound 只写 15 个标量）──
  /** @type {Int32Array} */
  let ringRound = null;
  /** @type {Int32Array} */
  let ringAlive = null;
  /** @type {Float64Array} */
  let ringBirths = null;
  /** @type {Float64Array} */
  let ringDeaths = null;
  /** @type {Float64Array} */
  let ringBankruptcies = null;
  /** @type {Float64Array} 总资产（净额） */
  let ringTotal = null;
  /** @type {Float64Array} 人均资产 */
  let ringMean = null;
  /** @type {Float32Array} 近似基尼 */
  let ringGini = null;
  /** @type {Float32Array} 主导拳种占比 */
  let ringRock = null;
  /** @type {Float32Array} */
  let ringScissors = null;
  /** @type {Float32Array} */
  let ringPaper = null;
  /** @type {Int32Array} 阶层人数 */
  let ringClass0 = null;
  /** @type {Int32Array} */
  let ringClass1 = null;
  /** @type {Int32Array} */
  let ringClass2 = null;
  /** @type {Int32Array} */
  let ringClass3 = null;

  let head = 0; // 下一个写入位置
  let size = 0; // 当前有效点数
  let lastRound = -1; // 最近一次 onRound 的回合号
  /** 累计计数器缓存 [births, deaths, bankruptcies]（summary 缺失时回退） */
  const lastCounters = new Float64Array(3);
  let lastFrozen = 0;
  /** 上一次快照算出的「昂贵统计」，onRound 写入新点时向后携带（阶梯状近似） */
  const lastClass = new Int32Array(4);
  let lastGini = 0;
  let lastRock = 0;
  let lastScissors = 0;
  let lastPaper = 0;

  // ── 采样专用独立 RNG（固定 seed，每次快照重置 ⇒ 同状态输出可复现）──
  const samplingRng = new Rng(SAMPLING_SEED);
  /** @type {object} 采样 RNG 的初始状态快照 */
  let samplingResetState = samplingRng.getState();

  // ─────────────────────────── 配置 ───────────────────────────

  /**
   * 应用 / 热更新配置。
   * 仅当网格尺寸、采样上限、历史长度变化时才重建相应缓冲区；
   * historyRounds 变化会清空时间序列（其余参数热更新不清空）。
   * @param {object} nextCfg 归一化配置
   */
  function setConfig(nextCfg) {
    conf = nextCfg || {};
    const perf = conf.performance || {};
    const grid = perf.gridStrategy || {};

    sampleSize = clampInt(perf.sampleSize, 0, 262_144);
    gridW = clampInt(grid.w, 1, 1024);
    gridH = clampInt(grid.h, 1, 1024);

    const initialWealth = numOr(conf.initialWealth, 1000);
    const maxDebt = Math.max(0, numOr(conf.maxDebt, 500));

    // PROTOCOL §5：财富轴固定参考范围 f(-maxDebt*1.5) .. f(initialWealth*1000)
    const refHi = initialWealth * 1000;
    fLo = fExact(-maxDebt * 1.5);
    fHi = fExact(refHi > 1 ? refHi : 1);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fHi - fLo < 1e-9) {
      fLo = -1;
      fHi = 1;
    }
    binWidthF = (fHi - fLo) / HIST_BINS;
    invRangeBins = HIST_BINS / (fHi - fLo);

    // 阶层阈值：优先使用 config.js 的派生字段，缺失时按因子自行推导（容错）
    const derived = conf._derived && Array.isArray(conf._derived.classThresholds) ? conf._derived.classThresholds : null;
    const cls = conf.classes || {};
    classT0 = derived && derived.length >= 3 ? derived[0] : initialWealth * numOr(cls.lowFactor, 0.5);
    classT1 = derived && derived.length >= 3 ? derived[1] : initialWealth * numOr(cls.midFactor, 2);
    classT2 = derived && derived.length >= 3 ? derived[2] : initialWealth * numOr(cls.highFactor, 10);
    if (!(classT0 <= classT1 && classT1 <= classT2)) {
      classT0 = initialWealth * 0.5;
      classT1 = initialWealth * 2;
      classT2 = initialWealth * 10;
    }

    // 每箱代表资产（箱中心 → f 轴逆映射）
    for (let b = 0; b < HIST_BINS; b++) binRep[b] = fToAsset(fLo + (b + 0.5) * binWidthF);

    // 缓冲区：尺寸变化才重建
    if (!histInt) {
      histInt = new Int32Array(HIST_BINS);
      histArr = new Float32Array(HIST_BINS);
    }
    const ptsLen = sampleSize * 7;
    if (!ptsArr || ptsArr.length !== ptsLen) ptsArr = new Float32Array(ptsLen);
    if (!idsArr || idsArr.length !== sampleSize) idsArr = new Int32Array(sampleSize);
    const cells = gridW * gridH;
    if (!gridInt || gridInt.length !== cells) {
      gridInt = new Int32Array(cells);
      gridArr = new Float32Array(cells);
      gridWealthArr = new Float32Array(cells);
    }
    if (!sampleJ || sampleJ.length !== sampleSize) sampleJ = new Int32Array(sampleSize);

    // 同步热循环上下文（结构固定，只改字段值）
    SCAN_CTX.hist = histInt;
    SCAN_CTX.grid = gridInt;
    SCAN_CTX.gridWealth = gridWealthArr;
    SCAN_CTX.pts = ptsArr;
    SCAN_CTX.outIds = idsArr;
    SCAN_CTX.sampleJ = sampleJ;
    SCAN_CTX.w = gridW;
    SCAN_CTX.h = gridH;
    SCAN_CTX.lo = fLo;
    SCAN_CTX.hi = fHi;
    SCAN_CTX.invBins = invRangeBins;
    SCAN_CTX.tA = classT0;
    SCAN_CTX.tB = classT1;
    SCAN_CTX.tC = classT2;
    SCAN_CTX.classCount = classCount;
    SCAN_CTX.classPos = classPosWealth;
    SCAN_CTX.talentCount = talentCount;
    SCAN_CTX.domCount = domCount;
    SCAN_CTX.out = scanOut;

    // 环形缓冲：容量变化重建并清空（其余配置热更新保留历史）
    const cap = clampInt(perf.historyRounds, 60, 20_000);
    if (cap !== historyCap || !ringRound) {
      historyCap = cap;
      ringRound = new Int32Array(cap);
      ringAlive = new Int32Array(cap);
      ringBirths = new Float64Array(cap);
      ringDeaths = new Float64Array(cap);
      ringBankruptcies = new Float64Array(cap);
      ringTotal = new Float64Array(cap);
      ringMean = new Float64Array(cap);
      ringGini = new Float32Array(cap);
      ringRock = new Float32Array(cap);
      ringScissors = new Float32Array(cap);
      ringPaper = new Float32Array(cap);
      ringClass0 = new Int32Array(cap);
      ringClass1 = new Int32Array(cap);
      ringClass2 = new Int32Array(cap);
      ringClass3 = new Int32Array(cap);
      head = 0;
      size = 0;
      lastRound = -1;
      lastClass.fill(0);
      lastGini = 0;
      lastRock = 0;
      lastScissors = 0;
      lastPaper = 0;
    }

    // 采样 RNG 回到固定初始状态（保证同配置同状态的输出确定性）
    samplingResetState = new Rng(SAMPLING_SEED).getState();

    // 清空计数器缓存（新配置 = 新的统计口径）
    lastCounters.fill(0);
    lastFrozen = 0;
  }

  /**
   * 确保阶层流动历史缓冲足够大（懒分配；store 扩容 / 换局时重建）。
   *
   * 扩容时保留旧槽位历史（拷贝旧数组），避免「容量增长当帧」把已有个体
   * 全部误判为新个体而丢失一次流动统计；新槽位默认 prevId=0（id 从 1 起，必然不匹配 ⇒ 不计入）。
   * @param {number} capacity store.capacity
   */
  function ensureMobilityBuffers(capacity) {
    const cap = Math.max(0, capacity | 0);
    if (cap === 0) return;
    if (prevId && prevId.length >= cap) return;
    const oldId = prevId;
    const oldClass = prevClass;
    /** @type {Int32Array} */
    prevId = new Int32Array(cap);
    /** @type {Uint8Array} */
    prevClass = new Uint8Array(cap);
    if (oldId && oldClass) {
      prevId.set(oldId.subarray(0, Math.min(oldId.length, cap)));
      prevClass.set(oldClass.subarray(0, Math.min(oldClass.length, cap)));
    }
  }

  /**
   * 重置时间序列与缓存（新一局开始时调用）。
   * 不清配置、不重建缓冲区（缓冲区可跨局复用）。
   */
  function reset() {
    head = 0;
    size = 0;
    lastRound = -1;
    lastCounters.fill(0);
    lastFrozen = 0;
    lastClass.fill(0);
    lastGini = 0;
    lastRock = 0;
    lastScissors = 0;
    lastPaper = 0;
    // 阶层流动：清空历史（prevId=0 与任何稳定 ID 都不匹配 ⇒ 新一局第一帧不计流动）
    if (prevId) prevId.fill(0);
    if (prevClass) prevClass.fill(0);
    flowIn.fill(0);
    flowOut.fill(0);
    scanOut.mvUp = 0;
    scanOut.mvDown = 0;
    scanOut.mvStay = 0;
    scanOut.mvTotal = 0;
    samplingResetState = new Rng(SAMPLING_SEED).getState();
  }

  // ─────────────────────── 每回合：廉价记录 ───────────────────────

  /**
   * 每回合调用一次（必须廉价：只写环形缓冲的标量列，O(1)）。
   *
   * 说明：贵统计（基尼/阶层/主导拳种）无法在 O(1) 内得到，因此这里写入
   * 「上一次快照的值」作为携带值；snapshot() 扫描完成后会更新最新一个点，
   * 因此序列呈阶梯状近似（快照间隔越短越平滑），UI 展示足够。
   *
   * @param {object} store AgentStore
   * @param {object} summary 引擎每回合构造的摘要（字段见 CONTRACTS §6）
   */
  function onRound(store, summary) {
    const sm = summary || EMPTY_SUMMARY;
    const round = numOr(sm.round, lastRound + 1) | 0;

    // 回合号回退 ⇒ 视为新一局（防御：调用方漏调 reset 时序列不串台）
    if (round < lastRound) {
      head = 0;
      size = 0;
      lastClass.fill(0);
      lastGini = 0;
      lastRock = 0;
      lastScissors = 0;
      lastPaper = 0;
    }

    const alive = Math.max(0, numOr(sm.aliveCount, store ? store.aliveCount : 0)) | 0;
    const births = numOr(sm.births, lastCounters[0]);
    const deaths = numOr(sm.deaths, lastCounters[1]);
    const bankruptcies = numOr(sm.bankruptcies, lastCounters[2]);
    const total = numOr(sm.totalWealth, 0);
    lastCounters[0] = births;
    lastCounters[1] = deaths;
    lastCounters[2] = bankruptcies;
    lastFrozen = numOr(sm.frozenCount, lastFrozen);

    let idx;
    if (round === lastRound && size > 0) {
      // 同一回合重复调用 ⇒ 覆盖最新点，避免产生重复/错位序列点
      idx = head === 0 ? historyCap - 1 : head - 1;
    } else {
      idx = head;
      head++;
      if (head >= historyCap) head = 0;
      if (size < historyCap) size++;
    }
    lastRound = round;

    ringRound[idx] = round;
    ringAlive[idx] = alive;
    ringBirths[idx] = births;
    ringDeaths[idx] = deaths;
    ringBankruptcies[idx] = bankruptcies;
    ringTotal[idx] = total;
    ringMean[idx] = alive > 0 ? total / alive : 0;
    // 昂贵统计：先携带上一次快照结果，snapshot 后再覆盖最新点
    ringGini[idx] = lastGini;
    ringRock[idx] = lastRock;
    ringScissors[idx] = lastScissors;
    ringPaper[idx] = lastPaper;
    ringClass0[idx] = lastClass[0];
    ringClass1[idx] = lastClass[1];
    ringClass2[idx] = lastClass[2];
    ringClass3[idx] = lastClass[3];
  }

  // ─────────────────── 每帧：一次全量扫描 + 数据装配 ───────────────────

  /**
   * 从直方图近似求分位资产值（median / p90）。
   * @param {number} frac 目标分位 [0,1]
   * @param {number} n 存活人数
   * @param {number} fallback 找不到时的兜底值（一般用 max）
   * @returns {number}
   */
  function histQuantile(frac, n, fallback) {
    const target = frac * n;
    let cum = 0;
    for (let b = 0; b < HIST_BINS; b++) {
      const c = histInt[b];
      if (c === 0) continue;
      if (cum + c >= target) {
        const t = (target - cum) / c;
        return fToAsset(fLo + (b + t) * binWidthF);
      }
      cum += c;
    }
    return fallback;
  }

  /**
   * 生成一帧统计快照。
   *
   * @param {object} store AgentStore（只读）
   * @param {object} summary 引擎每回合构造的摘要
   * @returns {{ json: object, sections: Array<{name: string, type: 'f32'|'i32', data: TypedArray}> }}
   *   json 只含 PROTOCOL §3 中由统计模块负责的部分：
   *   round / population / wealth / strategy / classes / classFlow / talents / series / grids / perf
   *   （sections 单独返回；families/tracked/engine/events/inflation/plague 等由装配层合并）
   */
  function snapshot(store, summary) {
    const t0 = nowFn();
    const sm = summary || EMPTY_SUMMARY;

    // ── 0. 存活规模（以 store.aliveList 为准；只读）──
    const aliveList = store.aliveList;
    let n = store.aliveCount | 0;
    if (n < 0) n = 0;
    else if (n > aliveList.length) n = aliveList.length;
    const k = n < sampleSize ? n : sampleSize; // 实际采样点数

    // ── 1. 清空复用缓冲 ──
    histInt.fill(0);
    gridInt.fill(0);
    gridWealthArr.fill(0);
    classCount.fill(0);
    classPosWealth.fill(0);
    talentCount.fill(0);
    domCount.fill(0);
    // 阶层流动：确保历史缓冲容量足够（store 扩容时重建并保留旧数据），清空本帧流入/流出
    ensureMobilityBuffers(store.capacity);
    flowIn.fill(0);
    flowOut.fill(0);

    // ── 2. 分层随机采样索引（每层随机 1 个，覆盖全表；只用内部 RNG 流）──
    if (k > 0) {
      samplingRng.setState(samplingResetState);
      const stride = n / k;
      let prev = -1;
      for (let i = 0; i < k; i++) {
        let j = (i * stride + samplingRng.float() * stride) | 0;
        if (j >= n) j = n - 1;
        if (j <= prev) j = prev + 1; // 防御：浮点边界导致的重叠
        sampleJ[i] = j;
        prev = j;
      }
    }

    // ── 3. 一次主循环（见 scanPopulation）──
    // 注：SCAN_CTX 是模块级单例（避免每次扫描新建对象、也保证 scanPopulation 的隐藏类稳定）。
    // 多实例并存时必须在每次扫描前把所有字段重新绑定到本实例的输入/输出数组，
    // 否则一个实例会写进另一个实例的缓冲区。
    const scanStart = nowFn();
    const ctx = SCAN_CTX;
    ctx.aliveList = aliveList;
    ctx.id = store.id;
    ctx.assets = store.assets;
    ctx.gene = store.gene;
    ctx.talent = store.talent;
    ctx.winStreak = store.winStreak;
    ctx.lossStreak = store.lossStreak;
    ctx.n = n;
    ctx.k = k;
    ctx.sampleJ = sampleJ;
    ctx.pts = ptsArr;
    ctx.outIds = idsArr;
    ctx.hist = histInt;
    ctx.grid = gridInt;
    ctx.gridWealth = gridWealthArr;
    ctx.w = gridW;
    ctx.h = gridH;
    ctx.lo = fLo;
    ctx.hi = fHi;
    ctx.invBins = invRangeBins;
    ctx.tA = classT0;
    ctx.tB = classT1;
    ctx.tC = classT2;
    ctx.classCount = classCount;
    ctx.classPos = classPosWealth;
    ctx.talentCount = talentCount;
    ctx.domCount = domCount;
    ctx.prevClass = prevClass;
    ctx.prevId = prevId;
    ctx.flowIn = flowIn;
    ctx.flowOut = flowOut;
    ctx.out = scanOut;
    const scan = n > 0 ? scanPopulation(ctx) : null;
    const aliveScanMs = nowFn() - scanStart;

    // 计数缓冲 → f32 section（TypedArray.set 是 C++ 批量转换，远快于逐元素写 float）
    histArr.set(histInt);
    gridArr.set(gridInt);

    const sumW = scan ? scan.sumW : 0;
    const minA = scan ? scan.minA : 0;
    const maxA = scan ? scan.maxA : 0;
    const negCount = scan ? scan.negCount : 0;
    const prefR = scan ? scan.prefR : 0;
    const prefS = scan ? scan.prefS : 0;
    const prefP = scan ? scan.prefP : 0;
    const sumEntropy = scan ? scan.sumEntropy : 0;
    const mvUp = scan ? scan.mvUp : 0;
    const mvDown = scan ? scan.mvDown : 0;
    const mvStay = scan ? scan.mvStay : 0;
    const mvTotal = scan ? scan.mvTotal : 0;
    const mobility = round4((mvUp + mvDown) / Math.max(1, mvTotal));

    // ── 4. 直方图派生：近似基尼 / 洛伦兹 / 分位数 ──
    const total = sumW;
    const mean = n > 0 ? total / n : 0;
    const invN = n > 0 ? 1 / n : 0;

    // 4.1 各箱代表资产 → 直方图总资产（洛伦兹/基尼归一化）
    let sumBinWealth = 0;
    for (let b = 0; b < HIST_BINS; b++) sumBinWealth += histInt[b] * binRep[b];

    // 4.2 近似基尼：G = 1 - Σ (c_b/n)·(L_{b-1}+L_b)（梯形积分洛伦兹曲线）
    let gini = 0;
    if (n > 0 && sumBinWealth > 1e-9) {
      const invS = 1 / sumBinWealth;
      let cum = 0;
      let gsum = 0;
      for (let b = 0; b < HIST_BINS; b++) {
        const c = histInt[b];
        if (c === 0) continue;
        const prevL = cum * invS;
        cum += c * binRep[b];
        gsum += c * (prevL + cum * invS);
      }
      gini = 1 - gsum / n;
      if (gini < 0) gini = 0;
      else if (gini > 1) gini = 1;
    }

    // 4.3 洛伦兹曲线边界累计（截断到 [0,1]）
    let cc = 0;
    let cw = 0;
    cumCountFrac[0] = 0;
    cumWealthFrac[0] = 0;
    const invBinWealth = sumBinWealth > 1e-9 ? 1 / sumBinWealth : 0;
    for (let b = 0; b < HIST_BINS; b++) {
      const c = histInt[b];
      cc += c;
      cw += c * binRep[b];
      cumCountFrac[b + 1] = n > 0 ? cc / n : 0;
      let wf = cw * invBinWealth;
      if (wf < 0) wf = 0;
      else if (wf > 1) wf = 1;
      cumWealthFrac[b + 1] = wf;
    }

    // 4.4 输出 51 个点 [x,y,...]：x=i/50，y 在箱边界间线性插值；首点 [0,0]、末点 [1,1]
    const lorenz = new Array(LORENZ_POINTS * 2);
    lorenz[0] = 0;
    lorenz[1] = 0;
    let ptr = 0;
    let prevY = 0;
    for (let i = 1; i < LORENZ_POINTS - 1; i++) {
      const x = i / (LORENZ_POINTS - 1);
      while (ptr < HIST_BINS && cumCountFrac[ptr + 1] < x) ptr++;
      const x0 = cumCountFrac[ptr];
      const x1 = cumCountFrac[ptr + 1];
      const span = x1 - x0;
      let y = span > 1e-12 ? cumWealthFrac[ptr] + (cumWealthFrac[ptr + 1] - cumWealthFrac[ptr]) * ((x - x0) / span) : cumWealthFrac[ptr + 1];
      if (y < 0) y = 0;
      else if (y > 1) y = 1;
      if (y < prevY) y = prevY; // 保证单调不减（负资产箱截断后可能回退）
      prevY = y;
      lorenz[i * 2] = round4(x);
      lorenz[i * 2 + 1] = round4(y);
    }
    lorenz[(LORENZ_POINTS - 1) * 2] = 1;
    lorenz[(LORENZ_POINTS - 1) * 2 + 1] = 1;

    // 4.5 分位数（直方图近似，无需排序）
    const median = n > 0 ? histQuantile(0.5, n, maxA) : 0;
    const p90 = n > 0 ? histQuantile(0.9, n, maxA) : 0;

    // ── 5. 占比类派生 ──
    // 5.1 阶层人数占比 & 正资产占比（保证各自和为 1）
    const shareParts = [0, 0, 0];
    for (let c = 0; c < 3; c++) shareParts[c] = n > 0 ? round4(classCount[c] * invN) : 0;
    const classShares = finalizeShares(shareParts);
    let posTotal = 0;
    for (let c = 0; c < 4; c++) posTotal += classPosWealth[c];
    const wealthParts = [0, 0, 0];
    if (posTotal > 0) {
      for (let c = 0; c < 3; c++) wealthParts[c] = round4(classPosWealth[c] / posTotal);
    }
    const classWealthShares = finalizeShares(wealthParts);

    // 5.2 策略统计
    const prefRock = round4(prefR * invN);
    const prefScissors = round4(prefS * invN);
    const prefPaper = round4(prefP * invN);
    const domRock = round4(domCount[0] * invN);
    const domScissors = round4(domCount[1] * invN);
    const domPaper = round4(domCount[2] * invN);
    let entropy = n > 0 ? sumEntropy * invN : 0;
    if (entropy < 0) entropy = 0;
    else if (entropy > ENTROPY_MAX) entropy = ENTROPY_MAX;

    // 5.3 本回合实际出拳占比（来自 summary.moveUsage，sum=0 时输出全 0）
    const mu = sm.moveUsage;
    let uR = 0;
    let uS = 0;
    let uP = 0;
    if (mu && typeof mu.length === 'number' && mu.length >= 3) {
      uR = Math.max(0, numOr(mu[0], 0));
      uS = Math.max(0, numOr(mu[1], 0));
      uP = Math.max(0, numOr(mu[2], 0));
    }
    const uTotal = uR + uS + uP;
    const usage = uTotal > 0
      ? [round4(uR / uTotal), round4(uS / uTotal), round4(uP / uTotal)]
      : [0, 0, 0];

    // ── 6. 更新时间序列最新点（用本次扫描的权威值覆盖 onRound 的携带值）──
    const giniR = round4(gini);
    if (size > 0) {
      const idx = head === 0 ? historyCap - 1 : head - 1;
      ringAlive[idx] = n;
      ringTotal[idx] = total;
      ringMean[idx] = mean;
      ringGini[idx] = giniR;
      ringRock[idx] = domRock;
      ringScissors[idx] = domScissors;
      ringPaper[idx] = domPaper;
      ringClass0[idx] = classCount[0];
      ringClass1[idx] = classCount[1];
      ringClass2[idx] = classCount[2];
      ringClass3[idx] = classCount[3];
    }
    // 供后续 onRound 携带
    lastClass[0] = classCount[0];
    lastClass[1] = classCount[1];
    lastClass[2] = classCount[2];
    lastClass[3] = classCount[3];
    lastGini = giniR;
    lastRock = domRock;
    lastScissors = domScissors;
    lastPaper = domPaper;

    // ── 7. 组装 JSON（严格按 PROTOCOL §3，仅统计模块负责的字段）──
    const roundV = numOr(sm.round, lastRound < 0 ? 0 : lastRound) | 0;
    const birthsV = numOr(sm.births, lastCounters[0]);
    const deathsV = numOr(sm.deaths, lastCounters[1]);
    const bankruptciesV = numOr(sm.bankruptcies, lastCounters[2]);
    const frozenV = Math.max(0, numOr(sm.frozenCount, lastFrozen)) | 0;
    const initialV = Math.max(0, numOr(conf.initialPopulation, 0));
    const invInitial = initialV > 0 ? 1 / initialV : 0;
    const familiesCfg = conf.families || {};

    const json = {
      round: roundV,
      population: {
        alive: n,
        initial: initialV,
        capacity: store.capacity,
        births: birthsV,
        deaths: deathsV,
        bankruptcies: bankruptciesV,
        frozen: frozenV,
        // 口径：累计计数 ÷ 初始人口（三者同口径，便于 UI 直接展示）
        birthRate: round6(birthsV * invInitial),
        deathRate: round6(deathsV * invInitial),
        bankruptRate: round6(bankruptciesV * invInitial),
        families: familiesCfg.enabled ? Math.max(0, numOr(familiesCfg.count, 0)) | 0 : 0,
      },
      wealth: {
        total: round2(total),
        mean: round2(mean),
        median: round2(median),
        p90: round2(p90),
        max: round2(maxA),
        min: round2(minA),
        gini: giniR, // 近似基尼（128 箱直方图）
        lorenz, // 51 个点，x/y 交替
        histogram: { bins: HIST_BINS }, // counts 由 hist section 提供
        classWealthShare: classWealthShares,
        negativeShare: round4(n > 0 ? negCount * invN : 0),
      },
      strategy: {
        usage,
        preference: [prefRock, prefScissors, prefPaper],
        dominant: [domRock, domScissors, domPaper],
        entropy: round4(entropy),
      },
      classes: [
        { id: 0, name: CLASS_NAMES[0], count: classCount[0], share: classShares[0], wealthShare: classWealthShares[0], flowIn: flowIn[0], flowOut: flowOut[0] },
        { id: 1, name: CLASS_NAMES[1], count: classCount[1], share: classShares[1], wealthShare: classWealthShares[1], flowIn: flowIn[1], flowOut: flowOut[1] },
        { id: 2, name: CLASS_NAMES[2], count: classCount[2], share: classShares[2], wealthShare: classWealthShares[2], flowIn: flowIn[2], flowOut: flowOut[2] },
        { id: 3, name: CLASS_NAMES[3], count: classCount[3], share: classShares[3], wealthShare: classWealthShares[3], flowIn: flowIn[3], flowOut: flowOut[3] },
      ],
      // 阶层流动（自上一帧；第一帧/新个体/槽位复用不计入，见 CONTRACTS §11.1）
      classFlow: {
        up: mvUp,
        down: mvDown,
        stay: mvStay,
        total: mvTotal,
        mobility,
      },
      talents: [
        talentCount[0], talentCount[1], talentCount[2],
        talentCount[3], talentCount[4], talentCount[5],
      ],
      series: null, // 下方填充
      grids: {
        strategy: { w: gridW, h: gridH },
        sampleCount: k,
      },
      perf: {
        analyticsMs: 0, // 本函数末尾回填（帧装配层可用其覆盖为端到端耗时）
        aliveScanMs: round2(aliveScanMs),
        sampleCount: k,
        frameBytes: 0, // 由帧装配层回填
        heapUsedMB: 0, // 由帧装配层回填
      },
    };

    // ── 8. 时间序列（环形缓冲 → 升序 JSON 数组，UI 采样到 ≤600 点）──
    const count = size <= SERIES_MAX_POINTS ? size : SERIES_MAX_POINTS;
    const serRound = [];
    const serAlive = [];
    const serBirths = [];
    const serDeaths = [];
    const serBankruptcies = [];
    const serTotal = [];
    const serMean = [];
    const serGini = [];
    const serRock = [];
    const serScissors = [];
    const serPaper = [];
    const serClass0 = [];
    const serClass1 = [];
    const serClass2 = [];
    const serClass3 = [];
    if (count > 0) {
      const start = (head - size + historyCap) % historyCap;
      const step = size > SERIES_MAX_POINTS ? (size - 1) / (SERIES_MAX_POINTS - 1) : 1;
      for (let i = 0; i < count; i++) {
        let rel;
        if (count === size) rel = i;
        else if (i === count - 1) rel = size - 1; // 恒包含最新点
        else rel = (i * step) | 0;
        const idx = (start + rel) % historyCap;
        serRound.push(ringRound[idx]);
        serAlive.push(ringAlive[idx]);
        serBirths.push(Math.round(ringBirths[idx]));
        serDeaths.push(Math.round(ringDeaths[idx]));
        serBankruptcies.push(Math.round(ringBankruptcies[idx]));
        serTotal.push(round2(ringTotal[idx]));
        serMean.push(round2(ringMean[idx]));
        serGini.push(round4(ringGini[idx]));
        serRock.push(round4(ringRock[idx]));
        serScissors.push(round4(ringScissors[idx]));
        serPaper.push(round4(ringPaper[idx]));
        serClass0.push(ringClass0[idx]);
        serClass1.push(ringClass1[idx]);
        serClass2.push(ringClass2[idx]);
        serClass3.push(ringClass3[idx]);
      }
    }
    json.series = {
      round: serRound,
      alive: serAlive,
      births: serBirths,
      deaths: serDeaths,
      bankruptcies: serBankruptcies,
      totalWealth: serTotal,
      meanWealth: serMean,
      gini: serGini,
      rock: serRock,
      scissors: serScissors,
      paper: serPaper,
      class0: serClass0,
      class1: serClass1,
      class2: serClass2,
      class3: serClass3,
    };

    // ── 9. sections（预分配 TypedArray 的切片；offset 由帧装配层计算）──
    const sections = [
      { name: 'pts', type: 'f32', data: ptsArr.subarray(0, k * 7) },
      { name: 'ids', type: 'i32', data: idsArr.subarray(0, k) },
      { name: 'hist', type: 'f32', data: histArr },
      { name: 'strategyGrid', type: 'f32', data: gridArr },
      { name: 'strategyGridWealth', type: 'f32', data: gridWealthArr },
    ];

    // 本模块快照自身的耗时（含 JSON 组装），由帧装配层决定是否覆盖
    json.perf.analyticsMs = round2(nowFn() - t0);
    return { json, sections };
  }

  // ── 初始化 ──
  setConfig(cfg);
  // 预热主循环，使第一帧快照即走优化代码（百万人口时避免开局头若干帧 60~80ms 卡顿）
  warmupScanPopulation();
  setConfig(conf); // 预热临时替换过上下文数据引用，这里恢复
  return { setConfig, reset, onRound, snapshot };
}
