# 模块契约（CONTRACTS）

> 所有模块均由 Lead 定义接口；**不要修改不属于你的文件**。语言：纯 ESM JavaScript + JSDoc 类型注释，零第三方依赖。
> 中文注释。数值/数组字段命名严格按下表，热路径不得分配临时对象。

## 0. 全局约定

- Node.js ≥ 20，`"type": "module"`（package.json 已配置）。
- 导入一律写扩展名：`import { Rng } from '../core/rng.js'`。
- 随机数**只能**使用注入的 `Rng` 实例（`rng.float()/int(n)/chance(p)/gauss()/range(a,b)`），保证同 seed 可复现。
- 不要在热路径（逐个体循环）里创建对象/闭包/数组字面量；复用预分配 TypedArray。
- 配置对象由 `src/core/config.js` 的 `createConfig()` 生成，**只读**，所有参数从这里取。
- 单元测试使用 `node --test`，文件放 `test/`（各自新建自己的测试文件）。
- 不要 `npm install`，不要引入依赖，不要联网。

## 1. 已由 Lead 完成的文件（只读，可直接使用）

### `src/core/rng.js`

```js
new Rng(seed)                    // seed: number|string
rng.nextU32(): number            // uint32
rng.float(): number              // [0,1)
rng.float53(): number            // [0,1) 双精度
rng.int(n): number               // [0,n)
rng.range(lo, hi): number
rng.chance(p): boolean
rng.gauss(): number              // 标准正态
rng.pick(arr)
rng.shuffle(arr)
rng.getState() / rng.setState(st)
hashLane(id, lanes): number      // [0,1) 稳定散列泳道
```

### `src/core/config.js`

```js
DEFAULT_CONFIG, PRESETS, CLASS_NAMES, CLASS_COLORS, TALENT_NAMES, TALENT_COLORS
createConfig(patch?): object     // 深合并默认值 + 范围钳制 + cfg._derived
mergeConfig(base, patch)
normalizeConfig(input)
presetPatch(name)
```

`cfg._derived.classThresholds = [底层上限, 中层上限, 上层上限]`（顶层为剩余）。

### `src/core/store.js` — `AgentStore`（SoA，核心数据结构）

```js
new AgentStore(capacity, cfg, startId = 1)

// 字段（全部按 slot 并行索引，slot ∈ [0, capacity)）：
store.capacity, store.count      // 已用槽位高水位
store.aliveCount, store.freeCount, store.nextId
store.id          Int32Array     // 稳定唯一 ID（不复用）
store.alive       Uint8Array     // 1 = 存活
store.frozen      Uint8Array     // 1 = 冻结（新手保护/破产冻结），不进匹配池
store.freezeUntil Int32Array
store.assets      Float64Array   // 可负
store.debtLimit   Float32Array   // 个体负债上限（已含天赋）
store.costAffinity Float32Array  // 成本系数（天赋节俭=0.9，默认 1）
store.age         Int32Array
store.birthRound  Int32Array
store.winStreak   Int16Array
store.lossStreak  Int16Array
store.reproCount  Uint8Array
store.stats       Int32Array     // 长度 capacity*STATS_STRIDE(4)：[rounds, wins, losses, draws]
store.gene        Float32Array   // 长度 capacity*6：[石头,剪刀,布,风险,保守阈值,激进阈值]
store.talent      Uint8Array     // 0..5
store.generation  Int16Array
store.familyId    Int32Array     // 父系家族 0..F-1
store.maternalFamilyId Int32Array
store.parentA / parentAId / parentB / parentBId  Int32Array
store.guild       Int16Array     // -1 = 无
store.infected / immunity Uint8Array; store.infectionRound Int32Array
store.lastOpp / lastOppPtr       // 破产清算启用时才有
store.aliveList   Int32Array     // 存活 slot 紧凑表
store.freeList    Int32Array
store.shared      boolean        // 是否 SharedArrayBuffer 支撑（并行对战）
store.arrayVersion number        // 数组扩容版本号（并行线程池据此刷新视图）

// 方法：
store.alloc(round): slot         // 分配并重置为基础默认值，id 自动递增
store.freeSlot(slot)             // 标记死亡 + 回收槽位（业务字段先处理完！）
store.rebuildAliveList(): number // 重建 aliveList，返回存活数（同时更新 aliveCount）
store.ensureCapacity(need)
store.geneOf(slot, geneId) / store.setGene(slot, geneId, v)
store.pushOpponent(slot, oppSlot) // 记录最近对手
```

