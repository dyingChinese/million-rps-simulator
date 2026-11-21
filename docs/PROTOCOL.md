# 通信协议（PROTOCOL）

服务端 = 模拟引擎（worker 线程）+ HTTP 服务。前端通过 **HTTP 流式二进制帧** 接收快照，通过 `POST /api/control` 下发指令。
零依赖：不用 WebSocket，用 `fetch` + `ReadableStream` 读取分块流；控制用普通 POST。

---

## 1. HTTP 接口

### `GET /` 及静态资源
`web/` 目录静态服务（`/` → `web/index.html`，`/js/app.js` 等）。MIME 正确设置，支持 gzip 不必，加 `Cache-Control: no-cache`。

### `GET /api/config`
返回 JSON：
```json
{
  "ok": true,
  "config": { ...完整配置（createConfig 结果）... },
  "presets": { "demo": {"label":"演示 5 万"}, "standard": {...}, "million": {...}, "stress": {...} },
  "classNames": ["底层","中层","上层","顶层"],
  "talentNames": ["无","幸运儿","节俭者","生育达人","学习天才","负债抗性"],
  "classColors": ["#5b6b8c","#3fa7d6","#f5b942","#ff5d73"],
  "talentColors": ["#7f8c9b","#f7d343","#42d392","#ff9f43","#5b8cff","#c56cf0"],
  "version": 1
}
```

### `GET /api/status`
轻量 JSON（不启动流）：`{ ok, round, status, aliveCount, rps, tickMs, heapUsedMB, frameBytes }`

### `GET /api/frame`
返回**单个**二进制帧（帧格式见 §2，无外层长度前缀），用于测试/截图/调试。

### `GET /api/stream`
`Content-Type: application/octet-stream`，chunked 长连接。每帧 = 帧格式 §2（帧内 header 自带 `frameLength`，客户端先读 16 字节 header，再读 `frameLength-16`）。
- 服务端按 `cfg.performance.snapshotIntervalMs`（自适应，80~500ms）推送新帧。
- 客户端断开须停止推送；多个客户端互不影响；慢客户端（写缓冲 > 8MB）跳过相应帧。
- 首个帧 `seq=1`，之后递增；`round` 可跳跃（服务器一帧对应多回合）。

### `POST /api/control`
请求体 JSON，响应 `{ ok: true, ... }` 或 `{ ok: false, error }`。
```jsonc
{"action":"start"}                       // 开始/继续运行
{"action":"pause"}                       // 暂停
{"action":"resume"}                      // 暂停后继续
{"action":"step","rounds":1}             // 暂停状态下单步 n 回合（默认 1）
{"action":"reset"}                       // 用当前配置重开一局（round=0）
{"action":"setConfig","patch":{...}}     // 热更新配置（部分参数需重置，响应 reset:true）
{"action":"preset","name":"million"}     // 切换预设（自动 reset）
{"action":"speed","targetRoundsPerSec":0} // 0 = 全速
{"action":"trigger","macro":"average"}   // 手动触发宏观调控 average|redistribute|disaster|dividend|subsidy|plague
{"action":"track","id":12345}            // 追踪个体
{"action":"untrack","id":12345}
```
> `setConfig` 返回值：`{ ok:true, reset:boolean, config }`。人口/初始资金/最大负债/人口上限变化时 `reset:true`。

---

## 2. 二进制帧格式（全部小端 little-endian）

```
偏移  长度  内容
0     4    u32 magic = 0x52505331（ASCII "RPS1"，LE 字节序读取）
4     4    u32 frameLength      整帧字节数（含 header）
8     4    u32 jsonLen          JSON 头字节数
12    4    u32 dataStart        sections 起始偏移 = 16 + align4(jsonLen)
16    jsonLen  UTF-8 JSON（§3，含 sections 表）
dataStart ...  sections 依次紧密排列，每个 section 按 4 字节对齐
```

`json.sections` 数组描述数据段：
```jsonc
[ {"name":"pts","type":"f32","offset":0,"length":344064},
  {"name":"ids","type":"i32","offset":344064,"length":49152} ]
```
- `offset` 相对 `dataStart` 的**字节偏移**；`length` 是**元素个数**（不是字节数）。
- `type`: `"f32"` → `new Float32Array(buffer, dataStart + offset, length)`，`"i32"` → `Int32Array`（客户端按主机字节序；Windows/x64/ARM 小端）。

---

## 3. Snapshot JSON（帧头）

未知字段忽略；缺失字段给默认值。所有时间单位毫秒。

