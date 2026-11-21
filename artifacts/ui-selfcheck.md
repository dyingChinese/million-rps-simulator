# Web UI 最终自检报告（无浏览器环境下的可执行验收）

- 项目：百万猜拳演化模拟器 · `web/` 实时可视化控制台（纯原生 ESM + WebGL2 + Canvas2D，零构建 / 零依赖 / 无 CDN）
- 完成时间：2026-11-20 19:30（Asia/Shanghai）
- 结论：**功能与协议层全部自检通过；浏览器截图验收受沙箱限制无法在本会话执行（已由 Lead 确认同环境不可行），改以 4 层可执行自检 + 真实后端端到端联调替代。**
- 人工视觉验收入口（真实服务端已托管 `web/`）：
  - mock 演示（不依赖后端）：<http://127.0.0.1:8080/?mock=1>
  - 页面内自检（自动断言并在页面右上角显示绿色/红色浮层）：<http://127.0.0.1:8080/?selftest=1>
  - 真实联调：<http://127.0.0.1:8080/>（连 `/api/stream`）
  - 本地静态服务（可选）：`node scripts/serve-web.js` → <http://127.0.0.1:8090/?mock=1>

## 1. 截图受限说明（重要）

本会话的 Windows 沙箱禁止子进程创建命名管道，无头 Edge 无法启动，实测证据：

```
[FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : 拒绝访问。 (0x5)
```
- 直接 `& msedge.exe --headless=new --screenshot=...`：DSH 沙箱报 `\\.\pipe\LOCAL\dotnet_... denied`
- 改 `Start-Process` + 文件重定向后 Edge 进程可起，但 Chromium 内部 mojo IPC 管道被拒（上一条 FATAL），无法出图
- 已尝试 `--no-sandbox --single-process --no-zygote --in-process-gpu --disable-breakpad --enable-features=NetworkServiceInProcess` 等组合，均失败
- `wkhtmltoimage` 同样受管道限制，且为 QtWebKit（不支持 ESM / WebGL2 / CSS Grid），无法验证真实页面
- Lead 已确认其会话同样无法运行无头 Edge，且明确不要用 schtasks/WMI 绕过

因此本报告给出的是**可复现的执行证据**，而不是截图。视觉层面的最终确认请在带浏览器的机器上打开上面的 URL 人工过目。

## 2. 交付文件清单（仅写 web/；截图目录 artifacts/ 用于报告）

| 文件 | 说明 |
|---|---|
| `web/index.html` | 结构 + 内联关键 CSS（骨架防闪烁）+ ESM 入口 |
| `web/css/style.css` | 深色科技风主题、CSS Grid 布局、全部组件样式、响应式（1600 / 1440 / 1280） |
| `web/js/app.js` | 入口：真实/mock 连接、控制指令、rAF 合批循环、状态管理、错误兜底 |
| `web/js/protocol.js` | 二进制帧解析（零拷贝 TypedArray 视图）、FrameReader 流切分（拆包/粘包/坏帧重同步）、节流、`encodeFrame`、财富轴映射 |
| `web/js/glview.js` | WebGL2 双视图（策略星系 / 财富天际线）、单点云 drawArrays + 单 quad 热图、bufferSubData/texSubImage2D 复用、缩放/平移/双击复位/点击就近采样 |
| `web/js/charts.js` | Canvas2D：直方图（中位/P90 标线）、洛伦兹+基尼、时间序列（4 指标）、策略堆叠面积、阶层双横条、追踪 sparkline |
| `web/js/panels.js` | 顶栏 / 左参数栏（7 组 + 宏观调控，参数名与 `src/core/config.js` 一一对应）/ 右数据栏（10 区）/ 底栏 HUD，全部预创建 + 增量更新 + 行池复用 |
| `web/js/format.js` | 数字/百分比/万·亿/耗时/字节格式化（`—` 兜底，不出现 NaN） |
| `web/js/mock.js` | `?mock=1` 本地合成帧源：与真实 schema 完全一致（含全部 sections + JSON 字段），缓慢演化的策略/财富/阶层/家族/事件，支持全部控制指令与追踪 |
| `web/js/selftest.js` | 页面内自检套件（`?selftest=1`），21 项断言 + 绿/红结果浮层，同时被 Node 端复用 |

额外验收辅助（Lead 明确许可）：`test/web-stub.test.js`（Node 端验收自检，4 组测试）、`test/web-dom-stub.js`（最小 DOM/Canvas2D/WebGL2 桩，从真实 `web/index.html` 解析骨架）。

## 3. 自检证据

### 3.1 Node 端桩自检（`node test/web-stub.test.js`）—— 4/4 通过

本沙箱 `node --test` 会 spawn 子进程被拒（EPERM），因此测试文件用 `node:test` 直接进程内运行。