统计常量：`STATS_STRIDE=4, STATS_ROUNDS=0, STATS_WINS=1, STATS_LOSSES=2, STATS_DRAWS=3`。

基因常量：`GENE_COUNT/GENE_ROCK/GENE_SCISSORS/GENE_PAPER/GENE_RISK/GENE_CONSERVATIVE/GENE_AGGRESSIVE`；
天赋常量：`TALENT_NONE/TALENT_LUCKY/TALENT_THRIFTY/TALENT_FERTILE/TALENT_FAST_LEARNER/TALENT_DEBT_RESISTANT/TALENT_COUNT`。

---

## 2. `src/core/talents.js`（负责人：sim-systems）

天赋定义、抽签、遗传、效果查询。所有函数必须是纯函数/无状态（随机源注入）。

```js
export const TALENT = { NONE:0, LUCKY:1, THRIFTY:2, FERTILE:3, FAST_LEARNER:4, DEBT_RESISTANT:5 };
export const TALENT_COUNT = 6;
export const TALENT_NAMES = ['无','幸运儿','节俭者','生育达人','学习天才','负债抗性'];  // 与 config.js 一致

/** 从 cfg.talents.weights 加权随机抽一个天赋；返回 0..5 */
export function rollTalent(rng, cfg): number

/** 后代天赋：继承父母之一（各 50%），有 cfg.talents.inheritanceMutation 概率突变为随机天赋 */
export function inheritTalent(rng, talentA, talentB, cfg): number

/** 天赋效果（返回数字，未启用天赋系统时返回中性值） */
export function costFactor(talent, cfg): number       // 节俭者 → 1 - thriftyCostReduce；否则 1
export function winBonus(talent, cfg): number         // 幸运儿 → luckBonus；否则 0
export function birthCostFactor(talent, cfg): number  // 生育达人 → 1 - fertileBirthCostReduce
export function learnFactor(talent, cfg): number      // 学习天才 → 1 + fastLearn
export function debtLimitFactor(talent, cfg): number  // 负债抗性 → 1 + debtLimitBonus
export function talentName(talent): string
```

## 3. `src/core/genetics.js`（负责人：sim-systems）

策略基因的生成/遗传/突变/出拳。基因用 `Float32Array` 扁平存储（stride 6），**函数接收 `ArrayLike<number>` + offset**，不创建对象。

约定：
- 基因 0/1/2 = 出石头/剪刀/布概率，三者归一化和为 1，每个 ≥ 0.01。
- 基因 3 = 风险偏好系数，范围 **[0.2, 3.0]**，默认 1.0（赌注倍率选择倾向）。
- 基因 4 = 保守阈值（资产低于该值时降低赌注），范围 **[0, initialWealth×5]**，默认 initialWealth×0.5。
- 基因 5 = 激进阈值（资产高于该值时提高赌注），范围 **[initialWealth, initialWealth×50]**，默认 initialWealth×2。
- 出拳编码：`MOVE_ROCK=0, MOVE_SCISSORS=1, MOVE_PAPER=2`；0 胜 1，1 胜 2，2 胜 0。

