/**
 * selftest.js — 页面内自检套件（?selftest=1）
 *
 * 为什么需要它：当前开发环境无法运行无头浏览器截图，因此把「截图肉眼验收」转成可执行断言：
 *  - 协议层：二进制帧 magic / sections 长度 / 采样点数值范围；
 *  - 渲染层：WebGL 仅 2 个 draw call（1 quad + 1 点云）、buffer/纹理走复用、画布像素非空；
 *  - DOM 层：参数面板字段数、KPI/表格/事件/追踪卡有内容、图表画布已绘制图元；
 *  - 性能层：DOM/图表更新节流 ≥80ms；
 *  - 布局层：顶栏/左栏/中央/右栏尺寸合理、无横向溢出；
 *  - 交互层：点击追踪 → 右栏追踪卡出现 → 取消追踪 → 卡片消失。
 *
 * 浏览器里由 app.js 在收到若干帧后调用，结果以绿/红浮层展示；
 * Node 端（test/web-stub.test.js）复用同一套断言，浏览器专属能力自动降级为 skip。
 */

/** @typedef {{status:'pass'|'fail'|'skip', name:string, detail:string}} CheckItem */

import { fmtNum, fmtPct, fmtSigned } from './format.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{state:object, stage:object, panels:object, mock:object|null, setView?:Function, control?:Function}} ctx
 * @returns {Promise<{passed:number, failed:number, skipped:number, total:number, items:CheckItem[]}>}
 */