| # | 测试 | 结果 |
|---|---|---|
| 1 | mock 模式完整运行（协议 / 面板 / 图表 / WebGL / 节流 / 追踪 / 视图） | ✅ |
| 2 | FrameReader 任意 chunk 边界拆包 / 粘包 / 坏 magic 重同步 | ✅ |
| 3 | 真实模式：`/api/config` + 分块二进制流 + 断线指数退避重连（假 HTTP 服务） | ✅ |
| 4 | `?selftest=1` 页面内自检自动执行并显示绿色浮层 | ✅ |

测试 1 覆盖项（全部通过）：
- 二进制帧 sections 与 meta 一致：`pts = 7×sampleCount`、`ids = sampleCount`、`hist = 128`、`strategyGrid = w×h`
- 采样点数值范围（laneX/wealthY∈[0,1]、classId∈[0,3]、streakNorm∈[-1,1]、stratX∈[0,1]、stratY∈[0,0.866]）
- 时间序列 / 洛伦兹 51 点 / 家族榜 / 事件流非空
- 参数控件 53 个（覆盖 config.js 界面字段）
- DOM 节点 778 个一次性创建（无每帧重建）
- KPI 6 项有真实值、家族表 11 行、事件 10 行、状态徽章有文本
- 数值节点 83 个无 NaN / undefined / Infinity
- 5 个 Canvas2D 图表均有绘制指令（958 / 1224 / 296 / 621 / 180 ops）且坐标参数全部有限
- WebGL2：仅 2 个 program；**每帧 1 次 quad drawArrays + 1 次点云 drawArrays**（30 帧 30+30 次）
- buffer/纹理复用：`bufferData×2`（初始+扩容）、`texImage2D×2`（1×1 占位+首帧尺寸）、`bufferSubData`/`texSubImage2D` 逐帧复用
- DOM/图表更新节流：最小间隔 **91.4ms**（要求 ≥80ms）
- 点击追踪 → 追踪卡出现 → 取消追踪 → 卡片移除
- 策略星系 ↔ 财富天际线 双视图切换正常
- 页面内自检套件（selftest.js）21 项全部通过

### 3.2 页面内自检 `?selftest=1`（web/js/selftest.js）—— 21 项通过 / 0 失败 / 0 跳过

| 分类 | 断言项 |
|---|---|
| 协议（5） | 已收到最新帧；sections 长度与 meta 一致；采样点数值范围合法；JSON 关键字段齐全（含洛伦兹/时间序列）；追踪个体结构合法 |
| 演化/性能（2） | mock 数据缓慢演化（回合推进、帧数增长）；单帧解析 <8ms 预算 |
| 节流（1） | DOM/图表更新最小间隔 ≥80ms（实测 ~90ms） |
| WebGL（4） | 每帧仅 2 个 draw call；buffer/纹理复用（不逐帧重建）；点云/纹理尺寸有效；`readPixels` 画布像素非空 |
| 面板（3） | 参数控件 ≥28；KPI/家族表/事件/状态有真实文本；无 NaN/undefined 文本泄漏 |
| 图表（2） | 5 个图表 Canvas 尺寸有效；`getImageData` 像素非空（非空白） |
| 布局（1） | 五区尺寸合理（顶栏 56 / 左 300 / 中 940×810 / 右 360 / 底 34）、无横向溢出 |
| 交互（3） | 追踪个体 → 追踪卡出现；取消追踪 → 卡片移除；双视图切换 |
| 报告展示 | 顶部浮层绿色「自检通过 21 项」/ 红色失败清单；`window.__RPS_SELFTEST__` 可读取结构化结果 |

### 3.3 真实后端端到端联调（`http://127.0.0.1:8080`，百万人口预设）

用 Node DOM 桩启动**真实前端 app.js（真实模式）**连真实服务端，完整链路验证：

| 项目 | 实测结果 |
|---|---|
| `/api/config` | 加载成功（presets / classNames / 版本），参数面板回填 |
| 真实帧 | `2,360,580 B`，`sampleCount=65,536`，grid `192×160`，hist `128`；`seq=38 / round=50` |
| sections 校验 | `pts=7×65536`、`ids=65536`、`strategyGrid=192×160`、`hist=128` 全部正确 |
| 首屏 KPI | 98.94 万 / 8.54 亿 / 863 / 0.445 / 10.1 / 0.962·1.099（真实帧驱动） |
| 图表绘制 | hist 681 ops、lorenz 952、series 878、stacked 3398、class 126 ops（真实数据） |
| WebGL | 2 个 program；每帧 2 draw call；65,536 点云；`bufferSubData` 逐帧、`texSubImage2D` 逐帧 |
| 性能 | 解析 **0.30ms** / 上传 **0.62ms**（合计 <1ms，预算 8ms） |
| 点击追踪 | `POST /api/control {action:"track",id:5}` → 右栏追踪卡出现（资产/年龄/天赋/代数/策略/胜平负/sparkline 17 ops）→ untrack 后卡片移除 |
| 控制指令 | pause / resume / step / speed / setConfig / preset / trigger / track / untrack 响应均 `{ok:true}`，UI 状态同步 |
| 暂停态 | 真实引擎暂停后不再推帧；UI 使用「乐观状态」立即显示「已暂停」并正确禁用按钮 |
| 并行 HUD | 底栏显示「并行 4 线程」（来自 `json.engine.parallelWorkers`）、「分析 0.2~2ms」（`json.perf.analyticsMs`） |
| 静态托管 | 真实服务端直接托管 `web/`：`GET /?mock=1` → 200；全部 JS/CSS MIME 正确 |