```js
export const MOVE_ROCK=0, MOVE_SCISSORS=1, MOVE_PAPER=2;
export const GENE_STRIDE=6;

/** 随机初始化一个基因到 out[offset..offset+5]（out 须已足够大） */
export function randomGenome(rng, cfg, out, offset): void

/** 后代基因：策略概率 = 父母均值 + 少量变异；风险=加权平均；阈值=中间值；并按 mutationRate 突变 */
export function inheritGenome(rng, parentA, aOff, parentB, bOff, cfg, out, outOff): void

/** 按 cfg.genetics.mutationRate 对任一维度做一次随机扰动（原地） */
export function mutateGenome(rng, cfg, genome, offset): boolean

/** 修正并归一化策略概率 + 钳制风险/阈值范围（原地） */
export function normalizeGenome(cfg, genome, offset): void

/** 按基因概率出拳，返回 MOVE_* */
export function pickMove(rng, genome, offset): number

/** 策略坐标（供可视化/统计分析）：
 *  x = p_paper + 0.5*p_scissors ∈ [0,1]
 *  y = p_scissors * (√3/2) ∈ [0,0.866] */
export function strategyPoint(genome, offset, out2): void
```

## 4. `src/core/events.js`（负责人：sim-systems）

宏观调控（模式 1~4 + 保底）、瘟疫、通胀辅助。直接修改 `store`，返回事件报告；**不得重建 aliveList、不得扩容**。

```js
export function createEventSystem(cfg): object   // 每局状态：{ plague: {active, roundsLeft}, lastFire: {...}, counters: {...} }

/**
 * 每回合调用一次（内部判断是否触发）。只允许通过 store.aliveList 遍历存活者。
 * @param {AgentStore} store
 * @param {object} state  createEventSystem 返回的状态
 * @param {object} ctx
 *   ctx = {
 *     cfg, rng, round,
 *     aliveList: Int32Array, aliveCount: number,
 *     cost: number,               // 当前（含通胀）单次成本
 *     totalWealth: number,        // 本回合开始时的总资产（近似即可）
 *     pool: { amount, created, destroyed },  // 系统资金池/统计（可修改）
 *   }
 * @returns {{events: Array<{round,type,title,detail,delta}>, created: number, destroyed: number, deaths: number}}
 *   events 最多返回 cfg.performance.eventLogSize 条；deaths 表示本函数内已经调用 store.freeSlot 的个体数。
 */
export function tickEvents(store, state, ctx): object

/** 手动触发某个宏观调控（UI 按钮/测试用）。返回事件报告，语义同上。 */
export function triggerManual(store, state, ctx, kind): object  // kind: 'average'|'redistribute'|'disaster'|'dividend'|'subsidy'|'plague'
```

实现要求（性能）：
- 均衡抽取类用 `rng.int(aliveCount)` 随机采样，**不要**全量排序；需要分位数时对最多 20000 个采样值排序取近似分位。
- 对每个个体只做 O(1) 操作；`average` 模式需两遍遍历（先算池子再均分）。
- 资产写入时同步维护 `ctx.pool.created/destroyed`：销毁记 created 为负？——统一：`created` 表示系统凭空创造的钱（分红/补助），`destroyed` 表示核销/蒸发（灾难/瘟疫/成本税收视配置而定）。
- 资源有限模式（`cfg.resourceLimited.enabled`）：福利类事件若 `cfg.resourceLimited.welfareFromPool` 且 `pool.amount` 不足则减少或跳过发放；`taxToPool` 时猜拳成本由引擎负责计入池子，事件模块不用管。
- 瘟疫：每 `everyRounds` 回合按 `probability` 激活；激活期间每回合按 `infectRate` 随机感染存活者，感染者按 `damagePct` 流失资产（正资产），有 `antibodyChance` 产生抗体（`store.immunity`），感染者资产低于自身负债上限×0.5 时有 `lowWealthExtraDeath` 概率直接死亡（调用 freeSlot 并计入 deaths）。

## 5. `src/core/families.js`（负责人：sim-systems）

家族命名、创始家族分配、家族聚合统计。家族数量固定 `cfg.families.count`（后代继承父系家族 ID，不新增家族）。