```jsonc
{
  "seq": 42,
  "round": 450,
  "wallTime": 1732090000000,
  "simVersion": 1,

  "engine": {
    "status": "running",            // idle | running | paused | ended
    "endReason": null,              // string|null
    "tickMs": 42.1,                 // 最近回合平均耗时
    "roundsPerSec": 23.7,
    "uptimeMs": 123456,
    "speedTarget": 0,
    "parallelWorkers": 4,           // 并行对战线程数（0=单线程）
    "shared": true                  // 是否使用 SharedArrayBuffer
  },

  "population": {
    "alive": 987654, "initial": 1000000, "capacity": 1200000,
    "births": 1234, "deaths": 456, "bankruptcies": 123,   // 累计
    "frozen": 120,
    "birthRate": 0.0012, "deathRate": 0.0005, "bankruptRate": 0.0001, // 累计/总出生或人口
    "families": 512
  },

  "wealth": {
    "total": 1.2e9, "mean": 1215, "median": 1000, "p90": 3000,
    "max": 99999, "min": -500,
    "gini": 0.42,                    // 近似基尼系数 [0,1]
    "lorenz": [0,0, 0.02,0.004, ...], // 51 个点，x,y 交替
    "histogram": { "bins": 128, "counts": [ ... ] },  // counts 由 hist section 提供，此处可省略
    "classWealthShare": [0.12,0.40,0.30,0.18],
    "negativeShare": 0.05
  },

  "strategy": {
    "usage": [0.34,0.33,0.33],        // 本回合实际出拳占比 [石头,剪刀,布]
    "preference": [0.33,0.33,0.33],   // 全体平均策略概率
    "dominant": [0.30,0.34,0.36],     // 主导拳种为 石/剪/布 的个体占比
    "entropy": 1.09                   // 平均策略熵（0..ln3≈1.0986）
  },

  "classes": [                        // 4 个阶层，id 0=底层 1=中层 2=上层 3=顶层
    {"id":0,"name":"底层","count":123,"share":0.12,"wealthShare":0.05,"flowIn":12,"flowOut":30},
    ...
  ],
  "classFlow": {"up":80,"down":140,"stay":9800,"total":10020,"mobility":0.022}, // 自上一帧以来的阶层流动

  "guilds": {                          // 公会模式（enabled=false 时仍返回该对象，榜单为空）
    "enabled": false, "total": 32, "wars": 0, "treasuryTotal": 0, "avgLevel": 0,
    "topWealth": [{"id":0,"name":"青龙会","level":3,"members":210,"treasury":12345,"memberAssets":456789,"totalWealth":469134,"wins":4}],
    "topMembers": [{"id":0,"name":"青龙会","level":3,"members":210,"treasury":12345,"wins":4}],
    "topWars":    [{"id":0,"name":"青龙会","level":3,"members":210,"wins":4}]
  },

  "talents": [120, 150, 140, 130, 160, 110],   // 6 个天赋的存活个体数

  "series": {                          // 时间序列（UI 采样到 ≤600 点，升序）
    "round": [1,2,3,...],
    "alive": [ ... ], "births": [ ... ], "deaths": [ ... ], "bankruptcies": [ ... ],
    "totalWealth": [ ... ], "meanWealth": [ ... ], "gini": [ ... ],
    "rock": [ ... ], "scissors": [ ... ], "paper": [ ... ],   // 主导拳种占比
    "class0": [ ... ], "class1": [ ... ], "class2": [ ... ], "class3": [ ... ] // 阶层人数
  },

  "families": {
    "topWealth": [{"id":3,"name":"赵家","wealth":123456,"members":88,"avgWealth":1402,"generation":12}],
    "topSize":   [{"id":7,"name":"李家","wealth":90000,"members":120}],
    "topGeneration":[{"id":7,"name":"李家","generation":18,"members":120}],
    "familyCount": 512, "totalMembers": 987654
  },

  "events": [{"round":450,"type":"macro.disaster","title":"随机灾难","detail":"20% 个体资产缩水 30%","delta":-12345678}],

  "inflation": {"factor": 1.05, "cost": 10.5, "baseCost": 10},
  "resource":  {"enabled": false, "pool": 0, "created": 0, "destroyed": 0},
  "plague":    {"enabled": false, "active": false, "infected": 0, "infectedShare": 0, "antibodies": 0.02},

  "tracked": [                          // 引擎追踪的个体（最多 8 个）
    {"id":123,"name":"#123","asset":1234.5,"age":88,"alive":true,"classId":1,
     "talentId":3,"talentName":"生育达人","strategy":[0.4,0.3,0.3],
     "wins":40,"losses":30,"draws":5,"reproCount":2,"generation":3,
     "family":{"id":7,"name":"李家"},"parents":[12,13],
     "history":[[1,0],[2,10.5], ...]}   // [round, asset] 最多 240 点
  ],

  "endCondition": {"mode":"C","label":"回合 450 / 2000","progress":0.225,"ended":false},

  "perf": {
    "analyticsMs": 6.2, "frameBytes": 512345, "sampleCount": 49152,
    "heapUsedMB": 512, "aliveScanMs": 2.1
  },

  "sections": [ {"name":"pts","type":"f32","offset":0,"length":344064} ]
}
```