export async function runSelfTest(ctx) {
  const { state, stage, panels } = ctx || {};
  /** @type {CheckItem[]} */
  const items = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      if (detail === false) throw new Error('断言返回 false');
      items.push({ status: 'pass', name, detail: typeof detail === 'string' ? detail : '' });
    } catch (err) {
      items.push({ status: 'fail', name, detail: (err && err.message) || String(err) });
    }
  };
  const checkAsync = async (name, fn) => {
    try {
      const detail = await fn();
      if (detail === false) throw new Error('断言返回 false');
      items.push({ status: 'pass', name, detail: typeof detail === 'string' ? detail : '' });
    } catch (err) {
      items.push({ status: 'fail', name, detail: (err && err.message) || String(err) });
    }
  };
  const skip = (name, why) => items.push({ status: 'skip', name, detail: why || '当前环境不支持' });

  const browser = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function' && typeof window !== 'undefined';
  const frame = state && state.latestFrame;

  /* ---------- 1. 协议 / 数据 ---------- */
  check('协议：已收到最新帧', () => {
    if (!frame) throw new Error('state.latestFrame 为空');
    if (!frame.sections) throw new Error('frame.sections 缺失');
    return `seq=${frame.seq} round=${frame.round} ${(frame.byteLength / 1024).toFixed(0)} KB`;
  });

  check('协议：sections 长度与 meta 一致', () => {
    if (!frame) throw new Error('无帧');
    const pts = frame.sections.pts;
    const ids = frame.sections.ids;
    const hist = frame.sections.hist;
    const grid = frame.sections.strategyGrid;
    const meta = frame.meta;
    if (!pts) throw new Error('缺少 pts section');
    if (pts.length !== meta.sampleCount * 7) throw new Error(`pts 长度 ${pts.length} ≠ ${meta.sampleCount}×7`);
    if (!ids || ids.length !== meta.sampleCount) throw new Error(`ids 长度异常: ${ids && ids.length}`);
    if (!hist || hist.length !== 128) throw new Error('hist 应为 128 箱');
    if (!grid || grid.length !== meta.gridW * meta.gridH) throw new Error(`strategyGrid 长度 ${grid && grid.length} ≠ ${meta.gridW}×${meta.gridH}`);
    return `pts=${meta.sampleCount} 点 / grid=${meta.gridW}×${meta.gridH} / hist=128`;
  });

  check('协议：采样点数值范围合法', () => {
    if (!frame) throw new Error('无帧');
    const pts = frame.sections.pts;
    const count = Math.min(frame.meta.sampleCount, 6000);
    const sqrt3 = 0.8660254;
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      const laneX = pts[o];
      const wealthY = pts[o + 1];
      const classId = pts[o + 2];
      const streak = pts[o + 4];
      const stratX = pts[o + 5];
      const stratY = pts[o + 6];
      if (!Number.isFinite(laneX) || laneX < 0 || laneX > 1.0001) throw new Error(`laneX[${i}]=${laneX} 越界`);
      if (!Number.isFinite(wealthY) || wealthY < 0 || wealthY > 1.0001) throw new Error(`wealthY[${i}]=${wealthY} 越界`);
      if (classId < 0 || classId > 3) throw new Error(`classId[${i}]=${classId} 越界`);
      if (!Number.isFinite(streak) || streak < -1.0001 || streak > 1.0001) throw new Error(`streakNorm[${i}]=${streak} 越界`);
      if (!Number.isFinite(stratX) || stratX < -0.001 || stratX > 1.001) throw new Error(`stratX[${i}]=${stratX} 越界`);
      if (!Number.isFinite(stratY) || stratY < -0.001 || stratY > sqrt3 + 0.001) throw new Error(`stratY[${i}]=${stratY} 越界`);
    }
    return `抽查 ${count} 点，全部在 [0,1] / 三角域内`;
  });

  check('协议：JSON 关键字段齐全', () => {
    if (!frame) throw new Error('无帧');
    const s = frame.snap;
    const required = ['population.alive', 'wealth.total', 'wealth.gini', 'strategy.usage', 'series.alive', 'classes', 'endCondition.mode', 'perf'];
    for (const path of required) {
      const v = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), s);
      if (v === undefined || v === null) throw new Error('缺少字段 ' + path);
    }
    if (!Array.isArray(s.wealth.lorenz) || s.wealth.lorenz.length < 20) throw new Error('lorenz 点数过少');
    if (!s.series || !Array.isArray(s.series.alive) || s.series.alive.length < 2) throw new Error('时间序列点过少');
    return `序列 ${s.series.alive.length} 点 / 洛伦兹 ${s.wealth.lorenz.length / 2} 点`;
  });

  check('协议：追踪个体结构合法', () => {
    if (!frame) throw new Error('无帧');
    const tracked = frame.snap.tracked || [];
    for (const t of tracked) {
      if (!Number.isFinite(t.id)) throw new Error('tracked.id 非数字');
      if (!Array.isArray(t.strategy) || t.strategy.length !== 3) throw new Error('tracked.strategy 长度应为 3');
      if (!Array.isArray(t.history)) throw new Error('tracked.history 缺失');
    }
    return `当前追踪 ${tracked.length} 个`;
  });

  // 第 2 轮新增：公会 + 阶层流动协议字段
  check('协议：guilds / classFlow 字段结构合法', () => {
    if (!frame) throw new Error('无帧');
    const s = frame.snap;
    const cf = s.classFlow;
    if (!cf || typeof cf !== 'object') throw new Error('缺少 classFlow');
    for (const k of ['up', 'down', 'stay', 'total', 'mobility']) {
      if (!Number.isFinite(cf[k])) throw new Error('classFlow.' + k + ' 非有限数');
    }
    if (cf.mobility < 0 || cf.mobility > 1) throw new Error('classFlow.mobility 越界: ' + cf.mobility);
    if (!Array.isArray(s.classes) || s.classes.length !== 4) throw new Error('classes 应为 4 项');
    for (const c of s.classes) {
      if (!Number.isFinite(c.flowIn) || !Number.isFinite(c.flowOut)) throw new Error('classes.flowIn/flowOut 非有限数');
      if (c.flowIn < 0 || c.flowOut < 0) throw new Error('classes.flowIn/flowOut 不应为负');
    }
    const g = s.guilds;
    if (!g || typeof g !== 'object') throw new Error('缺少 guilds');
    if (typeof g.enabled !== 'boolean') throw new Error('guilds.enabled 应为布尔值');
    if (!g.enabled) return '公会未开启（配置关闭/旧服务端）→ 字段容错通过';
    for (const k of ['total', 'wars', 'treasuryTotal', 'avgLevel']) {
      if (!Number.isFinite(g[k])) throw new Error('guilds.' + k + ' 非有限数');
    }
    if (!Array.isArray(g.topWealth) || g.topWealth.length < 5) throw new Error('guilds.topWealth 数据不足');
    for (const row of g.topWealth) {
      for (const k of ['level', 'members', 'treasury', 'totalWealth', 'wins']) {
        if (!Number.isFinite(row[k])) throw new Error(`公会行 ${row.name} 的 ${k} 非有限数`);
      }
      if (row.level < 0 || row.level > 100) throw new Error('公会等级越界: ' + row.level);
    }
    return `公会 ${g.total} 个 / 平均 Lv ${(Number(g.avgLevel) || 0).toFixed(1)} / 金库 ${Math.round(g.treasuryTotal)} / 团体战 ${g.wars} 次`;
  });

  // 第 2 轮新增：格式化回归（整数万/亿/百分比不应出现 "100. 万" / "0.%" 之类孤立小数点）
  check('格式化：万/亿/百分比无多余小数点', () => {
    const cases = [
      [fmtNum(1_000_000), '100 万'],
      [fmtNum(123_456_789), '1.23 亿'],
      [fmtNum(1_234.5), '1234.5'],
      [fmtNum(0), '0'],
      [fmtPct(0, 2), '0%'],
      [fmtPct(0.3, 1), '30%'],
      [fmtPct(0.3333, 1), '33.3%'],
      [fmtSigned(12_345), '+1.23 万'],
      [fmtSigned(-12_345), '-1.23 万'],
    ];
    for (const [actual, expect] of cases) {
      if (actual !== expect) throw new Error(`格式化结果 "${actual}" ≠ 期望 "${expect}"`);
    }
    return cases.slice(0, 5).map((c) => c[0]).join(' / ');
  });

  /* ---------- 2. 演化 / 性能 ---------- */
  await checkAsync('mock 数据缓慢演化', async () => {
    if (state.mode !== 'mock') return '真实模式：交由后端驱动（跳过演化断言）';
    if (!frame) throw new Error('无帧');
    const round0 = frame.round;
    const frames0 = state.frames;
    await sleep(420);
    const f2 = state.latestFrame;
    if (!f2) throw new Error('等待后无新帧');
    if (state.frames <= frames0) throw new Error('没有收到新帧');
    if (f2.round <= round0) throw new Error(`回合未推进: ${round0} → ${f2.round}`);
    const aliveDelta = Math.abs(f2.snap.population.alive - frame.snap.population.alive);
    if (aliveDelta === 0) throw new Error('人口完全不变（mock 未演化）');
    return `回合 ${round0} → ${f2.round}，新增 ${state.frames - frames0} 帧`;
  });

  check('性能：单帧解析耗时记录存在', () => {
    if (!Number.isFinite(state.parseMs)) throw new Error('parseMs 非数字');
    if (state.parseMs > 8) throw new Error(`解析 ${state.parseMs.toFixed(2)}ms 超过 8ms 预算`);
    return `解析 ${state.parseMs.toFixed(2)} ms / 上传 ${(state.uploadMs || 0).toFixed(2)} ms`;
  });

  check('性能：DOM/图表更新节流 ≥80ms', () => {
    const list = state.domUpdates || [];
    if (list.length < 2) throw new Error('节流采样不足（需至少 2 次更新）');
    let minGap = Infinity;
    for (let i = 1; i < list.length; i++) {
      const gap = list[i] - list[i - 1];
      if (gap < minGap) minGap = gap;
    }
    if (minGap < 78) throw new Error(`最小更新间隔 ${minGap.toFixed(1)}ms，低于 80ms 节流要求`);
    return `${list.length} 次更新，最小间隔 ${minGap.toFixed(1)} ms`;
  });

  /* ---------- 3. WebGL ---------- */
  const glStats = stage && typeof stage.getStats === 'function' ? stage.getStats() : null;
  if (!glStats) {
    skip('WebGL：渲染器未初始化', 'stage 缺失');
  } else if (!glStats.glOk) {
    skip('WebGL：WebGL2 不可用，已回退 2D', '当前浏览器/环境不支持 WebGL2');
  } else {
    check('WebGL：每帧仅 2 个 draw call（1 quad + 1 点云）', () => {
      if (glStats.drawCalls !== 2) throw new Error(`drawCalls=${glStats.drawCalls}，应为 2`);
      const renders = Math.max(1, glStats.renders);
      const perRender = glStats.drawArraysTotal / renders;
      if (perRender > 2.05) throw new Error(`平均每帧 drawArrays=${perRender.toFixed(2)}，超过 2`);
      return `drawCalls=2，累计 ${glStats.drawArraysTotal} 次 drawArrays / ${renders} 帧`;
    });
    check('WebGL：buffer / 纹理复用（不逐帧重建）', () => {
      if (glStats.bufferDataCalls > 2) throw new Error(`bufferData 调用 ${glStats.bufferDataCalls} 次（应仅初始化扩容）`);
      if (glStats.texImageCalls > 2) throw new Error(`texImage2D 调用 ${glStats.texImageCalls} 次（应仅初始化）`);
      if (glStats.bufferSubDataCalls < 1) throw new Error('未使用 bufferSubData 上传点云');
      if (glStats.texSubImageCalls < 1 && state.frames > 1) throw new Error('未使用 texSubImage2D 更新密度纹理');
      return `bufferData×${glStats.bufferDataCalls} / bufferSubData×${glStats.bufferSubDataCalls} / texImage×${glStats.texImageCalls} / texSubImage×${glStats.texSubImageCalls}`;
    });
    check('WebGL：颜色/尺寸已绑定（采样点 > 0）', () => {
      if (!(glStats.points > 0)) throw new Error('points=0，点云为空');
      if (!(glStats.gridW > 0 && glStats.gridH > 0)) throw new Error('密度纹理尺寸为 0');
      return `${glStats.points} 点 / 纹理 ${glStats.gridW}×${glStats.gridH}`;
    });
    // 直接读回像素：确认点云/热图真的画出来了（浏览器限定）
    if (browser && stage.gl && typeof stage.gl.readPixels === 'function') {
      check('WebGL：画布像素非空（点云+热图已渲染）', () => {
        const gl = stage.gl;
        // 默认帧缓冲未保留绘制内容：读回前先在同一任务内强制重绘一次
        try {
          stage.render(typeof performance !== 'undefined' ? performance.now() : Date.now());
        } catch (err) {
          /* 忽略：下面按当前帧缓冲判定 */
        }
        const w = Math.min(stage.pxW | 0, 320);
        const h = Math.min(stage.pxH | 0, 180);
        const x = Math.max(0, ((stage.pxW | 0) - w) >> 1);
        const y = Math.max(0, ((stage.pxH | 0) - h) >> 1);
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let bright = 0;
        for (let i = 0; i < buf.length; i += 4) {
          if (buf[i] > 26 || buf[i + 1] > 34 || buf[i + 2] > 46) bright++;
        }
        const ratio = bright / (w * h);
        if (ratio < 0.015) throw new Error(`亮像素占比 ${(ratio * 100).toFixed(2)}%，舞台可能为空白`);
        return `亮像素占比 ${(ratio * 100).toFixed(2)}%`;
      });
    } else {
      skip('WebGL：画布像素读回', '当前环境不支持 readPixels');
    }
  }

  /* ---------- 4. 面板 / 图表 ---------- */
  check('面板：参数控件已按 config.js 建立', () => {
    const n = panels && typeof panels.getFieldCount === 'function' ? panels.getFieldCount() : 0;
    if (n < 60) throw new Error(`参数控件仅 ${n} 个，明显少于 config.js 界面字段数`);
    return `${n} 个参数控件`;
  });

  check('面板：KPI / 表格 / 事件 / 类阶层有真实数据', () => {
    if (!browser) throw new Error('Node 桩环境无布局，交给 DOM 文本断言');
    const text = (sel) => {
      const node = document.querySelector(sel);
      return node ? (node.textContent || '').trim() : '';
    };
    const kpis = Array.from(document.querySelectorAll('.kpi .k-value')).map((n) => n.textContent.trim());
    if (kpis.length !== 6) throw new Error(`KPI 卡数量 ${kpis.length}，应为 6`);
    if (kpis.some((v) => !v || v === '—')) throw new Error('存在未填值的 KPI: ' + JSON.stringify(kpis));
    const famRows = document.querySelectorAll('.fam-row').length;
    if (famRows < 11) throw new Error(`家族表行数 ${famRows}，应有表头+10 行`);
    const stat = text('#status-badge .sb-text');
    if (!stat) throw new Error('状态徽章为空');
    return `KPI 6 项已填 / 家族表 ${famRows} 行 / 状态「${stat}」`;
  });

  check('面板：无 NaN / undefined 文本泄漏', () => {
    if (!browser) throw new Error('Node 桩环境无布局');
    const bad = [];
    const nodes = document.querySelectorAll(
      '.side .k-value, .side .k-sub, .side .hud-v, .bt-mid .hud-v, .stage-hud .hud-v, .tc-v, .fam-row span, .guild-row span, .cr-flow, .cf-v, .gs-v',
    );
    for (const node of nodes) {
      const t = (node.textContent || '').trim();
      if (t.includes('NaN') || t.includes('undefined') || t.includes('Infinity')) bad.push(t);
      // 常见格式化 bug："100. 万" / "0.%"（独立小数点后直接跟单位）
      if (/\.\s*(%|万|亿)/.test(t)) bad.push(t + '（多余小数点）');
    }
    if (bad.length) throw new Error('发现异常文本: ' + bad.slice(0, 5).join(' | '));
    return `检查 ${nodes.length} 个数值节点，无异常文本`;
  });

  // 第 2 轮新增：公会排行面板（两种状态都要正确：有数据 / 未开启占位）
  check('面板：公会排行已渲染（或正确显示未开启占位）', () => {
    if (!browser) throw new Error('Node 桩环境无布局');
    const g = (frame && frame.snap && frame.snap.guilds) || { enabled: false };
    const tableRows = document.querySelectorAll('.guild-table .guild-row').length;
    const summary = Array.from(document.querySelectorAll('.guild-summary .gs-v')).map((n) => (n.textContent || '').trim());
    const empty = document.querySelector('.guild-panel .empty-hint');
    if (!g.enabled) {
      if (!empty || empty.classList.contains('hidden')) throw new Error('公会未开启时应显示占位提示');
      return '公会未开启 → 占位提示正确';
    }
    if (tableRows < 11) throw new Error(`公会表行数 ${tableRows}，应有表头+10 行`);
    if (summary.length !== 4) throw new Error(`公会摘要项 ${summary.length}，应为 4`);
    if (summary.some((v) => !v || v === '—' || /NaN|undefined/.test(v))) throw new Error('公会摘要存在空值: ' + JSON.stringify(summary));
    const levels = Array.from(document.querySelectorAll('.guild-lv')).map((n) => (n.textContent || '').trim());
    if (!levels.length || levels.some((v) => !/^Lv\d+$/.test(v))) throw new Error('公会等级 chip 文本异常: ' + JSON.stringify(levels.slice(0, 5)));
    // 取数据行（跳过表头）的第 2 列作为公会名，避免使用 :nth-child 选择器（Node 桩不支持）
    const dataRows = Array.from(document.querySelectorAll('.guild-table .guild-row')).slice(1);
    const guildNames = dataRows.map((row) => {
      const cell = row.children && row.children[1];
      return cell ? (cell.textContent || '').trim() : '';
    });
    if (guildNames.length < 10 || guildNames.some((v) => !v || v === '—')) throw new Error('公会名称列存在空值: ' + JSON.stringify(guildNames.slice(0, 5)));
    return `公会表 ${tableRows - 1} 行 / 摘要 ${summary.join(' / ')} / 等级 ${levels[0]}…`;
  });

  // 第 2 轮新增：阶层流动率 + 4 阶层流入/流出明细
  check('面板：阶层流动率与流入/流出明细可见', () => {
    if (!browser) throw new Error('Node 桩环境无布局');
    const cf = (frame && frame.snap && frame.snap.classFlow) || {};
    if (!(cf.mobility >= 0 && cf.mobility <= 1)) throw new Error('classFlow.mobility 越界: ' + cf.mobility);
    const mobNode = document.querySelector('.class-flow .cf-mob .cf-v');
    if (!mobNode) throw new Error('缺少流动率显示节点');
    const mobText = (mobNode.textContent || '').trim();
    if (!/^[\d.]+%$/.test(mobText)) throw new Error('流动率文本异常: ' + mobText);
    const flowTexts = Array.from(document.querySelectorAll('.class-rows .cr-flow')).map((n) => (n.textContent || '').trim());
    if (flowTexts.length !== 4) throw new Error(`阶层明细流动行数 ${flowTexts.length}，应为 4`);
    if (flowTexts.some((t) => !t.includes('流入') || !t.includes('流出'))) throw new Error('阶层明细缺少流入/流出文本: ' + JSON.stringify(flowTexts));
    return `流动率 ${mobText} / 上移 ${(document.querySelector('.class-flow .cf-up .cf-v') || {}).textContent || '?'} / 下移 ${(document.querySelector('.class-flow .cf-down .cf-v') || {}).textContent || '?'}`;
  });

  check('图表：4 个 Canvas 图表尺寸有效', () => {
    if (!browser) throw new Error('Node 桩环境无布局');
    const classes = ['.chart-hist', '.chart-lorenz', '.chart-series', '.chart-stacked', '.chart-class'];
    const sizes = [];
    for (const sel of classes) {
      const cv = document.querySelector(sel);
      if (!cv) throw new Error('缺少图表画布 ' + sel);
      if (!(cv.width > 0 && cv.height > 0)) throw new Error(`${sel} 画布尺寸为 ${cv.width}×${cv.height}`);
      sizes.push(cv.width + '×' + cv.height);
    }
    return sizes.join(' / ');
  });

  if (browser && typeof document.querySelectorAll('.chart-hist')[0]?.getContext === 'function') {
    check('图表：Canvas2D 已绘制图元（非空白）', () => {
      const result = [];
      for (const sel of ['.chart-hist', '.chart-lorenz', '.chart-series', '.chart-stacked', '.chart-class']) {
        const cv = document.querySelector(sel);
        const ctx = cv.getContext('2d');
        const w = cv.width;
        const h = cv.height;
        const data = ctx.getImageData(0, 0, w, h).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4 * 97) {
          if (data[i] > 8) painted++;
        }
        const total = Math.ceil(data.length / (4 * 97));
        const ratio = painted / Math.max(1, total);
        if (ratio < 0.02) throw new Error(`${sel} 像素质检 ${(ratio * 100).toFixed(1)}%，可能空白`);
        result.push(`${sel}:${(ratio * 100).toFixed(0)}%`);
      }
      return result.join(' ');
    });
  } else {
    skip('图表：Canvas2D 像素检查', '环境不支持 canvas.getImageData');
  }

  /* ---------- 5. 布局 ---------- */
  if (browser) {
    check('布局：五区尺寸合理且无横向溢出', () => {
      const rect = (id) => {
        const node = document.getElementById(id);
        if (!node) throw new Error('缺少区域 #' + id);
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) throw new Error('#' + id + ' 尺寸为 0');
        return r;
      };
      const top = rect('topbar');
      const left = rect('left');
      const center = rect('center');
      const right = rect('right');
      const bottom = rect('bottom');
      const vw = window.innerWidth;
      if (top.height < 48 || top.height > 70) throw new Error(`顶栏高度 ${top.height.toFixed(0)}px 异常`);
      if (left.width < 220 || left.width > 380) throw new Error(`左栏宽度 ${left.width.toFixed(0)}px 异常`);
      if (right.width < 300 || right.width > 430) throw new Error(`右栏宽度 ${right.width.toFixed(0)}px 异常`);
      if (center.width < Math.min(560, vw * 0.38)) throw new Error(`中央舞台宽 ${center.width.toFixed(0)}px，过窄`);
      if (center.height < 380) throw new Error(`中央舞台高 ${center.height.toFixed(0)}px，过矮`);
      if (bottom.height < 26 || bottom.height > 44) throw new Error(`底栏高度 ${bottom.height.toFixed(0)}px 异常`);
      if (document.body.scrollWidth > vw + 1) throw new Error(`页面横向溢出: ${document.body.scrollWidth} > ${vw}`);
      const stageCanvas = document.getElementById('gl-canvas');
      const sc = stageCanvas.getBoundingClientRect();
      if (sc.width < 400 || sc.height < 300) throw new Error(`舞台画布 ${sc.width.toFixed(0)}×${sc.height.toFixed(0)} 过小`);
      return `顶栏 ${top.height.toFixed(0)} / 左 ${left.width.toFixed(0)} / 中 ${center.width.toFixed(0)}×${center.height.toFixed(0)} / 右 ${right.width.toFixed(0)} / 底 ${bottom.height.toFixed(0)}`;
    });
  } else {
    skip('布局：区域尺寸测量', 'Node 桩环境无真实布局');
  }

  /* ---------- 6. 交互：点击追踪 → 卡片 → 取消 ---------- */
  await checkAsync('交互：追踪个体 → 右栏追踪卡出现', async () => {
    if (!ctx.control) throw new Error('未提供 control 句柄');
    const f = state.latestFrame;
    if (!f || !f.sections.ids || f.sections.ids.length === 0) throw new Error('无采样 ids');
    const id = f.sections.ids[0];
    const res = await ctx.control('track', { id });
    if (res && res.ok === false) throw new Error('track 指令失败: ' + (res.error || ''));
    await sleep(600);
    const f2 = state.latestFrame;
    const tracked = (f2.snap.tracked || []).map((t) => t.id);
    const cards = panels && typeof panels.getTrackedCount === 'function' ? panels.getTrackedCount() : 0;
    if (!tracked.includes(id)) throw new Error(`快照 tracked 中找不到 #${id}`);
    if (cards < 1) throw new Error('右栏追踪卡未创建');
    return `#${id} 已追踪，卡片 ${cards} 张`;
  });

  await checkAsync('交互：取消追踪 → 卡片移除', async () => {
    if (!ctx.control) throw new Error('未提供 control 句柄');
    const f = state.latestFrame;
    const t = (f.snap.tracked || [])[0];
    if (!t) return '无追踪个体可取消（跳过）';
    await ctx.control('untrack', { id: t.id });
    await sleep(600);
    const cards = panels && typeof panels.getTrackedCount === 'function' ? panels.getTrackedCount() : 0;
    if (cards !== 0) throw new Error(`取消后仍有 ${cards} 张追踪卡`);
    return '追踪卡已清空';
  });

  /* ---------- 7. 视图切换 ---------- */
  await checkAsync('交互：双视图切换', async () => {
    if (!ctx.setView) throw new Error('未提供 setView');
    ctx.setView('skyline');
    await sleep(180);
    if (stage.view !== 'skyline') throw new Error('stage.view 未切换到 skyline');
    const skylineHud = browser ? document.querySelector('.stage-foot') : null;
    ctx.setView('galaxy');
    await sleep(180);
    if (stage.view !== 'galaxy') throw new Error('stage.view 未切回 galaxy');
    return 'galaxy ↔ skyline 正常' + (skylineHud ? '，提示条已更新' : '');
  });

  /* ---------- 汇总 ---------- */
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.status === 'pass') passed++;
    else if (item.status === 'fail') failed++;
    else skipped++;
  }
  const report = {
    passed,
    failed,
    skipped,
    total: items.length,
    items,
    mode: state.mode,
    frames: state.frames,
    round: state.latestFrame ? state.latestFrame.round : 0,
    ts: Date.now(),
  };
  if (typeof window !== 'undefined') window.__RPS_SELFTEST__ = report;
  renderBanner(report);
  return report;
}