```js
export const FAMILY_NAMES = ['赵','钱','孙','李','周','吴','郑','王','冯','陈','褚','卫','蒋','沈','韩','杨',
  '朱','秦','尤','许','何','吕','施','张','孔','曹','严','华','金','魏','陶','姜', ...]; // 至少 64 个

export function createFamilySystem(cfg): FamilySystem   // { count, founderNames: string[], sexNames? }

/** 初始化用：返回随机家族 ID（0..count-1） */
export function familyForFounder(familySys, rng): number

/** 家族展示名，如 “赵家” */
export function familyName(familySys, familyId): string

/**
 * 聚合存活个体的家族统计（在快照时调用，每帧 1~2 次；O(aliveCount)）。
 * @returns {{
 *   topWealth: Array<{id,name,wealth,members,avgWealth,generation}>,
 *   topSize:   Array<{id,name,wealth,members}>,
 *   topGeneration: Array<{id,name,generation,members}>,
 *   familyCount: number, totalMembers: number
 * }}
 * topWealth 长度 ≤ cfg.performance.topFamilies
 */
export function aggregateFamilies(store, familySys, aliveList, aliveCount, cfg): object
```

实现要求：预分配 `Float64Array(count)` / `Int32Array(count)` 累加器并缓存于 familySys（每次调用 `fill(0)`），不要每次快照新建大数组；只对 topN 做选择（可对 count 个家族做小顶堆或直接排序，家族数 ≤ 4096，排序可接受）。

## 6. `src/core/analytics.js`（负责人：analytics）

所有统计/抽样/网格/时间序列。**只读 store**，不得修改个体状态。契约见 `docs/PROTOCOL.md` 的 Snapshot JSON 字段。

```js
export function createAnalytics(cfg): Analytics

analytics.setConfig(cfg)                    // 参数热更新
analytics.reset()                           // 重置时间序列/缓存（新一局开始时）
analytics.onRound(store, summary): void     // 每回合调用（必须廉价：只记计数器、追踪个体历史，不做全量扫描）
analytics.snapshot(store, summary): {
  json: object,                             // PROTOCOL 中 population/wealth/strategy/classes/talents/series/perf 等字段（不要带 sections）
  sections: Array<{ name: string, type: 'f32'|'i32', data: TypedArray }>
}                                           // 全量扫描发生在这里（快照间隔 ≥ 80ms）
```

`summary`（引擎每回合构造，对象复用）字段：

```js
{
  round, aliveCount, births, deaths, bankruptcies, frozenCount,
  totalWealth, maxAsset, aboveThreshold,     // aboveThreshold 仅在结束条件 A/B 需要时有效
  cost, inflationFactor,
  moveUsage: Int32Array(3),                  // 本回合实际出拳次数 [石头,剪刀,布]
  outcomes: { wins, losses, draws },         // 本回合对局结果计数
  avgBet, avgWinStreak, avgLossStreak,
  pool: { amount, created, destroyed },
  plague: { enabled, active, infected, antibodies },
  events: Array<{round,type,title,detail,delta}>,  // 最近的宏观调控/瘟疫事件（引擎透传）
  endCondition: { mode, label, progress, ended, reason },
  perf: { tickMs, roundsPerSec, analyticsMs }      // analyticsMs 由调用方回填
}
```

契约要点（务必遵守）：
- `onRound` 里维护时间序列环形缓冲：每回合 push 轻量点；`snapshot` 时把足够新的序列输出为 JSON（长度 ≤ `cfg.performance.historyRounds`，并对 UI 采样到 ≤ 600 点以减小帧大小）。
- `snapshot` 一次遍历同时完成：直方图、近似基尼/洛伦兹、阶层计数、天赋计数、策略偏好/主导、出拳使用占比、采样点（pts/ids）、策略空间密度网格（strategyGrid/strategyGridWealth）。**总耗时目标：100 万人口 ≤ 15ms**。
- Gini 用直方图分箱近似（文档注明“近似基尼系数”）：
  - 直方图横轴：`f(a) = sign(a)·log10(1+|a|)` 映射到 [0, 1]，固定参考范围 `f(-maxDebt*1.5) .. f(initialWealth*1000)`，**128 个等宽箱**。
  - 洛伦兹曲线：按直方图分箱累计近似，输出 51 个归一化点 `[x0,y0,x1,y1,...]`（x=人口累计占比 0→1，y=资产累计占比 0→1），截断到 [0,1] 并保证最后一个点为 [1,1]。
