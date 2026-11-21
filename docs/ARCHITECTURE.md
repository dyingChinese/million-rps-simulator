# 架构设计（ARCHITECTURE）

## 1. 线程模型

```
┌──────────────────────────────────────────────────────────────────────┐
│  主线程 (node src/index.js)                                          │
│  ├─ HTTP Server：静态资源 / /api/config /status /control /frame      │
│  ├─ 二进制快照流：/api/stream（chunked，多客户端，慢客户端丢帧）      │
│  └─ Worker 消息桥：控制指令 → sim-worker，快照帧 → 广播              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ postMessage / transferable ArrayBuffer
┌───────────────────────────────▼──────────────────────────────────────┐
│  模拟线程 sim-worker（独立 Worker）                                   │
│  ├─ Engine：每 tick 跑一回合（不阻塞 HTTP）                           │
│  ├─ 自适应快照：仅在存在观看者时构建（analytics + snapshot.js）       │
│  └─ BattlePool：4 个并行对战 worker（共享 SharedArrayBuffer）          │
│       ├─ battle-worker-0：结算 pair 区间 [0, N/4)                     │
│       ├─ battle-worker-1：结算 pair 区间 [N/4, N/2)                   │
│       ├─ battle-worker-2：结算 pair 区间 [N/2, 3N/4)                  │
│       └─ battle-worker-3：结算 pair 区间 [3N/4, N)                    │
└──────────────────────────────────────────────────────────────────────┘
```

为什么这样切：

- HTTP 与模拟分离 → 百万人口下 tick 耗时 ~100ms，不会阻塞前端请求/流推送。
- 对战按 pair 划分 → **每个个体每回合只出现于一个 pair**，不同 worker 写入的槽位天然互不相交，无需锁。
- 主线程（sim-worker）用 `Atomics.wait` 同步等待 → `Engine.tick()` 保持同步语义，bench/测试/worker 循环无需 async 化。
- 当 pair 数 < `parallel.minPairs`（默认 6000，即约 1.2 万人以下）时自动走单线程，避免小规模同步开销。

## 2. 一回合（tick）流水线

`Engine.tick()`（`src/core/engine.js`）：

```
1. round++ / 通胀更新（成本 = base × inflationFactor）
2. 世界事件：宏观调控 1~4 + 保底 + 瘟疫（events.js）
   - 事件标记的死亡（瘟疫）由引擎统一清算（deadSlots → created/destroyed → freeSlot）
3. 公会模式（可选，guilds.js）：成员缴金 → 濒临破产兜底/开除 → 招收新成员 → 等级更新 → 公会团体战
   （全部为资产转移：成员 ↔ 金库 / 金库 ↔ 金库，不影响 created/destroyed）
4. 个体阶段：年龄+1、自然死亡、负资产计息、破产判定、冻结/解冻
5. 匹配池构建（存活且未冻结）→ 配对（随机/资产相近/策略相近）
6. 对战结算（battle.js，可并行）：
   出拳 → 成本（含公会等级折扣）→ 胜负 → 幸运翻盘/连胜惩罚 → 赌注 → 软上限 → 学习/逆反/模仿
   → 资产写回 → 破产标记 → 死亡槽位收集
7. 死亡清算：负资产核销 / 正资产遗产由随机继承者分配（或分给最近对手）→ 槽位回收
8. 繁殖：条件筛选 → 随机配对 → 生育成本 → 子代基因/天赋/家族/公会/谱系 → 分配槽位
9. 汇总：重建存活表 → 总资产/极值/阶层计数 → 结束条件 → 统计钩子（含阶层流动）→ 追踪记录
```

每阶段耗时记录在 `engine.phaseMs`（bench 会打印阶段耗时明细）。

## 3. 数据布局（SoA）

百万个体若用 JS 对象（AoS）会带来 GC 与指针跳转灾难，因此全部状态列式存储于 TypedArray：

```
slot:        0        1        2      ...   capacity-1
assets:    [f64]    [f64]    [f64]   ...
gene:      [f32×6]  [f32×6]  [f32×6] ...
stats:     [i32×4]  [i32×4]  [i32×4] ...   rounds/wins/losses/draws
...
```