### 3.4 Lead 的跨端协议一致性测试

`node scripts/test-ui-protocol.js --url http://127.0.0.1:8080` → **24 项全部通过**（encode/parse 往返、mock 帧、与真实 1M 服务端 `/api/frame` 的 schema/sections 对比）。

### 3.5 静态服务与资源

`node scripts/serve-web.js`（8090）实测：`/`、`/index.html`、`/css/style.css`、7 个 `/js/*.js` 全部 200，MIME 正确（`text/javascript` / `text/css` / `text/html`），`Cache-Control: no-cache`；`index.html` 引用 `/css/style.css` 与 ESM 入口 `/js/app.js` 正确。

## 4. 性能硬指标对照（PROTOCOL §7 / UI-SPEC）

| 指标 | 要求 | 实测 |
|---|---|---|
| 单帧解析 + 上传 | < 8ms（100 万人口 / 4.9 万采样） | 真实帧 65,536 点：解析 0.30ms + 上传 0.62ms ≈ **0.92ms** |
| WebGL draw call | 点云单次 + 热图单次 | 每帧恰好 **2** 次 `drawArrays`（POINTS + TRIANGLE_STRIP） |
| buffer/纹理复用 | 不逐帧重建 | `bufferData` 仅初始化/扩容；`bufferSubData`/`texSubImage2D` 逐帧；program 仅 2 个 |
| DOM 更新节流 | ≥80ms + rAF 合批 | 90ms 节流（实测最小间隔 90.0~92ms），全部在 rAF 内合批 |
| DOM 重建 | 禁止 innerHTML 每帧重建 | 全程 0 次 innerHTML；预创建 + textContent 增量 + 行池复用 |
| 表格/事件池 | 行池复用 | 家族表 10 行池、事件流 10 行池、追踪卡按 id 增量增删 |
| 图表重绘 | 只在 rAF 中按需 | 与 DOM 同一节拍（≤11Hz），无独立定时器 |
| 依赖/构建 | 零第三方、零构建、无 CDN | 纯 ESM 静态文件，无 import 外部 URL |

## 5. 已知问题 / 注意事项

1. **无法提供浏览器截图**（沙箱限制，见 §1）。`artifacts/` 下没有伪造截图；视觉验收请人工打开 §首部 URL。
2. **真实服务端 `/api/stream` 首帧边界情况**：若连上时引擎处于 `paused/ended` 且服务端尚未广播过任何帧（`latestFrame === null`），服务端不会主动发初始帧，UI 会显示「等待数据」直到下一次 tick；建议服务端在 `/api/frame` 取帧后缓存 `latestFrame`，或在 stream 连接时主动向 worker 请求一帧。UI 侧已有 6s 后顶部提示「仍没有收到数据帧」且保持重连，不会崩溃。
3. `?mock=1` 使用 20,000 采样点（帧 ~0.89MB）以保证演示流畅；真实服务端为 65,536 采样点（帧 ~2.36MB）。schema 与 sections 布局完全一致。
4. mock 的默认配置已按 Lead 最新 `src/core/config.js` 同步（`macro.dividend`、`macro.average`、`genetics.birthCostRatio=0.05`、新增 `parallel`），并显示并行 HUD。
5. 真实服务端在本报告联调结束时被留在 **paused、round ~66、百万人口** 状态（测试会 resume/pause）；需要演示请再 `POST /api/control {"action":"start"}` 或 `{"action":"reset"}`。
6. 本沙箱 `node --test` 因需 spawn 子进程会被拒绝运行测试；请用 `node test/web-stub.test.js` 直接运行（进程内 `node:test`）。
7. 布局按 1600×900 / 1440×900 / 1280×800 设计并做响应式（左栏 300→272→246、右栏 360→340→318），中央舞台在 1440 下 ≥800×740、1280 下 ≥690×664，满足 UI-SPEC「1440 下中央舞台 ≥700×600、1280 可用」。