- 采样点数量 = `min(cfg.performance.sampleSize, aliveCount)`；随机采样即可（用 **本模块内部的独立 Rng**，seed 固定，避免影响模拟随机流）。
- 采样 `pts` 段格式（每点 7 个 float，stride 7）：
  `[laneX, wealthY, classId, talentId, streakNorm, stratX, stratY]`
  - `laneX = hashLane(id, 1024)`（来自 rng.js）
  - `wealthY = clamp((f(asset)-fLo)/(fHi-fLo), 0, 1)`
  - `streakNorm = clamp(winStreak/8 - lossStreak/8, -1, 1)`
  - `stratX = p_paper + 0.5*p_scissors`，`stratY = p_scissors*0.8660254`
  - 另附 `ids` 段：`Int32Array` 对应个体稳定 ID。
- `strategyGrid`：`cfg.performance.gridStrategy.w × h`，cell(gx,gy)，`gx = floor(stratX*w)`, `gy = floor(stratY/0.8660254*h)`，行优先。值为该格人数（float32，可为 0）。`strategyGridWealth` 同尺寸，值为该格 `wealthY` 之和。
- 直方图 `hist` 段：`Float32Array(128)` 计数。
- 时间序列 JSON 用普通数组，字段见 PROTOCOL。

## 7. `src/core/tracking.js`（负责人：Lead）

个体追踪（资产曲线/谱系）。接口由 Lead 实现，analytics/UI 只需按 PROTOCOL 消费 `tracked` 字段。

## 8. 引擎（`src/core/engine.js`，负责人：Lead）

对外接口（供 worker/bench/测试使用）：

```js
export class Engine {
  constructor(cfg)                       // cfg 来自 createConfig()
  get config()
  get round()
  get status()                            // 'idle' | 'running' | 'paused' | 'ended'
  reset(cfg?)                             // 重新初始化（可换配置）
  tick(): boolean                         // 跑一回合；返回是否已结束
  snapshot(seq): { buffer: ArrayBuffer, json: object }   // 完整二进制帧（见 PROTOCOL）
  trackById(id): object|null              // 追踪个体（返回 tracked 摘要）
  untrackById(id): boolean
  setConfig(patch)                        // 热更新（人口/初始资金/并行开关等需要重置的字段会自动重置）
  triggerMacro(kind): object
  getStatus(): object                     // 轻量状态（含 parallelWorkers/shared）
  close(): void                           // 关闭并行对战线程池（进程退出前调用）
}
```

对局热循环已抽到 **`src/core/battle.js`**（单线程与并行 worker 共用），
并行线程池在 **`src/core/battle-pool.js`**（SharedArrayBuffer + Atomics.wait 同步）。
相关配置：`cfg.parallel = { enabled, workers(=0 自动), minPairs }`。

## 9. Web UI（`web/`，负责人：web-ui）

按 `docs/PROTOCOL.md` 消费二进制帧；不依赖任何 CDN/构建工具，原生 ESM + WebGL2 + Canvas2D。

## 10. `src/core/guilds.js`（负责人：sim-systems）——公会模式（规则 5.3）

配置见 `cfg.guilds`（字段含义见 config.js 注释）。公会状态存放在 `store.guild: Int16Array`（-1 = 无公会，否则公会 ID 0..count-1）。