---

## 4. sections 数据段定义

| name | type | 格式 | 说明 |
|---|---|---|---|
| `pts` | f32 | 每点 7 个 float：`[laneX, wealthY, classId, talentId, streakNorm, stratX, stratY]` | 采样个体点云 |
| `ids` | i32 | 每点 1 个 int | 与 pts 顺序对应的稳定个体 ID（点击追踪用） |
| `hist` | f32 | 128 个计数 | 资产直方图（f(a) 等宽箱，见 §5） |
| `strategyGrid` | f32 | `w*h` 个计数，行优先 | 策略空间密度网格 |
| `strategyGridWealth` | f32 | `w*h` 个累加值 | 同格 `wealthY` 之和（用于按平均资产着色） |

网格尺寸/映射在 `json` 中补充：`"grids": {"strategy":{"w":192,"h":160},"sampleCount":49152}`。
- 策略空间坐标：`stratX = p_paper + 0.5*p_scissors` ∈[0,1]；`stratY = p_scissors*0.8660254` ∈[0,0.866]。
- 网格映射：`gx = floor(stratX*w)`, `gy = floor(stratY/0.8660254*h)`，行优先索引 `gy*w+gx`（gy=0 在底部）。
- 画布映射建议：`canvasX = stageLeft + stratX * stageW`，`canvasY = stageBottom - (stratY/0.866) * stageH`（三角形顶点：石=(0,底), 布=(1,底), 剪=(0.5,顶)）。

## 5. 财富轴映射（pts 的 laneX / wealthY）

```js
f(a)   = Math.sign(a) * Math.log10(1 + Math.abs(a))
fLo    = f(-maxDebt * 1.5)
fHi    = f(initialWealth * 1000)
wealthY = clamp((f(asset) - fLo) / (fHi - fLo), 0, 1)   // 0 = 底部（最穷/负债），1 = 顶部（巨额财富）
laneX   = hashLane(id, 1024)                             // [0,1) 固定泳道（个体横向位置终身不变）
```
> 财富天际线视图：x = laneX（固定），y = wealthY（随资产浮动），配合直方图/洛伦兹曲线展示分布形态。

## 6. 颜色约定（前端调色板，与 config.js 一致）

```js
CLASS_COLORS  = ['#5b6b8c','#3fa7d6','#f5b942','#ff5d73'];       // 底层/中层/上层/顶层
TALENT_COLORS = ['#7f8c9b','#f7d343','#42d392','#ff9f43','#5b8cff','#c56cf0'];
MOVE_COLORS   = ['#5b8cff' /*石头*/, '#42d392' /*剪刀*/, '#f5b942' /*布*/];
```
主题：深色背景（#0b0f17 ~ #121826），面板 #141b27，主强调色 #54d3ff / #7c5cff，文字 #e7edf7，次要文字 #8fa0b8。
**

## 7. 前端性能要求（硬性）

1. **不逐帧重建 DOM 树**：所有面板节点初始化时一次性创建；每帧只更新 `textContent`/属性；表格用行复用 diff；更新节流 ≥ 80ms。
2. **WebGL2**：点云用单个 `drawArrays(POINTS)`（顶点着色器内做坐标变换），密度热图用一个全屏 quad + 浮点/字节纹理；不要每帧重建 program/buffer，用 `bufferSubData`/`texSubImage2D` 复用。
3. **Canvas2D 图表**：只在收到新帧时重绘（rAF 合批），圆角/阴影在低性能时关闭；像素比按 `min(devicePixelRatio, 2)`。
4. 主线程不得因解析/渲染阻塞输入：单帧解析 + 渲染合计目标 < 8ms（100 万人口、4.9 万采样点场景）。
5. 无第三方库，原生 ESM；`index.html` 内联关键样式可用，但 JS 分模块。

## 8. 前端布局与视觉规格（UI）

> 详见 `docs/UI-SPEC.md`。要点：顶部状态栏 + 左参数栏 + 中央 WebGL 主舞台（策略星系 / 财富天际线 双视图切换）+ 右侧指标/图表栏 + 底部性能与事件栏；深色科技风；中文界面；1280×800 起自适应。