关键点：

- 热路径只做「数组下标 + 数字运算」，无对象属性访问、无临时对象分配。
- 死亡槽位进入 free list 复用；`id` 单调递增不复用，保证追踪/谱系引用的稳定性。
- 并行模式下数组由 `SharedArrayBuffer` 支撑（`store.shared`），普通模式下为常规 ArrayBuffer（更快）。

## 4. 快照流水线（每帧）

```
sim-worker                                   主线程                  浏览器
──────────                                   ──────                  ──────
analytics.snapshot(store, summary)
  ├─ 单次遍历：直方图/阶层/天赋/策略/采样点/策略网格
  ├─ 环形时间序列 → ≤600 点 JSON
  └─ sections: pts(f32×7×N) / ids(i32×N) / hist / strategyGrid / …
families.aggregateFamilies（家族榜）
tracker.snapshot（追踪卡）
buildFrame：JSON + 二进制段 → 单块 ArrayBuffer
postMessage(transfer)  ───────────────────► latestFrame 缓存
                                             ├─ /api/frame 返回单帧
                                             └─ /api/stream 广播 ───► fetch stream
                                                                      解析帧头/JSON
                                                                      TypedArray 零拷贝视图
                                                                      WebGL/Canvas 渲染
```

- 只有 `viewers > 0` 才构建快照（headless/bench 零浪费）。
- 快照间隔自适应：`max(90ms, analyticsMs × 6)`，上限 600ms —— 分析越贵，帧率自动越低，保证模拟线程 CPU 可预测。
- 帧结构见 [PROTOCOL.md](PROTOCOL.md)：16 字节头 + JSON + 对齐的二进制 sections。

## 5. 性能优化清单（按收益排序）

1. **对战热循环独立模块**（`battle.js`）：拆分小函数 + 预查表（学习系数）、内联出拳随机、先判负再读负债上限、数组引用局部缓存 → 相比初始实现单轮提升约 35%。
2. **SharedArrayBuffer 无锁并行**：1M 人口对战 128ms → ~69ms（4 worker；受内存带宽限制无法线性加速）。
3. **合并热字段**：`stats`（rounds/wins/losses/draws）合并为单块 stride 4 数组、`moveUsage` 小数组常驻缓存。
4. **O(n) 匹配**：部分 Fisher-Yates + 计数排序分桶（替代 O(n log n) 排序）。
5. **统计热循环**（`analytics.js`）：IEEE754 位运算近似 log10、无分支化分类、预分配全部临时数组、模块级函数与合成数据预热；
   100 万人口单帧分析 ~33~48ms（已接近纯 JS 单线程全量扫描极限）。
6. **快照按需** + 自适应间隔 + 慢客户端丢帧。
7. **二进制协议**：JSON 只放元数据（~30KB），大数组走 typed-array section，前端零拷贝。
8. **前端**：WebGL2 单 draw call 点云 + 单 quad 热图、纹理/缓冲复用、DOM rAF 合批 + 80ms 节流、事件/表格行池复用。

## 6. 可复现性

- 全部随机性来自单一 `Rng`（xoshiro128**），引擎按固定顺序消费。
- 单线程模式：同 seed 同配置 → 逐位相同的模拟历史（测试用「两次运行指纹一致」断言）。
- 并行模式：每个 worker 用 `(seed, round, workerIndex)` 派生子种子，同机同 worker 数可复现；换机器/改 worker 数轨迹会不同（已测试并文档化）。

## 7. 扩展点

| 想加什么 | 改哪里 |
|---|---|
| 新天赋 | `src/core/talents.js` + `config.js` 的权重/效果 |
| 新宏观事件/瘟疫机制 | `src/core/events.js`（返回 events + created/destroyed/deadSlots） |
| 新统计指标/可视化数据 | `src/core/analytics.js` 的 `scanPopulation` + PROTOCOL sections |
| 新 UI 图表 | `web/js/charts.js` + `panels.js` |
| 新结束条件 | `engine.js:_updateEndCondition()` + `config.js` |
| 家族战争 | 新增 `src/core/family-war.js`，参考 `guilds.js` 的团体战实现，在 `engine.js` 的回合钩子接入 |