```js
export const GUILD_NAMES = ['青龙会','白虎堂','朱雀阁','玄武盟','...']; // ≥32 个中文名，互不重复

/** 创建公会系统（每局一个）：预分配金库/等级/人数/胜场累加器并缓存聚合结果 */
export function createGuildSystem(cfg): GuildSystem
// GuildSystem: {
//   enabled, count, names: string[],
//   treasury: Float64Array(count),      // 金库余额
//   level: Int32Array(count),           // 公会等级
//   wins: Int32Array(count),            // 团体战胜场
//   wars: number,                       // 累计团体战次数
//   treasuryTotal: number,              // 金库总额（供引擎记账/快照）
//   lastStats: object|null,             // 最近一次聚合结果（复用对象）
//   _memberCount/_memberAssets/_championBuf/_championCount 等内部复用缓冲
// }

/** 建号时入会：按 joinChance 随机加入某公会，返回 guildId 或 -1 */
export function guildForNewAgent(guildSys, rng, cfg): number

/** 后代入会：父系公会优先（若父/母有公会则继承），否则按 joinChance 随机，返回 guildId 或 -1 */
export function inheritGuild(guildSys, rng, parentGuild, cfg): number

/**
 * 每回合公会逻辑（引擎在「世界事件之后、个体阶段之前」调用一次）。
 * 允许直接修改 store.assets 与 store.guild（不得扩容、不得重建 aliveList）。
 * 顺序：① 成员缴金 → ② 濒临破产成员兜底/开除 → ③ 招收新成员 → ④ 等级更新 → ⑤ 团体战。
 * @param {import('./store.js').AgentStore} store
 * @param {GuildSystem} guildSys
 * @param {import('./rng.js').Rng} rng
 * @param {object} cfg
 * @param {number} round
 * @returns {{events:Array<{round,type,title,detail,delta}>, covered:number, expelled:number, recruited:number, wars:number, treasuryTotal:number}}
 */
export function tickGuilds(store, guildSys, rng, cfg, round): object

/**
 * 聚合并返回快照用公会榜（每帧 1~2 次，O(aliveCount)；
 * 复用小顶堆/排序 count≤256 个公会，不分配大数组）：
 * {
 *   enabled: true, total: count, wars, treasuryTotal, avgLevel,
 *   topWealth: [{id,name,level,members,treasury,memberAssets,totalWealth,wins}...(≤topN)],
 *   topMembers: [...], topWars: [...]
 * }
 */
export function aggregateGuilds(store, guildSys, cfg): object
```

实现要求：
- 只使用注入的 `rng`；热路径零对象分配；扫描只做一次 O(aliveCount)，复用缓冲。
- 缴金/兜底/团体战都是**资产转移**（成员 ↔ 金库 / 金库 ↔ 金库），不产生 created/destroyed。
- 团体战：随机选 2 个有成员的公会，各自随机抽 `warChampionCount` 名成员作为出战者，向对方公会金库下注 `warStake`；
  逐对用各自策略基因出拳（`genetics.pickMove`）决出胜负，赢家公会金库获得对方下注（上限=对方金库余额）。
  胜负记入 `wins`，并生成 1 条 `guild.war` 事件。
- 成员死亡/破产由引擎负责移除，`tickGuilds` 只负责把「资产低于 `-debtLimit × expelBelowRatio`」的成员设为 `guild=-1`（开除）。
- 引擎会维护：`engine.guildTreasury`（= guildSys.treasuryTotal）、`engine.guildLevelShared`（parallel 模式下的 SAB 等级视图）。

## 11. 统计扩展（第 2 轮，负责人：analytics + Lead）

### 11.1 阶层流动（analytics.js 内实现）
在每个快照的扫描中额外记录「自上一帧以来」的阶层迁移（按 slot + 稳定 id 校验，避免槽位复用误判）：
- 内部状态：`prevClass: Uint8Array(capacity)`、`prevId: Int32Array(capacity)`（懒分配，capacity 增长时重建，`reset()` 清空）。
- `json.classes[i].flowIn / flowOut`：自上一帧进入/离开第 i 阶层的个体数。
- `json.classFlow = { up, down, stay, total, mobility }`：up=向上流动人数、down=向下、stay=阶层不变、total=参与统计人数、
  `mobility = (up + down) / max(1, total)`。
- 第一帧/新个体（id 不匹配）不计入流动。