/** 页面顶部自检结果浮层（绿色通过 / 红色失败清单） */
function renderBanner(report) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('selftest-banner');
  const banner = existing || document.createElement('div');
  banner.id = 'selftest-banner';
  banner.className = 'selftest-banner ' + (report.failed ? 'st-fail' : 'st-pass');
  banner.textContent = '';
  const head = document.createElement('div');
  head.className = 'st-head';
  const title = document.createElement('b');
  title.textContent = report.failed
    ? `自检失败 ${report.failed} 项 / 通过 ${report.passed} 项`
    : `自检通过 ${report.passed} 项` + (report.skipped ? `（${report.skipped} 项跳过）` : '');
  head.appendChild(title);
  const close = document.createElement('button');
  close.className = 'st-close';
  close.type = 'button';
  close.textContent = '✕';
  close.addEventListener('click', () => banner.remove());
  head.appendChild(close);
  banner.appendChild(head);
  if (report.failed) {
    const list = document.createElement('ul');
    list.className = 'st-list';
    for (const item of report.items) {
      if (item.status !== 'fail') continue;
      const li = document.createElement('li');
      li.textContent = item.name + '：' + item.detail;
      list.appendChild(li);
    }
    banner.appendChild(list);
  }
  if (!existing) document.body.appendChild(banner);
}
