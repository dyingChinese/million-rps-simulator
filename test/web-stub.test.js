/**
 * test/web-stub.test.js — 前端无浏览器验收自检
 *
 * 背景：本机 DSH 沙箱禁止 Edge 创建命名管道（mojo platform_channel 0x5），
 * 无法用无头浏览器截图验收。此测试在 Node 中用最小 DOM / Canvas2D / WebGL2 桩
 * （test/web-dom-stub.js，从真实 web/index.html 解析骨架）真实执行 web/js 全部模块：
 *  1) mock 模式完整启动：协议 sections / 采样点范围 / 面板数据 / 5 个 Canvas2D 图表 /
 *     WebGL 仅 2 个 draw call / bufferSubData + texSubImage2D 复用 / DOM 节流 ≥80ms /
 *     点击追踪 → 追踪卡 → 取消 / 双视图切换 / 页面内自检套件全通过；
 *  2) FrameReader 任意 chunk 边界拆包、粘包、坏 magic 重同步；
 *  3) 真实模式：假 HTTP 服务模拟 /api/config + 分块二进制流 + 断线指数退避重连；
 *  4) ?selftest=1 页面内自检自动执行并显示绿色浮层。
 *
 * 运行：node test/web-stub.test.js（本沙箱不支持 node --test 的 spawn 子进程）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { installDomStub, nativeFetch } from './web-dom-stub.js';
/* ────────────────────────────── 测试主体 ────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('web 前端（mock 模式）在 Node 桩环境中完整运行且满足性能/协议契约', async (t) => {
  const stub = installDomStub();
  let app = null;
  try {
    // 动态导入：app.js 启动即 boot()（mock=1 由 location.search 决定）
    await import('../web/js/app.js');
    app = globalThis.window.__RPS_APP__;
    assert.ok(app, 'app.js 应在 window.__RPS_APP__ 暴露调试句柄');

  // 等待 mock 帧到达（130ms/帧，最多 6s）
  for (let i = 0; i < 120 && app.state.frames < 4; i++) await sleep(50);
  assert.ok(app.state.frames >= 4, `应有至少 4 帧，实际 ${app.state.frames}`);
  assert.equal(stub.errors.length, 0, '启动期间不应有未捕获异常: ' + (stub.errors[0] && stub.errors[0].stack));

  const frame = app.state.latestFrame;
  assert.ok(frame && frame.snap, '最新帧应解析成功');

  const report = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      report.push({ ok: true, name, detail: detail || '' });
    } catch (err) {
      report.push({ ok: false, name, detail: (err && err.message) || String(err) });
      throw new Error(`[自检失败] ${name}: ${(err && err.message) || err}`);
    }
  };

  /* ---------- 1. 协议 ---------- */
  check('sections 长度与 meta 一致', () => {
    const pts = frame.sections.pts;
    const ids = frame.sections.ids;
    assert.ok(pts && ids, 'pts/ids section 缺失');
    assert.equal(pts.length, frame.meta.sampleCount * 7, 'pts 元素数应为 sampleCount×7');
    assert.equal(ids.length, frame.meta.sampleCount, 'ids 元素数应等于 sampleCount');
    assert.equal(frame.sections.hist.length, 128, 'hist 应为 128 箱');
    assert.equal(frame.sections.strategyGrid.length, frame.meta.gridW * frame.meta.gridH, 'strategyGrid 尺寸应匹配 grids');
    assert.ok(frame.sections.strategyGridWealth.length === frame.meta.gridW * frame.meta.gridH, 'strategyGridWealth 尺寸应匹配');
    return `${frame.byteLength} B / ${frame.meta.sampleCount} 点 / 网格 ${frame.meta.gridW}×${frame.meta.gridH}`;
  });

  check('采样点数值在协议范围内', () => {
    const pts = frame.sections.pts;
    const count = Math.min(4000, frame.meta.sampleCount);
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      assert.ok(pts[o] >= 0 && pts[o] <= 1, 'laneX 越界');
      assert.ok(pts[o + 1] >= 0 && pts[o + 1] <= 1, 'wealthY 越界');
      assert.ok(pts[o + 2] >= 0 && pts[o + 2] <= 3, 'classId 越界');
      assert.ok(pts[o + 5] >= -0.001 && pts[o + 5] <= 1.001, 'stratX 越界');
      assert.ok(pts[o + 6] >= -0.001 && pts[o + 6] <= 0.8661, 'stratY 越界');
    }
    return `抽查 ${count} 点全部合法`;
  });

  /* ---------- 2. 演化 ---------- */
  await sleep(420);
  check('mock 数据在缓慢演化', () => {
    const f2 = app.state.latestFrame;
    assert.ok(app.state.frames > 4, '等待后应有更多帧');
    assert.ok(f2.round > frame.round, `回合应推进: ${frame.round} → ${f2.round}`);
    return `回合 ${frame.round} → ${f2.round}`;
  });
  check('时间序列 / 洛伦兹 / 家族 / 事件有数据', () => {
    const snap = app.state.latestFrame.snap;
    assert.ok(snap.series.alive.length >= 3, '时间序列点不足');
    assert.ok(snap.wealth.lorenz.length >= 20, '洛伦兹点不足');
    assert.ok(snap.families.topWealth.length >= 5, '家族排行数据不足');
    assert.ok(snap.events.length >= 1, '事件流为空');
    return `series=${snap.series.alive.length} / lorenz=${snap.wealth.lorenz.length / 2} / 家族=${snap.families.topWealth.length} / 事件=${snap.events.length}`;
  });

  /* 第 2 轮新增：公会与阶层流动数据结构 */
  check('mock 帧包含 guilds / classFlow / flowIn・flowOut', () => {
    const snap = app.state.latestFrame.snap;
    const g = snap.guilds;
    assert.ok(g, '缺少 guilds');
    assert.equal(g.enabled, true, 'mock 公会应默认开启');
    assert.ok(g.total >= 8, `公会数 ${g.total}`);
    assert.ok(g.topWealth.length >= 5, `公会资产榜 ${g.topWealth.length} 行`);
    for (const row of g.topWealth) {
      for (const k of ['level', 'members', 'treasury', 'totalWealth', 'wins']) {
        assert.ok(Number.isFinite(row[k]), `公会行 ${row.name}.${k} 非有限数`);
      }
    }
    assert.ok(Number.isFinite(g.avgLevel) && Number.isFinite(g.treasuryTotal), '公会摘要字段非有限数');
    const cf = snap.classFlow;
    assert.ok(cf && Number.isFinite(cf.up) && Number.isFinite(cf.down), 'classFlow 字段缺失');
    assert.ok(cf.mobility >= 0 && cf.mobility <= 1, `流动率越界: ${cf.mobility}`);
    const sumFlow = snap.classes.reduce((a, c) => a + c.flowIn, 0);
    assert.ok(sumFlow >= 0 && Number.isFinite(sumFlow), 'classes.flowIn 非法');
    const allFlowOut = snap.classes.reduce((a, c) => a + c.flowOut, 0);
    assert.ok(Number.isFinite(allFlowOut), 'classes.flowOut 非法');
    return `公会=${g.total} 个/Lv ${g.avgLevel}/金库 ${Math.round(g.treasuryTotal)}/战 ${g.wars} · 流动率=${cf.mobility.toFixed(4)}（上移${cf.up} 下移${cf.down}）`;
  });

  /* ---------- 3. 面板 ---------- */
  const panels = app.panels;
  assert.ok(panels, 'panels 实例应存在');
  check('参数控件数量覆盖 config.js 字段', () => {
    const n = panels.getFieldCount();
    assert.ok(n >= 60, `参数控件仅 ${n} 个（应含第 2 轮新增的公会模式参数组）`);
    return `${n} 个`;
  });
  check('DOM 节点已一次性创建（非每帧重建）', () => {
    const count = panels.snapshotDomCounts();
    assert.ok(count > 450, `DOM 节点仅 ${count}，面板未完整构建`);
    return `${count} 个节点`;
  });
  check('KPI / 家族表 / 事件行有真实文本', () => {
    const kpis = stub.doc.querySelectorAll('.kpi .k-value').map((n) => n.textContent.trim());
    assert.equal(kpis.length, 6, 'KPI 应为 6 张');
    assert.ok(kpis.every((v) => v && v !== '—' && !v.includes('NaN')), 'KPI 存在空值/NaN: ' + JSON.stringify(kpis));
    const famRows = stub.doc.querySelectorAll('.fam-row').length;
    assert.ok(famRows >= 11, `家族表行数 ${famRows}`);
    const evRows = stub.doc.querySelectorAll('.event-row').length;
    assert.ok(evRows >= 5, `事件行数 ${evRows}`);
    const statusText = stub.doc.querySelector('#status-badge .sb-text').textContent.trim();
    assert.ok(statusText.length > 0, '状态徽章为空');
    return `KPI=${kpis.join(',')} / 家族行=${famRows} / 事件行=${evRows} / 状态=${statusText}`;
  });
  check('数值节点无 NaN / undefined 泄漏', () => {
    const nodes = stub.doc.querySelectorAll('.k-value, .k-sub, .hud-v, .tc-v, .fam-row span, .guild-row span, .gs-v, .cr-flow, .cf-v');
    const bad = nodes.map((n) => n.textContent.trim()).filter((v) => /NaN|undefined|Infinity/.test(v));
    assert.equal(bad.length, 0, '异常文本: ' + bad.slice(0, 5).join(' | '));
    return `检查 ${nodes.length} 个节点`;
  });
  check('公会排行 / 阶层流动 DOM 已渲染', () => {
    const guildRows = stub.doc.querySelectorAll('.guild-table .guild-row');
    assert.ok(guildRows.length >= 11, `公会表行数 ${guildRows.length}`);
    const dataRows = guildRows.slice(1);
    for (const row of dataRows) {
      const name = row.children[1] ? row.children[1].textContent.trim() : '';
      assert.ok(name && name !== '—', '公会名称列为空');
    }
    const levels = stub.doc.querySelectorAll('.guild-lv').map((n) => n.textContent.trim());
    assert.ok(levels.length >= 10 && levels.every((v) => /^Lv\d+$/.test(v)), '公会等级 chip 异常: ' + JSON.stringify(levels.slice(0, 3)));
    const summary = stub.doc.querySelectorAll('.gs-v').map((n) => n.textContent.trim());
    assert.equal(summary.length, 4, '公会摘要应为 4 项');
    assert.ok(summary.every((v) => v && v !== '—'), '公会摘要存在空值');
    const flowTexts = stub.doc.querySelectorAll('.cr-flow').map((n) => n.textContent.trim());
    assert.equal(flowTexts.length, 4, '阶层流动明细应为 4 行');
    assert.ok(flowTexts.every((t) => t.includes('流入') && t.includes('流出')), '阶层明细缺少流入/流出');
    const mobility = stub.doc.querySelector('.class-flow .cf-mob .cf-v').textContent.trim();
    assert.ok(/%$/.test(mobility), '流动率未显示百分比: ' + mobility);
    return `公会 ${dataRows.length} 行 / 摘要 ${summary.join(' ')} / 等级 ${levels[0]} / 流动率 ${mobility}`;
  });

  // 第 2 轮：公会参数热更新 + 关闭时占位路径
  await (async () => {
    const res = await app.control('setConfig', { patch: { guilds: { count: 16 } } });
    assert.ok(res && res.ok, 'setConfig(guilds.count) 失败');
    await sleep(450);
    let snap = app.state.latestFrame.snap;
    assert.equal(snap.guilds.total, 16, `公会数应更新为 16，实际 ${snap.guilds.total}`);
    assert.ok(snap.guilds.topWealth.length >= 5, '热更新后公会榜数据不足');
    report.push({
      ok: true,
      name: 'mock setConfig 公会参数热更新',
      detail: `公会数 32→${snap.guilds.total} / 榜首 ${snap.guilds.topWealth[0] && snap.guilds.topWealth[0].name}`,
    });

    const off = await app.control('setConfig', { patch: { guilds: { enabled: false } } });
    assert.ok(off && off.ok, 'setConfig(guilds.enabled=false) 失败');
    await sleep(450);
    snap = app.state.latestFrame.snap;
    assert.equal(snap.guilds.enabled, false, 'mock 公会应已关闭');
    const emptyHint = stub.doc.querySelector('.guild-panel .empty-hint');
    const guildTable = stub.doc.querySelector('.guild-table');
    assert.ok(emptyHint && !emptyHint.classList.contains('hidden'), '关闭公会时应显示未开启占位');
    assert.ok(guildTable.classList.contains('hidden'), '关闭公会时应隐藏公会表');
    report.push({ ok: true, name: 'mock 关闭公会 → 占位提示', detail: '未开启占位可见 / 公会表隐藏' });

    await app.control('setConfig', { patch: { guilds: { enabled: true, count: 32 } } });
    await sleep(400);
  })();

  /* ---------- 4. Canvas2D 图表 ---------- */
  check('5 个 Canvas2D 图表已绘制且坐标参数有限', () => {
    const classes = ['.chart-hist', '.chart-lorenz', '.chart-series', '.chart-stacked', '.chart-class'];
    const details = [];
    for (const sel of classes) {
      const cv = stub.doc.querySelector(sel);
      assert.ok(cv, '缺少图表画布 ' + sel);
      assert.ok(cv.width > 0 && cv.height > 0, `${sel} 画布尺寸无效`);
      const ctx = cv.getContext('2d');
      assert.ok(ctx.ops >= 8, `${sel} 绘制指令仅 ${ctx.ops} 条，可能空白`);
      assert.equal(ctx.invalid, 0, `${sel} 出现非法坐标 ${ctx.invalid} 次`);
      assert.ok(ctx.textOps >= 1, `${sel} 未写入任何文本（轴标签缺失）`);
      details.push(`${sel}:${ctx.ops}ops`);
    }
    return details.join(' ');
  });

  /* ---------- 5. WebGL ---------- */
  const gl = stub.glStats;
  const stageStats = app.stage.getStats();
  check('WebGL2 已初始化并上传采样点云', () => {
    assert.ok(stageStats.glOk, 'WebGL2 上下文初始化失败（桩环境不应失败）');
    assert.ok(stageStats.points > 0, '点云样本数为 0');
    assert.ok(gl.createProgram >= 2, `program 创建次数 ${gl.createProgram}，应为 2`);
    return `program=${gl.createProgram} / 点=${stageStats.points} / 纹理=${stageStats.gridW}×${stageStats.gridH}`;
  });
  check('每帧仅 2 个 draw call（1 quad + 1 点云）', () => {
    const pointsCalls = gl.drawArrays.filter((d) => d.mode === 0).length;
    const quadCalls = gl.drawArrays.filter((d) => d.mode === 5).length;
    const renders = stageStats.renders;
    assert.ok(renders >= 5, `渲染帧数 ${renders} 过少`);
    assert.ok(pointsCalls >= renders, `点云 drawArrays=${pointsCalls} < 渲染帧 ${renders}`);
    assert.ok(Math.abs(pointsCalls - renders) <= 2, `点云调用 ${pointsCalls} 与渲染帧 ${renders} 不等（应每帧 1 次）`);
    assert.ok(Math.abs(quadCalls - renders) <= 2, `quad 调用 ${quadCalls} 与渲染帧 ${renders} 不等（应每帧 1 次）`);
    return `点云 ${pointsCalls} 次 / quad ${quadCalls} 次 / 渲染 ${renders} 帧`;
  });
  check('buffer / texture 复用（bufferSubData + texSubImage2D）', () => {
    const s = stageStats;
    assert.ok(gl.bufferData <= 3, `bufferData 调用 ${gl.bufferData} 次（应仅初始化/扩容）`);
    assert.equal(gl.texImage2D, 2, `texImage2D 应只调用 2 次（1×1 占位 + 首帧尺寸），实际 ${gl.texImage2D}`);
    assert.ok(gl.bufferSubData >= 2, '未使用 bufferSubData 逐帧上传点云');
    assert.ok(gl.texSubImage2D >= 2, '未使用 texSubImage2D 逐帧更新热图');
    assert.ok(s.bufferDataCalls <= 3, 'glview 统计 bufferData 过多');
    assert.equal(s.texImageCalls, 1, 'glview 统计 texImage2D 应=1');
    return `bufferSubData=${gl.bufferSubData} / texSubImage2D=${gl.texSubImage2D} / bufferData=${gl.bufferData} / texImage2D=${gl.texImage2D}`;
  });

  /* ---------- 6. DOM 节流 ---------- */
  check('DOM/图表更新节流 ≥80ms', () => {
    const list = app.state.domUpdates;
    assert.ok(list.length >= 3, `更新次数 ${list.length} 过少`);
    let minGap = Infinity;
    for (let i = 1; i < list.length; i++) minGap = Math.min(minGap, list[i] - list[i - 1]);
    assert.ok(minGap >= 78, `最小更新间隔 ${minGap.toFixed(1)}ms < 80ms`);
    return `${list.length} 次更新，最小间隔 ${minGap.toFixed(1)}ms`;
  });

  /* ---------- 7. 追踪交互 ---------- */
  await (async () => {
    const id = frame.sections.ids[0];
    const res = await app.control('track', { id });
    assert.ok(res && res.ok !== false, 'track 指令失败');
    await sleep(400);
    const snap = app.state.latestFrame.snap;
    const tracked = snap.tracked.map((x) => x.id);
    assert.ok(tracked.includes(id), `快照 tracked 缺 #${id}`);
    assert.ok(panels.getTrackedCount() >= 1, '右栏追踪卡未创建');
    report.push({ ok: true, name: '点击追踪 → 右栏追踪卡出现', detail: `#${id}，共 ${panels.getTrackedCount()} 张卡` });
    await app.control('untrack', { id });
    await sleep(400);
    assert.equal(panels.getTrackedCount(), 0, '取消追踪后卡片未移除');
    report.push({ ok: true, name: '取消追踪 → 卡片移除', detail: '已清空' });
  })();

  /* ---------- 8. 视图切换 ---------- */
  check('双视图切换（策略星系 ↔ 财富天际线）', () => {
    app.setView('skyline');
    assert.equal(app.stage.view, 'skyline', '切换 skyline 失败');
    const skyStats = app.stage.getStats();
    assert.ok(skyStats.glOk, 'skyline 视图 WebGL 状态异常');
    app.setView('galaxy');
    assert.equal(app.stage.view, 'galaxy', '切回 galaxy 失败');
    return 'galaxy ↔ skyline 正常';
  });

  /* ---------- 9. 复用页面内自检套件 ---------- */
  const { runSelfTest } = await import('../web/js/selftest.js');
  const selftestReport = await runSelfTest({
    state: app.state,
    stage: app.stage,
    panels: app.panels,
    control: app.control,
    setView: app.setView,
  });
  const failedItems = selftestReport.items.filter((it) => it.status === 'fail');
  assert.equal(failedItems.length, 0, '页面内自检存在失败项: ' + failedItems.map((f) => `${f.name}: ${f.detail}`).join(' | '));
  // 自检项数动态校验（第 2 轮新增断言后应 ≥24；不使用硬编码“通过 21 项”）
  assert.ok(
    selftestReport.total >= 24,
    `页面内自检项数 ${selftestReport.total}，应随新增断言增长（≥24）`,
  );
  assert.equal(
    selftestReport.passed + selftestReport.skipped,
    selftestReport.total,
    '通过+跳过应等于总项数（失败为 0）',
  );
  report.push({ ok: true, name: '页面内自检套件（selftest.js）', detail: `共 ${selftestReport.total} 项 · 通过 ${selftestReport.passed} / 跳过 ${selftestReport.skipped} / 失败 0` });

  /* ---------- 收尾：打印清单 ---------- */
  t.diagnostic('──── 前端桩自检清单 ────');
  for (const item of report) t.diagnostic(`  [${item.ok ? '通过' : '失败'}] ${item.name}${item.detail ? ' · ' + item.detail : ''}`);
  for (const item of selftestReport.items) {
    t.diagnostic(`  [${item.status}] ${item.name}${item.detail ? ' · ' + item.detail : ''}`);
  }
  t.diagnostic(`页面内自检汇总: 通过 ${selftestReport.passed} / 跳过 ${selftestReport.skipped} / 失败 ${selftestReport.failed}`);

  assert.equal(stub.errors.length, 0, '运行期间出现未捕获异常: ' + stub.errors.map((e) => e && e.message).join(' | '));
  } finally {
    // 无论断言是否失败都停掉 rAF / mock 定时器，避免测试进程挂起
    if (app && app.shutdown) app.shutdown();
    stub.stop();
    await sleep(80);
  }
});