## 6. 复现命令

```bash
# 1) mock 模式前端自检（无需后端）
node test/web-stub.test.js

# 2) 真实后端协议一致性（Lead 提供）
node scripts/test-ui-protocol.js --url http://127.0.0.1:8080

# 3) 本地静态服务 + 浏览器人工验收（在带浏览器的机器上）
node scripts/serve-web.js
#   打开 http://127.0.0.1:8090/?mock=1
#   打开 http://127.0.0.1:8090/?selftest=1  （右上角应显示绿色「自检通过 21 项」）

# 4) 真实模式（服务端已托管 web/）
#   打开 http://127.0.0.1:8080/
```

---

# 第 2 轮扩展（公会排行 + 阶层流动）自检追加

- 时间：2026-11-20 20:10（Asia/Shanghai）
- 范围：右栏「公会排行 GUILDS」、阶层结构流动率、左栏「公会模式」参数组、mock 公会/流动数据、selftest 扩充。
- 截图仍不可用（沙箱限制，同文首 §1），本文件继续作为可执行验收证据。

## 改动文件
`web/js/protocol.js`、`web/js/mock.js`、`web/js/panels.js`、`web/js/selftest.js`、`web/js/format.js`、`web/css/style.css`；测试 `test/web-stub.test.js`。`app.js` / `glview.js` / `charts.js` 无改动。

## 自检结果（全部通过）
1) `node test/web-stub.test.js` → **4/4 子测试通过**；mock 主测试共 **21 项独立断言**（含第 2 轮新增 4 项）：
   - mock 帧包含 `guilds / classFlow / classes.flowIn・flowOut`（32 公会、平均等级、金库、团体战；流动率 ∈ [0,1]）
   - 公会排行 / 阶层流动 DOM 已渲染（公会表含表头 11 行、等级 chip `LvN`、摘要 4 项、4 行「流入 X · 流出 Y」、流动率百分比）
   - mock `setConfig` 公会参数热更新（count 32→16 后榜单重建）
   - mock 关闭公会 → 显示「未开启（在参数面板开启公会模式）」占位、公会表隐藏
2) 页面内自检 `?selftest=1` → **25 项通过 / 0 跳过 / 0 失败**（原 21 项 + 新增 4 项：guilds/classFlow 协议结构、格式化回归、公会面板渲染/占位、阶层流动明细）
3) 真实模式（fake HTTP 服务 + 含 guilds/classFlow 的帧）→ 真实 `app.js` 路径下公会表 11 行、等级 chip、流动率正常渲染；分块流与断线重连仍通过
4) 旧后端容错（8080 未集成字段的真实帧）→ 公会显示未开启占位、阶层流动显示 `0%` / 流入 0 · 流出 0、无 NaN、无异常，其余面板正常（真实 E2E 实测）
5) 修复显示回归 bug：`format.js trimNum` 在整数尾部全零时输出 `100. 万` / `0.%`（孤立小数点）；新增格式化断言与 UI 文本正则检查，防止复发

## 协议一致性（Lead 的 `scripts/test-ui-protocol.js`）
- A/B 组（编解码往返 + mock 帧）全部通过；mock 快照无缺失字段；
- C 组真实侧 3 项失败：`真实快照无缺失字段 → classFlow,guilds`、`真实 classFlow 合法`、`真实 guilds 结构合法` —— **仅因当前 8080 进程尚未重启加载 Lead 的 guilds/classFlow 集成代码**；前端已按 PROTOCOL §3 实现并对字段缺失容错，后端重启后预期全绿。

## 新增 UI 说明
- 公会摘要：公会数 / 平均等级 / 金库总额 / 团体战次数；三视图 Tab：资产 / 人数 / 胜场；表格列：排名、公会、等级 Lv（彩色 chip 分档 1-3 / 4-6 / 7-8 / 9-10）、人数、金库、总资产(W)、胜场。
- 阶层结构：新增「上移 / 下移 / 流动率」chips；4 阶层明细每行下方显示「流入 X · 流出 Y」。
- 左栏新增「公会模式」参数组（13 项，与 `cfg.guilds` 一一对应），并把 `macro.subsidy.countPct` 补进保底行；参数控件总数 53 → **64**。
- mock 默认配置与 `src/core/config.js` 已全量对齐（唯一有意差异：mock `guilds.enabled=true` 便于演示）。

## 已知问题
- 真实后端 8080 仍是集成前进程；需 Lead 重启后再跑一次 `node scripts/test-ui-protocol.js --url http://127.0.0.1:8080`，并做真实模式人工验收（`http://127.0.0.1:8080/?selftest=1`）。
- 视觉验收仍需人工在浏览器中确认（本沙箱无法截图）。