/* ────────────────────────────── 协议流式拆包测试 ────────────────────────────── */

async function makeMockFrames(count) {
  const { createMockBackend } = await import('../web/js/mock.js');
  const frames = [];
  const mb = createMockBackend({ intervalMs: 50 });
  mb.onFrame = (bytes) => frames.push(bytes);
  mb.start();
  for (let i = 0; i < 200 && frames.length < count; i++) await sleep(20);
  mb.stop();
  return { frames, meta: mb.getMeta() };
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        reject(new Error('等待超时: ' + label));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('FrameReader：任意 chunk 边界拆包 / 粘包 / 坏 magic 重同步', async () => {
  const { frames } = await makeMockFrames(3);
  assert.ok(frames.length === 3, '需要 3 个帧');
  const { FrameReader, parseFrame } = await import('../web/js/protocol.js');

  // ① 正常流：把 3 帧拼成一个连续 buffer，再按不规则 chunk 大小喂入（模拟网络拆包/粘包）
  const all = Buffer.concat(frames.map((f) => Buffer.from(f)));
  const sizes = [1, 7, 16, 15, 5000, 123457, 3, 999];
  const reader = new FrameReader();
  const got = [];
  let off = 0;
  let i = 0;
  while (off < all.length) {
    const n = sizes[i++ % sizes.length];
    const end = Math.min(off + n, all.length);
    got.push(...reader.push(new Uint8Array(all.subarray(off, end))));
    off = end;
  }
  assert.equal(got.length, 3, `拆包后应得到 3 帧，实际 ${got.length}`);
  for (let k = 0; k < got.length; k++) {
    const parsed = parseFrame(got[k]);
    assert.ok(parsed, `第 ${k} 帧解析失败`);
    assert.equal(parsed.seq, k + 1, '帧序号应连续');
    assert.equal(parsed.sections.pts.length, parsed.meta.sampleCount * 7, 'pts 长度错误');
  }

  // ② 坏 magic 前缀：应逐字节重同步并仍解析出 3 帧
  const corrupt = Buffer.concat([Buffer.from([0x00, 0xde, 0xad]), Buffer.concat(frames.map((f) => Buffer.from(f)))]);
  let errCount = 0;
  const reader2 = new FrameReader({ onError: () => errCount++ });
  const got2 = [];
  for (let p = 0; p < corrupt.length; p += 13) {
    got2.push(...reader2.push(new Uint8Array(corrupt.subarray(p, Math.min(p + 13, corrupt.length)))));
  }
  assert.ok(errCount >= 1, '坏 magic 应触发 onError');
  assert.equal(got2.length, 3, `重同步后应得到 3 帧，实际 ${got2.length}`);
});

/* ────────────────────────────── 真实模式集成测试 ────────────────────────────── */

test('真实模式：/api/config + 分块二进制流 + 断线重连', async (t) => {
  const { frames, meta } = await makeMockFrames(6);
  assert.ok(frames.length >= 4, '需要至少 4 个帧伪造流');
  const serverState = { configCalls: 0, streamCalls: 0, controlCalls: 0 };
  const server = createServer((req, res) => {
    const url = req.url || '/';
    try {
      if (url === '/api/config') {
        serverState.configCalls++;
        const payload = JSON.stringify(meta);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      if (url === '/api/control') {
        serverState.controlCalls++;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const payload = JSON.stringify({ ok: true, action: JSON.parse(body || '{}').action });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        });
        return;
      }
      if (url === '/api/stream') {
        serverState.streamCalls++;
        const isFirst = serverState.streamCalls === 1;
        const chunk = isFirst ? frames.slice(0, 3) : frames.slice(3);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
        // 不规则 chunk 边界写帧，验证 FrameReader 粘包/拆包
        const sizes = [5, 23, 1000, 70000, 345678];
        let fi = 0;
        let fo = 0;
        let si = 0;
        const pump = () => {
          if (res.writableEnded || res.destroyed) return;
          if (fi >= chunk.length) {
            res.end();
            return;
          }
          const bytes = chunk[fi];
          if (fo >= bytes.length) {
            fi++;
            fo = 0;
            pump();
            return;
          }
          const n = Math.min(sizes[si++ % sizes.length], bytes.length - fo);
          res.write(Buffer.from(bytes.buffer, bytes.byteOffset + fo, n));
          fo += n;
          setTimeout(pump, 2);
        };
        pump();
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      try {
        res.writeHead(500).end();
      } catch (e) {
        /* 忽略 */
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;
  const stub = installDomStub({ search: '', origin, realFetch: (url, init) => nativeFetch(url, init) });
  let app = null;
  try {
    await import('../web/js/app.js?real-mode=1');
    app = globalThis.window.__RPS_APP__;
    assert.ok(app, '真实模式 app 应启动');
    assert.equal(app.state.mode, 'real', '应为真实模式');

    await waitFor(() => app.state.frames >= 2, 5000, '等待 /api/stream 首批帧');
    const frame = app.state.latestFrame;
    assert.equal(frame.sections.pts.length, frame.meta.sampleCount * 7, '真实模式帧 sections 长度错误');
    assert.ok(frame.snap.population.alive > 0, '快照人口字段异常');
    assert.ok(serverState.configCalls >= 1, '/api/config 未被请求');
    assert.ok(app.state.configReady, 'config 未就绪');

    await waitFor(() => {
      const kpis = stub.doc.querySelectorAll('.kpi .k-value');
      return kpis.length === 6 && kpis.every((n) => n.textContent.trim() && n.textContent.trim() !== '—');
    }, 3000, '等待 KPI 用真实帧填充');

    // 第 2 轮：真实模式（服务端含 guilds/classFlow 字段时）公会榜与阶层流动应渲染
    await waitFor(() => {
      const rows = stub.doc.querySelectorAll('.guild-table .guild-row');
      const flows = stub.doc.querySelectorAll('.cr-flow');
      return rows.length >= 11 && flows.length === 4;
    }, 3000, '等待公会/阶层流动 DOM 渲染');
    const guildRows = stub.doc.querySelectorAll('.guild-table .guild-row').length;
    const guildLevels = stub.doc.querySelectorAll('.guild-lv').map((n) => n.textContent.trim());
    const flowTexts = stub.doc.querySelectorAll('.cr-flow').map((n) => n.textContent.trim());
    assert.ok(guildRows >= 11, `公会表行数 ${guildRows}`);
    assert.ok(guildLevels.length >= 10, `公会等级 chip ${guildLevels.length}`);
    assert.ok(flowTexts.every((t) => t.includes('流入') && t.includes('流出')), '阶层明细缺少流入/流出');
    const mobilityText = stub.doc.querySelector('.class-flow .cf-mob .cf-v').textContent.trim();
    assert.ok(/%$/.test(mobilityText), '流动率未显示: ' + mobilityText);
    t.diagnostic(`真实模式公会/流动: 公会行=${guildRows} 等级=${guildLevels[0]} 流动率=${mobilityText}`);

    // 首个流结束后，app 应按 1s 退避重连
    await waitFor(() => serverState.streamCalls >= 2, 4000, '等待断线重连（第二次 /api/stream）');
    await waitFor(() => app.state.frames >= 4, 4000, '等待重连后的新帧');
    t.diagnostic(`真实模式: config=${serverState.configCalls} stream=${serverState.streamCalls} frames=${app.state.frames} round=${app.state.latestFrame.round}`);
    assert.equal(stub.errors.length, 0, '真实模式运行异常: ' + stub.errors.map((e) => e && e.message).join(' | '));
  } finally {
    if (app && app.shutdown) app.shutdown();
    stub.stop();
    await new Promise((resolve) => server.close(resolve));
    await sleep(50);
  }
});

/* ────────────────────────────── 页面内自检模式（?selftest=1） ────────────────────────────── */

test('?selftest=1：页面自动执行自检并显示绿色结果浮层', async (t) => {
  const stub = installDomStub({ search: '?mock=1&selftest=1' });
  let app = null;
  try {
    await import('../web/js/app.js?selftest-mode=1');
    app = globalThis.window.__RPS_APP__;
    assert.ok(app, '自检模式 app 应启动');
    await waitFor(() => globalThis.window.__RPS_SELFTEST__, 15000, '等待页面内自检完成');
    const report = globalThis.window.__RPS_SELFTEST__;
    assert.equal(report.failed, 0, '页面内自检失败项: ' + report.items.filter((it) => it.status === 'fail').map((it) => it.name + ': ' + it.detail).join(' | '));
    // 动态读取自检项数（不硬编码通过数；第 2 轮新增公会/流动断言后 ≥24）
    assert.ok(report.total >= 24, `页面内自检项数 ${report.total}，应随新增断言增长（≥24）`);
    assert.equal(report.passed + report.skipped, report.total, '通过+跳过应等于总项数');
    const banner = stub.doc.getElementById('selftest-banner');
    assert.ok(banner, '应创建自检结果浮层 #selftest-banner');
    assert.ok(banner.className.includes('st-pass'), '通过时浮层应为绿色 st-pass');
    t.diagnostic(`?selftest=1: 共 ${report.total} 项 · 通过 ${report.passed} / 跳过 ${report.skipped} / 失败 ${report.failed}，浮层 class=${banner.className}`);
    assert.equal(stub.errors.length, 0, '自检模式出现未捕获异常: ' + stub.errors.map((e) => e && e.message).join(' | '));
  } finally {
    if (app && app.shutdown) app.shutdown();
    stub.stop();
    await sleep(80);
  }
});
