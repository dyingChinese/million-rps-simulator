/**
 * panels.js — 全部面板的 DOM 构建与增量更新
 *
 * 性能约定（UI-SPEC §4 / PROTOCOL §7）：
 *  - 所有节点在 init() 时一次性预创建，更新只改 textContent / style.width / class；
 *  - 表格 / 事件流 / KPI 全部走“节点缓存 + 变化检测”，不做 innerHTML 重建；
 *  - update() 由 app.js 在 rAF 中按 ≥80ms 节流调用，Canvas 图表也只在此时重绘。
 */

import {
  CLASS_NAMES,
  CLASS_COLORS,
  TALENT_NAMES,
  TALENT_COLORS,
  MOVE_NAMES,
  MOVE_COLORS,
} from './protocol.js';
import {
  fmtNum,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtMs,
  fmtBytes,
  fmtEntropy,
  fmtAge,
  clamp,
} from './format.js';
import {
  HistogramChart,
  LorenzChart,
  TimeSeriesChart,
  StackedAreaChart,
  ClassBarsChart,
  Sparkline,
} from './charts.js';

/* ────────────────────────────── DOM 工具 ────────────────────────────── */

/** 创建元素（永不使用 innerHTML） */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 只在文本变化时写 DOM（避免每帧重复赋值触发样式重算） */
function setText(node, text) {
  if (!node) return;
  const s = text === undefined || text === null ? '' : String(text);
  if (node.__t !== s) {
    node.__t = s;
    node.textContent = s;
  }
}

function setWidth(node, pct) {
  if (!node) return;
  const p = clamp(pct, 0, 100).toFixed(2) + '%';
  if (node.__w !== p) {
    node.__w = p;
    node.style.width = p;
  }
}

function toggleClass(node, cls, on) {
  if (!node) return;
  const has = node.classList.contains(cls);
  if (on && !has) node.classList.add(cls);
  else if (!on && has) node.classList.remove(cls);
}

function getPath(obj, path) {
  let cur = obj;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

const STATUS_TEXT = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

/* ────────────────────────────── 参数面板字段定义 ────────────────────────────── */

/**
 * @typedef {{path:string,label:string,min?:number,max?:number,step?:number,unit?:string,reset?:boolean,hint?:string,kind?:'number'|'select'|'switch',options?:[string,string][]}} FieldDef
 * @typedef {{id:string,title:string,en:string,fields:FieldDef[],open?:boolean}} GroupDef
 */

/** 宏调控定义 */
const MACRO_DEFS = [
  {
    key: 'average',
    name: '均富',
    fields: [
      { path: 'macro.average.everyRounds', label: '间隔', hint: '回合' },
      { path: 'macro.average.takePct', label: '抽取', hint: '%' },
    ],
  },
  {
    key: 'redistribute',
    name: '再分配',
    fields: [
      { path: 'macro.redistribute.everyRounds', label: '间隔', hint: '回合' },
      { path: 'macro.redistribute.topPct', label: '顶层', hint: '%' },
      { path: 'macro.redistribute.takePct', label: '抽取', hint: '%' },
      { path: 'macro.redistribute.bottomPct', label: '底层', hint: '%' },
    ],
  },
  {
    key: 'disaster',
    name: '灾难',
    fields: [
      { path: 'macro.disaster.everyRounds', label: '间隔', hint: '回合' },
      { path: 'macro.disaster.affectedPct', label: '波及', hint: '%' },
      { path: 'macro.disaster.shrinkPct', label: '缩水', hint: '%' },
    ],
  },
  {
    key: 'dividend',
    name: '分红',
    fields: [
      { path: 'macro.dividend.everyRounds', label: '间隔', hint: '回合' },
      { path: 'macro.dividend.affectedPct', label: '覆盖', hint: '%' },
      { path: 'macro.dividend.amount', label: '金额', hint: '元' },
    ],
  },
  {
    key: 'subsidy',
    name: '保底',
    fields: [
      { path: 'macro.subsidy.countPct', label: '占比', hint: '%' },
      { path: 'macro.subsidy.count', label: '人数', hint: '人' },
      { path: 'macro.subsidy.amount', label: '金额', hint: '元' },
    ],
  },
];

/** 左栏分组（与 src/core/config.js 参数名一一对应） */
const PARAM_GROUPS = [
  {
    id: 'base',
    title: '基础参数',
    en: 'BASIC',
    open: true,
    fields: [
      { path: 'initialPopulation', label: '初始人数', min: 2, max: 5000000, step: 1000, reset: true, unit: '人' },
      { path: 'maxPopulation', label: '人口上限', min: 2, max: 5000000, step: 10000, unit: '人' },
      { path: 'initialWealth', label: '初始资金', min: 0, step: 10, reset: true, unit: '元' },
      { path: 'maxDebt', label: '最大负债', min: 0, step: 10, reset: true, unit: '元' },
      { path: 'roundCost', label: '猜拳成本', min: 0, step: 0.5, unit: '元' },
      { path: 'betMultiplier', label: '赌注倍率', min: 0, max: 20, step: 0.1, unit: '×' },
      { path: 'maxAge', label: '最大年龄', min: 1, step: 10, unit: '回合' },
    ],
  },
  {
    id: 'genetics',
    title: '遗传繁殖',
    en: 'GENETICS',
    open: true,
    fields: [
      { path: 'genetics.reproWealthThreshold', label: '繁殖资产门槛', min: 0, step: 100, unit: '元' },
      { path: 'genetics.minReproAge', label: '最小繁殖年龄', min: 0, step: 5, unit: '回合' },
      { path: 'genetics.maxReproCount', label: '最大繁殖次数', min: 0, step: 1, unit: '次' },
      { path: 'genetics.baseBirthCost', label: '基础生育成本', min: 0, step: 10, unit: '元' },
      { path: 'genetics.birthCostRatio', label: '生育成本比例', min: 0, max: 1, step: 0.01 },
      { path: 'genetics.mutationRate', label: '基因突变率', min: 0, max: 1, step: 0.01 },
      { path: 'genetics.reproChancePerRound', label: '每回合繁殖概率', min: 0, max: 1, step: 0.005 },
      { path: 'genetics.debtLimitMutation', label: '负债上限变异', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'matching',
    title: '匹配机制',
    en: 'MATCHING',
    open: true,
    fields: [
      {
        path: 'matching.mode',
        label: '匹配方式',
        kind: 'select',
        options: [
          ['random', '随机匹配'],
          ['wealth', '资产相近'],
          ['strategy', '策略相近'],
        ],
      },
      { path: 'matching.wealthPct', label: '资产相近范围', min: 1, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    id: 'end',
    title: '结束条件',
    en: 'END CONDITION',
    open: true,
    fields: [
      {
        path: 'endCondition.mode',
        label: '模式',
        kind: 'select',
        options: [
          ['A', 'A · 资产达阈值'],
          ['B', 'B · N% 超阈值'],
          ['C', 'C · 固定回合'],
          ['D', 'D · 存活低于 X%'],
          ['E', 'E · 连续无增长'],
        ],
      },
      { path: 'endCondition.threshold', label: '资产阈值', min: 0, step: 1000, unit: '元' },
      { path: 'endCondition.pct', label: '百分比', min: 0.01, max: 100, step: 0.5, unit: '%' },
      { path: 'endCondition.rounds', label: '回合数', min: 1, step: 100, unit: '回合' },
      { path: 'endCondition.noGrowthRounds', label: '无增长回合', min: 1, step: 10, unit: '回合' },
    ],
  },
  {
    id: 'advanced',
    title: '进阶模式',
    en: 'ADVANCED',
    open: false,
    fields: [
      { path: 'plague.enabled', label: '瘟疫模式', kind: 'switch' },
      { path: 'plague.infectRate', label: '感染率', min: 0, max: 1, step: 0.005 },
      { path: 'plague.damagePct', label: '感染损失', min: 0, max: 1, step: 0.01 },
      { path: 'resourceLimited.enabled', label: '资源有限', kind: 'switch' },
      { path: 'resourceLimited.initialPool', label: '初始资金池', min: 0, step: 10000, unit: '元' },
    ],
  },
  {
    id: 'guilds',
    title: '公会模式',
    en: 'GUILDS',
    open: false,
    fields: [
      { path: 'guilds.enabled', label: '启用公会', kind: 'switch' },
      { path: 'guilds.count', label: '公会数量', min: 1, max: 4096, step: 1, unit: '个' },
      { path: 'guilds.joinChance', label: '入会概率', min: 0, max: 1, step: 0.01 },
      { path: 'guilds.recruitChance', label: '招收概率', min: 0, max: 1, step: 0.001 },
      { path: 'guilds.contributeRate', label: '缴金比例', min: 0, max: 1, step: 0.005 },
      { path: 'guilds.coverRatio', label: '兜底比例', min: 0, max: 1, step: 0.01 },
      { path: 'guilds.expelBelowRatio', label: '开除阈值', min: 0, max: 1, step: 0.01 },
      { path: 'guilds.levelUpAssets', label: '升级资产', min: 1, step: 100000, unit: '元' },
      { path: 'guilds.maxLevel', label: '最高等级', min: 1, max: 100, step: 1, unit: '级' },
      { path: 'guilds.costDiscountPerLevel', label: '每级成本折扣', min: 0, max: 0.1, step: 0.001 },
      { path: 'guilds.warChance', label: '团体战概率', min: 0, max: 1, step: 0.005 },
      { path: 'guilds.warChampionCount', label: '出战人数', min: 1, max: 64, step: 1, unit: '人' },
      { path: 'guilds.warStake', label: '对战赌注', min: 0, step: 10, unit: '元' },
    ],
  },
  {
    id: 'balance',
    title: '平衡性',
    en: 'BALANCE',
    open: false,
    fields: [
      { path: 'balance.newbieProtectRounds', label: '新手保护回合', min: 0, step: 1, unit: '回合' },
      { path: 'balance.assetSoftCap.enabled', label: '资产软上限', kind: 'switch' },
      { path: 'balance.assetSoftCap.threshold', label: '软上限阈值', min: 1, step: 10000, unit: '元' },
      { path: 'balance.assetSoftCap.decay', label: '超出收益系数', min: 0, max: 1, step: 0.01 },
    ],
  },
];

/** 时间序列指标切换 */
const METRIC_TABS = [
  ['population', '人口'],
  ['wealth', '总资产'],
  ['flows', '出生/死亡'],
  ['gini', '基尼'],
];

/* ────────────────────────────── createPanels ────────────────────────────── */

/**
 * @param {{control:(action:string,payload?:object)=>Promise<object>, preset:(name:string)=>void, view:(view:string)=>void, applyReset:()=>void}} actions
 */
export function createPanels(actions) {
  const doc = document;
  const root = {
    topbar: doc.getElementById('topbar'),
    left: doc.getElementById('left'),
    right: doc.getElementById('right'),
    bottom: doc.getElementById('bottom'),
    viewTabs: doc.getElementById('view-tabs'),
    legend: doc.getElementById('stage-legend'),
    stageFoot: doc.getElementById('stage-foot'),
    hudTL: doc.getElementById('stage-hud-tl'),
    hudTR: doc.getElementById('stage-hud-tr'),
    fallbackTag: doc.getElementById('gl-fallback-tag'),
    alertbar: doc.getElementById('alertbar'),
    center: doc.getElementById('center'),
  };

  const P = {
    actions,
    meta: null,
    config: null,
    view: 'galaxy',
    familyTab: 'wealth',
    guildTab: 'wealth',
    lastFrame: null,
    lastSnap: null,
    tracked: [],
    /** @type {Map<string, object>} 配置字段 → DOM 引用 */
    fields: new Map(),
    refs: {},
    charts: {},
  };

  /* ============================ 顶栏 ============================ */
  function buildTopbar() {
    const bar = root.topbar;
    bar.textContent = '';
    const left = el('div', 'tb-left');
    const logo = el('div', 'logo');
    for (let i = 0; i < 3; i++) {
      const dot = el('i', 'logo-dot');
      logo.appendChild(dot);
    }
    const titleWrap = el('div', 'tb-title');
    titleWrap.appendChild(el('h1', null, '百万猜拳演化模拟器'));
    titleWrap.appendChild(el('p', 'tb-sub', 'MILLION-AGENT RPS EVOLUTION'));
    left.appendChild(logo);
    left.appendChild(titleWrap);

    const mid = el('div', 'tb-mid');
    const presetWrap = el('label', 'preset-wrap');
    presetWrap.appendChild(el('span', 'tb-k', '预设'));
    const presetSel = el('select', 'preset-select');
    presetSel.id = 'preset-select';
    presetWrap.appendChild(presetSel);
    mid.appendChild(presetWrap);

    const badge = el('div', 'status-badge');
    badge.id = 'status-badge';
    const badgeDot = el('i', 'dot');
    const badgeText = el('span', 'sb-text', '连接中');
    badge.appendChild(badgeDot);
    badge.appendChild(badgeText);
    mid.appendChild(badge);

    const roundStat = el('div', 'tb-stat');
    roundStat.appendChild(el('span', 'tb-k', '回合'));
    const roundVal = el('b', 'tb-v', '0');
    roundStat.appendChild(roundVal);
    mid.appendChild(roundStat);

    const rpsStat = el('div', 'tb-stat');
    rpsStat.appendChild(el('span', 'tb-k', '回合/秒'));
    const rpsVal = el('b', 'tb-v', '0');
    rpsStat.appendChild(rpsVal);
    mid.appendChild(rpsStat);

    const endWrap = el('div', 'end-cond');
    const endTop = el('div', 'end-cond-top');
    const endMode = el('span', 'ec-mode', '模式 C');
    const endLabel = el('span', 'ec-label', '回合 0 / 2000');
    endTop.appendChild(endMode);
    endTop.appendChild(endLabel);
    const progress = el('div', 'progress');
    const progressFill = el('i', 'progress-fill');
    progress.appendChild(progressFill);
    endWrap.appendChild(endTop);
    endWrap.appendChild(progress);
    mid.appendChild(endWrap);

    const right = el('div', 'tb-right');
    const btnRun = el('button', 'btn btn-run', '▶ 运行');
    const btnPause = el('button', 'btn', '⏸ 暂停');
    const btnStep = el('button', 'btn', '⏭ 单步');
    const btnReset = el('button', 'btn btn-danger', '↺ 重置');
    for (const b of [btnRun, btnPause, btnStep, btnReset]) {
      b.type = 'button';
      right.appendChild(b);
    }
    const speedWrap = el('div', 'speed-wrap');
    speedWrap.appendChild(el('span', 'tb-k', '速度'));
    const speedRange = el('input', 'speed-range');
    speedRange.type = 'range';
    speedRange.min = '0';
    speedRange.max = '60';
    speedRange.step = '1';
    speedRange.value = '0';
    const speedLabel = el('b', 'speed-label', '全速');
    speedWrap.appendChild(speedRange);
    speedWrap.appendChild(speedLabel);
    right.appendChild(speedWrap);

    bar.appendChild(left);
    bar.appendChild(mid);
    bar.appendChild(right);

    P.refs.topbar = {
      presetSel,
      badge,
      badgeDot,
      badgeText,
      roundVal,
      rpsVal,
      endMode,
      endLabel,
      progressFill,
      btnRun,
      btnPause,
      btnStep,
      btnReset,
      speedRange,
      speedLabel,
    };

    // 事件
    presetSel.addEventListener('change', () => {
      const name = presetSel.value;
      if (name) P.actions.preset(name);
    });
    btnRun.addEventListener('click', () => P.actions.control('start'));
    btnPause.addEventListener('click', () => P.actions.control('pause'));
    btnStep.addEventListener('click', () => P.actions.control('step', { rounds: 1 }));
    btnReset.addEventListener('click', () => P.actions.control('reset'));
    speedRange.addEventListener('input', () => {
      P.refs.topbar.speedLabel.textContent = speedLabelText(Number(speedRange.value));
    });
    speedRange.addEventListener('change', () => {
      const v = Number(speedRange.value) || 0;
      P.actions.control('speed', { targetRoundsPerSec: v });
    });
  }

  function speedLabelText(v) {
    return v <= 0 ? '全速' : v + ' 回合/秒';
  }

  /* ============================ 左栏参数 ============================ */
  function buildLeft() {
    const aside = root.left;
    aside.textContent = '';
    const head = el('div', 'side-head');
    head.appendChild(el('h2', null, '参数配置'));
    head.appendChild(el('span', 'en', 'CONFIGURATION'));
    aside.appendChild(head);

    const scroll = el('div', 'side-scroll param-scroll');
    aside.appendChild(scroll);

    for (const g of PARAM_GROUPS) {
      const sec = el('section', 'group' + (g.open === false ? ' collapsed' : ''));
      const headBtn = el('button', 'group-head');
      headBtn.type = 'button';
      headBtn.appendChild(el('span', 'chev', '▾'));
      headBtn.appendChild(el('span', 'g-title', g.title));
      headBtn.appendChild(el('span', 'g-en', g.en));
      const body = el('div', 'group-body');
      headBtn.addEventListener('click', () => {
        const collapsed = sec.classList.contains('collapsed');
        toggleClass(sec, 'collapsed', !collapsed);
        const chev = headBtn.firstChild;
        if (chev) chev.textContent = collapsed ? '▾' : '▸';
      });
      sec.appendChild(headBtn);
      sec.appendChild(body);
      scroll.appendChild(sec);
      for (const f of g.fields) {
        if (f.kind === 'switch') body.appendChild(buildSwitchRow(f));
        else if (f.kind === 'select') body.appendChild(buildSelectRow(f));
        else body.appendChild(buildNumberRow(f));
      }
      if (g.id === 'end') {
        // 宏观调控（参数 5）插在结束条件之后
        scroll.appendChild(buildMacroGroup());
      }
    }

    const actionsBar = el('div', 'param-actions');
    const btnApply = el('button', 'btn btn-primary', '应用参数');
    const btnResetApply = el('button', 'btn btn-danger', '重置并应用');
    btnApply.type = 'button';
    btnResetApply.type = 'button';
    btnApply.addEventListener('click', () => {
      const patch = collectConfigPatch();
      if (patch) P.actions.applyConfig(patch);
    });
    btnResetApply.addEventListener('click', () => {
      const patch = collectConfigPatch();
      P.actions.applyReset(patch);
    });
    actionsBar.appendChild(btnApply);
    actionsBar.appendChild(btnResetApply);
    aside.appendChild(actionsBar);
    P.refs.btnApply = btnApply;
    P.refs.btnResetApply = btnResetApply;
  }

  function buildNumberRow(field) {
    const row = el('div', 'field');
    const label = el('span', 'f-label', field.label);
    if (field.reset) label.appendChild(el('span', 'f-reset', '需重置'));
    row.appendChild(label);
    const wrap = el('span', 'f-input');
    const input = el('input', 'num-input');
    input.type = 'number';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.step = String(field.step !== undefined ? field.step : 1);
    input.addEventListener('change', () => normalizeInput(input, field));
    wrap.appendChild(input);
    if (field.unit) wrap.appendChild(el('span', 'f-unit', field.unit));
    row.appendChild(wrap);
    P.fields.set(field.path, { kind: 'number', input, def: field, row });
    bindDragAdjust(label, input, field);
    return row;
  }

  function buildSwitchRow(field) {
    const row = el('div', 'field field-switch');
    row.appendChild(el('span', 'f-label', field.label));
    const wrap = el('label', 'switch');
    const input = el('input', 'switch-input');
    input.type = 'checkbox';
    wrap.appendChild(input);
    wrap.appendChild(el('i', 'switch-ui'));
    row.appendChild(wrap);
    P.fields.set(field.path, { kind: 'switch', input, def: field, row });
    return row;
  }

  function buildSelectRow(field) {
    const row = el('div', 'field');
    row.appendChild(el('span', 'f-label', field.label));
    const wrap = el('span', 'f-input');
    const sel = el('select', 'f-select');
    for (const [value, label] of field.options || []) {
      const opt = el('option', null, label);
      opt.value = value;
      sel.appendChild(opt);
    }
    wrap.appendChild(sel);
    row.appendChild(wrap);
    P.fields.set(field.path, { kind: 'select', input: sel, def: field, row });
    return row;
  }

  /** 宏观调控分组：每行 switch + 若干参数 + 手动触发 */
  function buildMacroGroup() {
    const sec = el('section', 'group');
    const headBtn = el('button', 'group-head');
    headBtn.type = 'button';
    headBtn.appendChild(el('span', 'chev', '▾'));
    headBtn.appendChild(el('span', 'g-title', '宏观调控'));
    headBtn.appendChild(el('span', 'g-en', 'MACRO'));
    const body = el('div', 'group-body');
    headBtn.addEventListener('click', () => {
      const collapsed = sec.classList.contains('collapsed');
      toggleClass(sec, 'collapsed', !collapsed);
      const chev = headBtn.firstChild;
      if (chev) chev.textContent = collapsed ? '▾' : '▸';
    });
    sec.appendChild(headBtn);
    sec.appendChild(body);

    for (const m of MACRO_DEFS) {
      const row = el('div', 'macro-row');
      const sw = el('label', 'switch switch-sm');
      const cb = el('input', 'switch-input');
      cb.type = 'checkbox';
      sw.appendChild(cb);
      sw.appendChild(el('i', 'switch-ui'));
      row.appendChild(sw);
      P.fields.set('macro.' + m.key + '.enabled', { kind: 'switch', input: cb, def: { path: 'macro.' + m.key + '.enabled', label: m.name }, row });
      const name = el('span', 'm-name', m.name);
      row.appendChild(name);
      const fieldsWrap = el('span', 'm-fields');
      for (const f of m.fields) {
        const inp = el('input', 'num-input m-input');
        inp.type = 'number';
        inp.step = '1';
        inp.title = f.label;
        inp.setAttribute('aria-label', f.label);
        const suffix = el('span', 'm-unit', f.hint || '');
        const fw = el('span', 'm-field');
        fw.appendChild(inp);
        fw.appendChild(suffix);
        fieldsWrap.appendChild(fw);
        P.fields.set(f.path, { kind: 'number', input: inp, def: f, row });
        inp.addEventListener('change', () => {
          if (!Number.isFinite(Number(inp.value))) inp.value = '0';
        });
      }
      row.appendChild(fieldsWrap);
      const trig = el('button', 'mini-btn', '触发');
      trig.type = 'button';
      trig.addEventListener('click', () => P.actions.control('trigger', { macro: m.key }));
      row.appendChild(trig);
      body.appendChild(row);
    }
    return sec;
  }

  /** 数字输入范围钳制 + 小数位收敛 */
  function normalizeInput(input, field) {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = field.min !== undefined ? field.min : 0;
    if (field.min !== undefined && v < field.min) v = field.min;
    if (field.max !== undefined && v > field.max) v = field.max;
    const step = field.step || 1;
    if (step >= 1) v = Math.round(v);
    else {
      const dec = String(step).split('.')[1] ? String(step).split('.')[1].length : 2;
      v = Number(v.toFixed(dec));
    }
    input.value = String(v);
  }

  /** 标签横向拖拽调整数值（UI-SPEC：可拖拽或直接输入） */
  function bindDragAdjust(label, input, field) {
    let drag = null;
    label.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, start: Number(input.value) || 0, moved: false };
      try {
        label.setPointerCapture?.(e.pointerId);
      } catch (err) {
        /* 某些浏览器不允许在非交互元素上捕获指针，忽略即可 */
      }
      e.preventDefault();
    });
    label.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      const step = field.step || 1;
      const scale = field.max !== undefined && field.max - field.min > 100000 ? 100 : 1;
      let v = drag.start + Math.round(dx / 3) * step * scale;
      if (field.min !== undefined) v = Math.max(field.min, v);
      if (field.max !== undefined) v = Math.min(field.max, v);
      input.value = String(Number(v.toFixed(step < 1 ? 2 : 0)));
    });
    const stop = (e) => {
      drag = null;
      try {
        label.releasePointerCapture?.(e && e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    };
    label.addEventListener('pointerup', stop);
    label.addEventListener('pointercancel', stop);
  }

  /** 读取左栏全部输入 → 嵌套 patch 对象（只包含界面上存在的字段） */
  function collectConfigPatch() {
    const patch = {};
    for (const [path, rec] of P.fields) {
      if (rec.kind === 'switch') {
        setPath(patch, path, !!rec.input.checked);
      } else if (rec.kind === 'number') {
        let v = Number(rec.input.value);
        if (!Number.isFinite(v)) continue;
        if (rec.def.min !== undefined && v < rec.def.min) v = rec.def.min;
        if (rec.def.max !== undefined && v > rec.def.max) v = rec.def.max;
        setPath(patch, path, v);
      } else if (rec.kind === 'select') {
        setPath(patch, path, rec.input.value);
      }
    }
    return patch;
  }

  /** 回填配置到所有控件（权威值来自 /api/config 或 setConfig 响应） */
  function applyConfig(cfg) {
    if (!cfg) return;
    P.config = cfg;
    for (const [path, rec] of P.fields) {
      const v = getPath(cfg, path);
      if (rec.kind === 'switch') {
        rec.input.checked = !!v;
      } else if (rec.kind === 'number') {
        if (typeof v === 'number') rec.input.value = String(Number.isInteger(v) ? v : Number(v.toFixed(4)));
      } else if (rec.kind === 'select') {
        if (v !== undefined) rec.input.value = String(v);
      }
    }
    // 结束条件标签兜底
    if (P.refs.topbar && cfg.endCondition) {
      P.refs.topbar.endMode.textContent = '模式 ' + (cfg.endCondition.mode || 'C');
    }
  }

  /* ============================ 右栏数据 ============================ */

  function buildRight() {
    const aside = root.right;
    aside.textContent = '';
    const head = el('div', 'side-head');
    head.appendChild(el('h2', null, '实时数据'));
    head.appendChild(el('span', 'en', 'LIVE ANALYTICS'));
    aside.appendChild(head);
    const scroll = el('div', 'side-scroll right-scroll');
    aside.appendChild(scroll);

    /* KPI 2×3 */
    const kpi = el('section', 'kpi-grid');
    const kpiDefs = [
      ['alive', '存活人口', '初始 100 万'],
      ['total', '总资产', '均值 —'],
      ['mean', '平均资产', '中位 —'],
      ['gini', '近似基尼系数', 'P90 —'],
      ['cost', '当前单次成本', '通胀 ×1.00'],
      ['entropy', '平均策略熵', '0.000 / 1.099'],
    ];
    const kpiNodes = {};
    for (const [key, label, sub] of kpiDefs) {
      const card = el('div', 'kpi');
      card.appendChild(el('span', 'k-label', label));
      const value = el('b', 'k-value', '—');
      const subNode = el('span', 'k-sub', sub);
      card.appendChild(value);
      card.appendChild(subNode);
      kpi.appendChild(card);
      kpiNodes[key] = { card, value, sub: subNode };
    }
    scroll.appendChild(kpi);

    /* 出拳使用率 */
    const usagePanel = el('section', 'panel usage-panel');
    usagePanel.appendChild(sectionHead('出拳使用率', 'MOVE USAGE'));
    const usageRows = el('div', 'usage-rows');
    const usageNodes = [];
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'usage-row');
      const chip = el('i', 'move-chip');
      chip.style.background = MOVE_COLORS[i];
      const name = el('span', 'u-name', MOVE_NAMES[i]);
      const track = el('div', 'u-track');
      const fill = el('i', 'u-fill');
      fill.style.background = MOVE_COLORS[i];
      track.appendChild(fill);
      const pct = el('b', 'u-pct', '—');
      row.appendChild(chip);
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(pct);
      usageRows.appendChild(row);
      usageNodes.push({ fill, pct });
    }
    usagePanel.appendChild(usageRows);
    const usageNote = el('div', 'sub-note', '主导分布 — / — / —');
    usagePanel.appendChild(usageNote);
    scroll.appendChild(usagePanel);

    /* 资产分布直方图 */
    const histPanel = el('section', 'panel chart-panel');
    histPanel.appendChild(sectionHead('资产分布', 'WEALTH HISTOGRAM', '128 箱 · 对数财富轴'));
    const histCanvas = el('canvas', 'chart chart-hist');
    histPanel.appendChild(histCanvas);
    scroll.appendChild(histPanel);

    /* 洛伦兹曲线 */
    const lorenzPanel = el('section', 'panel chart-panel');
    lorenzPanel.appendChild(sectionHead('洛伦兹曲线', 'LORENZ CURVE', '近似基尼'));
    const lorenzCanvas = el('canvas', 'chart chart-lorenz');
    lorenzPanel.appendChild(lorenzCanvas);
    scroll.appendChild(lorenzPanel);

    /* 时间序列 */
    const seriesPanel = el('section', 'panel chart-panel');
    seriesPanel.appendChild(sectionHead('时间序列', 'TIME SERIES'));
    const metricTabs = el('div', 'metric-tabs');
    const metricBtns = {};
    for (const [key, label] of METRIC_TABS) {
      const b = el('button', 'metric-btn' + (key === 'population' ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        P.charts.series.setMetric(key);
        for (const k of Object.keys(metricBtns)) toggleClass(metricBtns[k], 'active', k === key);
      });
      metricBtns[key] = b;
      metricTabs.appendChild(b);
    }
    seriesPanel.appendChild(metricTabs);
    const seriesCanvas = el('canvas', 'chart chart-series');
    seriesPanel.appendChild(seriesCanvas);
    scroll.appendChild(seriesPanel);

    /* 策略演化堆叠面积 */
    const stackedPanel = el('section', 'panel chart-panel');
    stackedPanel.appendChild(sectionHead('策略演化', 'STRATEGY EVOLUTION', '主导拳种占比'));
    const stackedCanvas = el('canvas', 'chart chart-stacked');
    stackedPanel.appendChild(stackedCanvas);
    const stackedLegend = el('div', 'chart-legend');
    for (let i = 0; i < 3; i++) {
      const item = el('span', 'cl-item');
      const dot = el('i', 'cl-dot');
      dot.style.background = MOVE_COLORS[i];
      item.appendChild(dot);
      item.appendChild(el('span', null, MOVE_NAMES[i]));
      stackedLegend.appendChild(item);
    }
    stackedPanel.appendChild(stackedLegend);
    scroll.appendChild(stackedPanel);

    /* 阶层结构（含第 2 轮新增：阶层流动） */
    const classPanel = el('section', 'panel');
    classPanel.appendChild(sectionHead('阶层结构', 'CLASS STRUCTURE'));
    const classCanvas = el('canvas', 'chart chart-class');
    classPanel.appendChild(classCanvas);
    // 阶层流动摘要（来自 json.classFlow）
    const classFlow = el('div', 'class-flow');
    const classFlowNodes = {};
    for (const [key, label, cls] of [
      ['up', '上移', 'cf-up'],
      ['down', '下移', 'cf-down'],
      ['mobility', '流动率', 'cf-mob'],
    ]) {
      const item = el('span', 'cf-item ' + cls);
      item.appendChild(el('em', 'cf-k', label));
      const v = el('b', 'cf-v', '—');
      item.appendChild(v);
      classFlow.appendChild(item);
      classFlowNodes[key] = v;
    }
    classPanel.appendChild(classFlow);
    const classRows = el('div', 'class-rows');
    const classRowNodes = [];
    for (let i = 0; i < 4; i++) {
      const item = el('div', 'class-item');
      const row = el('div', 'class-row');
      const chip = el('i', 'cls-chip');
      chip.style.background = CLASS_COLORS[i];
      const name = el('span', 'cr-name', CLASS_NAMES[i]);
      const count = el('span', 'cr-count', '—');
      const share = el('span', 'cr-share', '—');
      const wshare = el('span', 'cr-wshare', '—');
      row.appendChild(chip);
      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(share);
      row.appendChild(wshare);
      const flow = el('span', 'cr-flow', '流入 — · 流出 —');
      item.appendChild(row);
      item.appendChild(flow);
      classRows.appendChild(item);
      classRowNodes.push({ chip, name, count, share, wshare, flow });
    }
    classPanel.appendChild(classRows);
    const talentNote = el('div', 'sub-note talent-note', '天赋 —');
    classPanel.appendChild(talentNote);
    scroll.appendChild(classPanel);

    /* 家族排行 */
    const famPanel = el('section', 'panel');
    const famHead = sectionHead('家族排行', 'FAMILY RANKING');
    famPanel.appendChild(famHead);
    const famTabs = el('div', 'fam-tabs');
    const famBtnWealth = el('button', 'fam-tab active', '资产 Top10');
    const famBtnSize = el('button', 'fam-tab', '人数 Top10');
    famBtnWealth.type = 'button';
    famBtnSize.type = 'button';
    famBtnWealth.addEventListener('click', () => {
      P.familyTab = 'wealth';
      toggleClass(famBtnWealth, 'active', true);
      toggleClass(famBtnSize, 'active', false);
      if (P.lastSnap) P._renderFamilyRows(P.lastSnap);
    });
    famBtnSize.addEventListener('click', () => {
      P.familyTab = 'size';
      toggleClass(famBtnWealth, 'active', false);
      toggleClass(famBtnSize, 'active', true);
      if (P.lastSnap) P._renderFamilyRows(P.lastSnap);
    });
    famTabs.appendChild(famBtnWealth);
    famTabs.appendChild(famBtnSize);
    famPanel.appendChild(famTabs);
    const famTable = el('div', 'fam-table');
    const famTableHead = el('div', 'fam-row fam-head');
    for (const h of ['#', '家族', '资产', '人数', '代数']) famTableHead.appendChild(el('span', null, h));
    famTable.appendChild(famTableHead);
    const famRows = [];
    for (let i = 0; i < 10; i++) {
      const row = el('div', 'fam-row');
      const cells = [];
      for (let c = 0; c < 5; c++) {
        const cell = el('span', null, '—');
        cells.push(cell);
        row.appendChild(cell);
      }
      famTable.appendChild(row);
      famRows.push({ row, cells });
    }
    famPanel.appendChild(famTable);
    scroll.appendChild(famPanel);

    /* 公会排行（第 2 轮新增：GUILDS） */
    const guildPanel = el('section', 'panel guild-panel');
    guildPanel.appendChild(sectionHead('公会排行', 'GUILDS', '等级 / 金库 / 团体战'));
    // 摘要行：公会数 / 平均等级 / 金库总额 / 团体战次数
    const guildSummary = el('div', 'guild-summary');
    const gsNodes = {};
    for (const [key, label] of [
      ['count', '公会数'],
      ['avgLevel', '平均等级'],
      ['treasury', '金库总额'],
      ['wars', '团体战'],
    ]) {
      const item = el('span', 'gs-item');
      item.appendChild(el('em', 'gs-k', label));
      const v = el('b', 'gs-v', '—');
      item.appendChild(v);
      guildSummary.appendChild(item);
      gsNodes[key] = v;
    }
    guildPanel.appendChild(guildSummary);
    // 三个视图：资产 / 人数 / 胜场
    const guildTabs = el('div', 'guild-tabs');
    const gTabNodes = {};
    for (const [key, label] of [
      ['wealth', '资产'],
      ['members', '人数'],
      ['wars', '胜场'],
    ]) {
      const b = el('button', 'guild-tab' + (key === 'wealth' ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        P.guildTab = key;
        for (const k of Object.keys(gTabNodes)) toggleClass(gTabNodes[k], 'active', k === key);
        if (P.lastSnap) P._renderGuildRows(P.lastSnap);
      });
      gTabNodes[key] = b;
      guildTabs.appendChild(b);
    }
    guildPanel.appendChild(guildTabs);
    // 表格：排名 / 公会 / 等级 / 人数 / 金库 / 总资产(W) / 胜场
    const guildTable = el('div', 'guild-table');
    const guildHead = el('div', 'guild-row guild-head');
    for (const h of ['#', '公会', '等级', '人数', '金库', '总资产(W)', '胜场']) guildHead.appendChild(el('span', null, h));
    guildTable.appendChild(guildHead);
    const guildRows = [];
    for (let i = 0; i < 10; i++) {
      const row = el('div', 'guild-row');
      const cells = [];
      for (let c = 0; c < 7; c++) {
        const cell = el('span', null, '—');
        cells.push(cell);
        row.appendChild(cell);
      }
      guildTable.appendChild(row);
      guildRows.push({ row, cells });
    }
    guildPanel.appendChild(guildTable);
    const guildEmpty = el('div', 'empty-hint hidden', '未开启（在参数面板开启公会模式）');
    guildPanel.appendChild(guildEmpty);
    scroll.appendChild(guildPanel);

    /* 事件流 */
    const evPanel = el('section', 'panel');
    evPanel.appendChild(sectionHead('事件流', 'EVENT STREAM'));
    const evRowsWrap = el('div', 'event-rows');
    const evRows = [];
    for (let i = 0; i < 10; i++) {
      const row = el('div', 'event-row');
      const round = el('span', 'ev-round', '—');
      const tag = el('span', 'ev-tag', '事件');
      const body = el('span', 'ev-body');
      const title = el('b', 'ev-title', '—');
      const detail = el('span', 'ev-detail', '');
      body.appendChild(title);
      body.appendChild(detail);
      const delta = el('span', 'ev-delta', '0');
      row.appendChild(round);
      row.appendChild(tag);
      row.appendChild(body);
      row.appendChild(delta);
      evRowsWrap.appendChild(row);
      evRows.push({ row, round, tag, title, detail, delta, key: '' });
    }
    evPanel.appendChild(evRowsWrap);
    const evEmpty = el('div', 'empty-hint hidden', '暂无事件');
    evPanel.appendChild(evEmpty);
    scroll.appendChild(evPanel);

    /* 追踪个体 */
    const trackPanel = el('section', 'panel tracked-panel');
    trackPanel.appendChild(sectionHead('追踪个体', 'TRACKED AGENTS', '最多 8 个'));
    const trackWrap = el('div', 'tracked-cards');
    const trackEmpty = el('div', 'empty-hint', '点击主舞台任意个体 · 追踪其一生');
    trackWrap.appendChild(trackEmpty);
    trackPanel.appendChild(trackWrap);
    scroll.appendChild(trackPanel);

    P.refs.right = {
      kpiNodes,
      usageNodes,
      usageNote,
      histCanvas,
      lorenzCanvas,
      seriesCanvas,
      stackedCanvas,
      classCanvas,
      classRowNodes,
      classFlowNodes,
      classFlow,
      talentNote,
      famRows,
      famBtnWealth,
      famBtnSize,
      guildSummary,
      gsNodes,
      guildTabs,
      guildTable,
      guildRows,
      guildEmpty,
      evRows,
      evEmpty,
      trackWrap,
      trackEmpty,
      chartCtx: {},
    };

    /* 图表实例 */
    P.charts.hist = new HistogramChart(histCanvas);
    P.charts.lorenz = new LorenzChart(lorenzCanvas);
    P.charts.series = new TimeSeriesChart(seriesCanvas);
    P.charts.stacked = new StackedAreaChart(stackedCanvas);
    P.charts.classBars = new ClassBarsChart(classCanvas);
  }

  /** 面板小节标题：中文 + 英文 + 右侧注释 */
  function sectionHead(title, en, note) {
    const head = el('div', 'panel-head');
    const t = el('div', 'ph-title');
    t.appendChild(el('span', 'ph-cn', title));
    t.appendChild(el('span', 'ph-en', en));
    head.appendChild(t);
    if (note) head.appendChild(el('span', 'ph-note', note));
    return head;
  }

  /* ============================ 中央舞台框架 ============================ */

  function buildStageFrame() {
    // 视图 Tab
    const tabs = root.viewTabs;
    tabs.textContent = '';
    const mk = (view, label, en) => {
      const b = el('button', 'view-tab' + (view === P.view ? ' active' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'vt-cn', label));
      b.appendChild(el('span', 'vt-en', en));
      b.addEventListener('click', () => P.actions.view(view));
      return b;
    };
    const bGalaxy = mk('galaxy', '策略星系', 'STRATEGY GALAXY');
    const bSkyline = mk('skyline', '财富天际线', 'WEALTH SKYLINE');
    tabs.appendChild(bGalaxy);
    tabs.appendChild(bSkyline);
    P.refs.viewTabs = { galaxy: bGalaxy, skyline: bSkyline };

    // 舞台 HUD
    root.hudTL.textContent = '';
    const hudDefs = [
      ['回合', 'hud-round'],
      ['存活', 'hud-alive'],
      ['总资产', 'hud-total'],
      ['基尼', 'hud-gini'],
    ];
    const hudNodes = {};
    for (const [label, key] of hudDefs) {
      const item = el('div', 'hud-item');
      item.appendChild(el('span', 'hud-k', label));
      const v = el('b', 'hud-v', '—');
      item.appendChild(v);
      root.hudTL.appendChild(item);
      hudNodes[key] = v;
    }
    root.hudTR.textContent = '';
    const trNodes = {};
    for (const [label, key] of [
      ['FPS', 'fps'],
      ['采样点', 'samples'],
      ['解析', 'parse'],
    ]) {
      const item = el('div', 'hud-item');
      item.appendChild(el('span', 'hud-k', label));
      const v = el('b', 'hud-v', '—');
      item.appendChild(v);
      root.hudTR.appendChild(item);
      trNodes[key] = v;
    }
    P.refs.stageHud = { ...hudNodes, ...trNodes };

    // 图例
    P.refs.legendChips = {};
    P._buildLegend();
  }

  P._buildLegend = function () {
    const legend = root.legend;
    const colors = P.refs.classColors || CLASS_COLORS;
    const names = P.refs.classNames || CLASS_NAMES;
    legend.textContent = '';
    const classGroup = el('div', 'legend-group');
    classGroup.appendChild(el('span', 'legend-title', '阶层'));
    for (let i = 0; i < 4; i++) {
      const chip = el('span', 'legend-chip');
      const dot = el('i', 'lg-dot');
      dot.style.background = colors[i] || CLASS_COLORS[i];
      chip.appendChild(dot);
      chip.appendChild(el('span', null, names[i] || CLASS_NAMES[i]));
      classGroup.appendChild(chip);
    }
    legend.appendChild(classGroup);
    if (P.view === 'galaxy') {
      const moveGroup = el('div', 'legend-group');
      moveGroup.appendChild(el('span', 'legend-title', '顶点'));
      for (let i = 0; i < 3; i++) {
        const chip = el('span', 'legend-chip');
        const dot = el('i', 'lg-tri');
        dot.style.borderColor = MOVE_COLORS[i];
        chip.appendChild(dot);
        chip.appendChild(el('span', null, MOVE_NAMES[i]));
        moveGroup.appendChild(chip);
      }
      legend.appendChild(moveGroup);
    }
    // 底部提示
    root.stageFoot.textContent =
      P.view === 'galaxy'
        ? '点击任意个体追踪其一生 · 滚轮缩放 · 拖拽平移 · 双击复位'
        : 'x = 固定泳道 · y = 财富对数轴 · 点击任意个体追踪 · 滚轮缩放 · 拖拽平移';
    P.refs.viewTabs && setViewButtons(P.view);
  };

  function setViewButtons(view) {
    const tabs = P.refs.viewTabs;
    if (!tabs) return;
    toggleClass(tabs.galaxy, 'active', view === 'galaxy');
    toggleClass(tabs.skyline, 'active', view === 'skyline');
  }

  P.setView = function (view) {
    P.view = view === 'skyline' ? 'skyline' : 'galaxy';
    P._buildLegend();
    setViewButtons(P.view);
  };

  /* ============================ 底栏 ============================ */

  function buildBottom() {
    const bar = root.bottom;
    bar.textContent = '';
    const left = el('div', 'bt-left');
    const dot = el('i', 'conn-dot');
    const text = el('span', 'conn-text', '连接中…');
    left.appendChild(dot);
    left.appendChild(text);
    bar.appendChild(left);

    const mid = el('div', 'bt-mid');
    const hudDefs = [
      ['rps', '回合/秒'],
      ['tick', 'tick'],
      ['analytics', '分析'],
      ['parallel', '并行'],
      ['frame', '帧大小'],
      ['samples', '采样点'],
      ['render', '渲染 FPS'],
      ['parse', '解析'],
      ['heap', 'JS 堆'],
    ];
    const nodes = {};
    for (const [key, label] of hudDefs) {
      const item = el('span', 'hud-item');
      item.appendChild(el('em', 'hud-k', label));
      const v = el('b', 'hud-v', '—');
      item.appendChild(v);
      mid.appendChild(item);
      nodes[key] = v;
    }
    bar.appendChild(mid);

    const right = el('div', 'bt-right');
    const ticker = el('span', 'event-ticker', '');
    const endText = el('span', 'end-text', '');
    right.appendChild(ticker);
    right.appendChild(endText);
    bar.appendChild(right);

    P.refs.bottom = { dot, text, nodes, ticker, endText };
  }

  /* ============================ 顶部提示条 ============================ */

  /** 构建顶部提示条（文字 + 关闭按钮），DOM 只创建一次，之后只改内容/显隐 */
  function buildAlertbar() {
    const bar = root.alertbar;
    if (!bar) return;
    bar.textContent = '';
    toggleClass(bar, 'hidden', true);
    const text = el('span', 'alert-text', '');
    text.id = 'alert-text';
    const close = el('button', 'alert-close', '✕');
    close.type = 'button';
    close.id = 'alert-close';
    close.title = '关闭提示';
    close.setAttribute('aria-label', '关闭提示');
    close.addEventListener('click', () => {
      toggleClass(bar, 'hidden', true);
    });
    bar.appendChild(text);
    bar.appendChild(close);
    P.refs.alert = { bar, text, close };
  }

  /* ============================ 初始化 ============================ */

  buildTopbar();
  buildLeft();
  buildRight();
  buildStageFrame();
  buildBottom();
  buildAlertbar();

  /* ============================ 配置元数据 ============================ */

  P.setMeta = function (meta) {
    P.meta = meta || null;
    const topbar = P.refs.topbar;
    // 预设下拉
    topbar.presetSel.textContent = '';
    const presets = (meta && meta.presets) || {};
    for (const name of Object.keys(presets)) {
      const opt = el('option', null, presets[name].label || name);
      opt.value = name;
      topbar.presetSel.appendChild(opt);
    }
    if (meta && meta.config) {
      // 若当前人口与某预设匹配则选中它
      const presetList = Object.keys(presets);
      let matched = '';
      for (const name of presetList) {
        const p = presets[name];
        if (p.initialPopulation && p.initialPopulation === meta.config.initialPopulation) matched = name;
      }
      if (matched) topbar.presetSel.value = matched;
      applyConfig(meta.config);
    }
    // 图例颜色以 meta 为准（若有）
    P.refs.classColors = (meta && meta.classColors) || CLASS_COLORS;
    P.refs.talentColors = (meta && meta.talentColors) || TALENT_COLORS;
    P.refs.talentNames = (meta && meta.talentNames) || TALENT_NAMES;
    P.refs.classNames = (meta && meta.classNames) || CLASS_NAMES;
    // 用服务端颜色刷新图例与阶层色块
    P._buildLegend();
    const classRows = P.refs.right && P.refs.right.classRowNodes;
    if (classRows) {
      for (let i = 0; i < classRows.length; i++) {
        if (classRows[i].chip) classRows[i].chip.style.background = P.refs.classColors[i] || CLASS_COLORS[i];
      }
    }
  };

  /* ============================ 连接状态 / 提示条 ============================ */

  P.setConnection = function (state, detail) {
    const b = P.refs.bottom;
    if (!b) return;
    toggleClass(b.dot, 'ok', state === 'connected');
    toggleClass(b.dot, 'warn', state === 'connecting');
    toggleClass(b.dot, 'bad', state === 'disconnected');
    const text = state === 'connected'
      ? '已连接 /api/stream'
      : state === 'connecting'
        ? '连接中… 等待数据'
        : '连接断开 · 指数退避重连中';
    setText(b.text, detail ? text + ' · ' + detail : text);
  };

  P.setAlert = function (msg) {
    const refs = P.refs.alert;
    const bar = refs ? refs.bar : root.alertbar;
    if (!bar) return;
    if (msg) {
      if (refs && refs.text) refs.text.textContent = String(msg);
      else setText(bar, String(msg));
      toggleClass(bar, 'hidden', false);
    } else {
      toggleClass(bar, 'hidden', true);
    }
  };

  /* ============================ 增量更新 ============================ */

  /**
   * 单帧 UI 更新（由 app.js 在 rAF 中 ≥80ms 节流调用）。
   * @param {object} frame protocol.parseFrame 的结果
   * @param {object} hud {fps, glOk, mapping, mode, parseMs, uploadMs, connected}
   */
  P.update = function (frame, hud) {
    if (!frame || !frame.snap) return;
    const snap = frame.snap;
    P.lastFrame = frame;
    P.lastSnap = snap;
    const h = hud || {};
    P._updateTopbar(snap);
    P._updateKpi(snap);
    P._updateUsage(snap);
    P._updateCharts(snap, h);
    P._updateClasses(snap);
    P._renderFamilyRows(snap);
    P._updateGuilds(snap);
    P._updateEvents(snap);
    P._updateTracked(snap, h);
    P._updateBottom(snap, h, frame);
    P._updateStageHud(snap, h);
    // WebGL 回退提示
    if (root.fallbackTag) toggleClass(root.fallbackTag, 'hidden', h.glOk !== false);
  };

  P._updateTopbar = function (snap) {
    const r = P.refs.topbar;
    if (!r) return;
    const eng = snap.engine;
    setText(r.roundVal, fmtInt(snap.round));
    setText(r.rpsVal, eng.roundsPerSec > 0 ? String(Math.round(eng.roundsPerSec)) : '0');
    // 状态徽章
    const status = eng.status;
    setText(r.badgeText, STATUS_TEXT[status] || status);
    r.badge.className = 'status-badge status-' + status;
    // 按钮可用性
    r.btnRun.disabled = status === 'running';
    r.btnPause.disabled = status !== 'running';
    r.btnStep.disabled = status !== 'paused';
    // 结束条件
    const ec = snap.endCondition;
    setText(r.endMode, '模式 ' + (ec.mode || 'C'));
    const label = ec.label || ('回合 ' + snap.round);
    setText(r.endLabel, label);
    setWidth(r.progressFill, clamp(ec.progress, 0, 1) * 100);
    // 速度滑条（避免覆盖用户正在拖动的值）
    const active = doc.activeElement;
    if (active !== r.speedRange) {
      const target = Math.round(eng.speedTarget || 0);
      if (String(target) !== r.speedRange.value) r.speedRange.value = String(target);
      setText(r.speedLabel, speedLabelText(target));
    }
  };

  P._updateKpi = function (snap) {
    const nodes = P.refs.right.kpiNodes;
    if (!nodes) return;
    const pop = snap.population;
    const w = snap.wealth;
    const infl = snap.inflation;
    const strategy = snap.strategy;
    setText(nodes.alive.value, fmtInt(pop.alive));
    setText(
      nodes.alive.sub,
      `初始 ${fmtInt(pop.initial)} · 出生 ${fmtInt(pop.births)} / 死亡 ${fmtInt(pop.deaths)}`,
    );
    setText(nodes.total.value, fmtNum(w.total));
    setText(nodes.total.sub, `均值 ${fmtNum(w.mean)} · 最大 ${fmtNum(w.max)}`);
    setText(nodes.mean.value, fmtNum(w.mean));
    setText(nodes.mean.sub, `中位 ${fmtNum(w.median)} · 负债占比 ${fmtPct(w.negativeShare, 1)}`);
    setText(nodes.gini.value, w.gini.toFixed(3));
    setText(nodes.gini.sub, `P90 ${fmtNum(w.p90)} · 最大/中位 ${(w.median > 0 ? w.max / w.median : 0).toFixed(1)}×`);
    setText(nodes.cost.value, fmtNum(infl.cost, 2));
    setText(nodes.cost.sub, `通胀 ×${(infl.factor || 1).toFixed(3)} · 基础 ${fmtNum(infl.baseCost)}`);
    setText(nodes.entropy.value, fmtEntropy(strategy.entropy));
    setText(
      nodes.entropy.sub,
      `偏好 石 ${fmtPct(strategy.preference[0], 1)} / 剪 ${fmtPct(strategy.preference[1], 1)} / 布 ${fmtPct(strategy.preference[2], 1)}`,
    );
  };

  P._updateUsage = function (snap) {
    const r = P.refs.right;
    const usage = snap.strategy.usage;
    const dominant = snap.strategy.dominant;
    for (let i = 0; i < 3; i++) {
      const u = usage[i];
      setWidth(r.usageNodes[i].fill, clamp(u, 0, 1) * 100);
      setText(r.usageNodes[i].pct, fmtPct(u, 1));
    }
    setText(
      r.usageNote,
      `主导分布 石 ${fmtPct(dominant[0], 1)} / 剪 ${fmtPct(dominant[1], 1)} / 布 ${fmtPct(dominant[2], 1)}`,
    );
  };

  P._updateCharts = function (snap, hud) {
    const r = P.refs.right;
    const mapping = hud.mapping;
    if (P.charts.hist) {
      const hist = P.lastFrame && P.lastFrame.sections ? P.lastFrame.sections.hist : null;
      P.charts.hist.render({
        hist: hist || null,
        mapping: mapping || null,
        median: snap.wealth.median,
        p90: snap.wealth.p90,
      });
    }
    if (P.charts.lorenz) {
      P.charts.lorenz.render({ lorenz: snap.wealth.lorenz, gini: snap.wealth.gini });
    }
    if (P.charts.series) {
      P.charts.series.render({ series: snap.series });
    }
    if (P.charts.stacked) {
      P.charts.stacked.render({ series: snap.series });
    }
    if (P.charts.classBars) {
      P.charts.classBars.render({ classes: snap.classes, classColors: r.classColors || P.refs.classColors });
    }
    P._renderClassRows(snap);
  };

  P._updateClasses = function (snap) {
    // 天赋分布摘要
    const r = P.refs.right;
    const talents = snap.talents || [];
    const names = P.refs.talentNames || TALENT_NAMES;
    const total = talents.reduce((a, b) => a + b, 0) || 1;
    const parts = [];
    for (let i = 1; i < talents.length; i++) {
      if (talents[i] > 0) parts.push(`${names[i]} ${fmtPct(talents[i] / total, 1)}`);
    }
    setText(r.talentNote, parts.length ? '天赋 ' + parts.join(' · ') : '天赋 —');
  };

  P._renderClassRows = function (snap) {
    const r = P.refs.right;
    const rows = r.classRowNodes;
    if (!rows) return;
    for (let i = 0; i < 4; i++) {
      const c = snap.classes[i];
      if (!c) continue;
      setText(rows[i].name, c.name);
      setText(rows[i].count, fmtInt(c.count));
      setText(rows[i].share, fmtPct(c.share, 1));
      setText(rows[i].wshare, fmtPct(c.wealthShare, 1));
      setText(rows[i].flow, `流入 ${fmtInt(c.flowIn)} · 流出 ${fmtInt(c.flowOut)}`);
    }
    // 阶层流动摘要（第 2 轮）
    const cf = snap.classFlow || {};
    const cfNodes = r.classFlowNodes;
    if (cfNodes) {
      setText(cfNodes.up, fmtInt(cf.up));
      setText(cfNodes.down, fmtInt(cf.down));
      setText(cfNodes.mobility, fmtPct(cf.mobility, 2));
    }
  };

  /* ── 公会排行（第 2 轮）── */

  P._updateGuilds = function (snap) {
    const r = P.refs.right;
    if (!r) return;
    const g = snap.guilds || { enabled: false, total: 0, wars: 0, treasuryTotal: 0, avgLevel: 0, topWealth: [], topMembers: [], topWars: [] };
    const enabled = !!g.enabled;
    toggleClass(r.guildTable, 'hidden', !enabled);
    toggleClass(r.guildSummary, 'hidden', !enabled);
    toggleClass(r.guildTabs, 'hidden', !enabled);
    toggleClass(r.guildEmpty, 'hidden', enabled);
    if (!enabled) {
      setText(r.guildEmpty, '未开启（在参数面板开启公会模式）');
      return;
    }
    setText(r.gsNodes.count, fmtInt(g.total));
    setText(r.gsNodes.avgLevel, 'Lv ' + (Number(g.avgLevel) || 0).toFixed(1));
    setText(r.gsNodes.treasury, fmtNum(g.treasuryTotal));
    setText(r.gsNodes.wars, fmtInt(g.wars) + ' 次');
    P._renderGuildRows(snap);
  };

  P._renderGuildRows = function (snap) {
    const r = P.refs.right;
    if (!r || !r.guildRows) return;
    const g = snap.guilds || {};
    const list = P.guildTab === 'members' ? g.topMembers || [] : P.guildTab === 'wars' ? g.topWars || [] : g.topWealth || [];
    for (let i = 0; i < r.guildRows.length; i++) {
      const rec = r.guildRows[i];
      const row = list[i];
      if (!row) {
        toggleClass(rec.row, 'hidden', true);
        continue;
      }
      toggleClass(rec.row, 'hidden', false);
      setText(rec.cells[0], String(i + 1));
      setText(rec.cells[1], row.name);
      const level = Math.round(Number(row.level) || 0);
      const lvText = 'Lv' + level;
      const lvCls = 'guild-lv ' + guildLevelClass(level);
      if (rec.cells[2].className !== lvCls) rec.cells[2].className = lvCls;
      setText(rec.cells[2], lvText);
      setText(rec.cells[3], fmtInt(row.members));
      setText(rec.cells[4], fmtNum(row.treasury));
      setText(rec.cells[5], fmtNum(row.totalWealth));
      setText(rec.cells[6], fmtInt(row.wins));
    }
  };

  /** 公会等级 → 彩色 chip 样式类（1-3 冷 / 4-6 青 / 7-8 金 / 9-10 红） */
  function guildLevelClass(level) {
    if (level >= 9) return 'lv-max';
    if (level >= 7) return 'lv-high';
    if (level >= 4) return 'lv-mid';
    return 'lv-low';
  }

  P._renderFamilyRows = function (snap) {
    const r = P.refs.right;
    if (!r || !r.famRows) return;
    const fam = snap.families;
    const list = (P.familyTab === 'size' ? fam.topSize : fam.topWealth) || [];
    for (let i = 0; i < 10; i++) {
      const row = r.famRows[i];
      const f = list[i];
      if (!f) {
        setText(row.cells[0], '—');
        setText(row.cells[1], '—');
        setText(row.cells[2], '—');
        setText(row.cells[3], '—');
        setText(row.cells[4], '—');
        continue;
      }
      setText(row.cells[0], String(i + 1));
      setText(row.cells[1], f.name);
      setText(row.cells[2], fmtNum(f.wealth));
      setText(row.cells[3], fmtInt(f.members));
      setText(row.cells[4], String(Math.round(f.generation || 0)));
    }
  };

  P._updateEvents = function (snap) {
    const r = P.refs.right;
    if (!r || !r.evRows) return;
    const events = snap.events || [];
    const rows = r.evRows;
    let newestKey = '';
    for (let i = 0; i < rows.length; i++) {
      const rec = rows[i];
      const ev = events[i];
      if (!ev) {
        toggleClass(rec.row, 'hidden', true);
        continue;
      }
      toggleClass(rec.row, 'hidden', false);
      const key = ev.round + '|' + ev.type + '|' + ev.title;
      if (i === 0) newestKey = key;
      if (rec.key !== key) {
        rec.key = key;
        setText(rec.round, 'R' + ev.round);
        setText(rec.tag, eventTagText(ev.type));
        rec.tag.className = 'ev-tag ev-' + String(ev.type || '').split('.')[0];
        setText(rec.title, ev.title);
        setText(rec.detail, ev.detail || '');
        const delta = Number(ev.delta) || 0;
        setText(rec.delta, fmtSigned(delta));
        rec.delta.className = 'ev-delta ' + (delta > 0 ? 'pos' : delta < 0 ? 'neg' : '');
      }
      // 新事件高亮动画
      if (i === 0 && P._lastEventKey && P._lastEventKey !== newestKey) {
        rec.row.classList.remove('flash');
        // 强制重排以重启动画（开销极小，仅新事件时触发）
        void rec.row.offsetWidth;
        rec.row.classList.add('flash');
      }
    }
    if (newestKey && newestKey !== P._lastEventKey) {
      P._lastEventKey = newestKey;
      setText(P.refs.bottom.ticker, events[0] ? `R${events[0].round} ${events[0].title}` : '');
    }
    toggleClass(r.evEmpty, 'hidden', events.length > 0);
  };

  P._updateTracked = function (snap, hud) {
    const r = P.refs.right;
    if (!r) return;
    const list = (snap.tracked || []).slice(0, 8);
    const ids = list.map((t) => t.id);
    const key = ids.join(',');
    P._trackedKey = P._trackedKey || '';
    if (key !== P._trackedKey) {
      P._trackedKey = key;
      // 重建卡片（仅在追踪集合变化时发生，最多 8 张）
      const wrap = r.trackWrap;
      // 移除旧卡片
      for (const node of Array.from(wrap.children)) {
        if (node !== r.trackEmpty) wrap.removeChild(node);
      }
      P._trackedCards = new Map();
      for (const t of list) {
        const card = buildTrackedCard(t, hud);
        wrap.appendChild(card.node);
        P._trackedCards.set(t.id, card);
      }
      toggleClass(r.trackEmpty, 'hidden', list.length > 0);
    }
    if (P._trackedCards) {
      for (const t of list) {
        const card = P._trackedCards.get(t.id);
        if (!card) continue;
        updateTrackedCard(card, t, hud);
      }
    }
    P.tracked = ids;
  };

  function buildTrackedCard(t, hud) {
    const card = el('div', 'tracked-card');
    const head = el('div', 'tc-head');
    const idNode = el('b', 'tc-id', t.name || '#' + t.id);
    const badge = el('span', 'tc-badge class-0', '底层');
    const close = el('button', 'tc-close', '✕');
    close.type = 'button';
    close.title = '取消追踪';
    close.addEventListener('click', () => {
      P.actions.control('untrack', { id: t.id });
      P._trackedKey = ''; // 下一帧服务端数据为准
    });
    head.appendChild(idNode);
    head.appendChild(badge);
    head.appendChild(close);
    card.appendChild(head);

    const grid = el('div', 'tc-grid');
    const gridNodes = {};
    for (const [key, label] of [
      ['asset', '资产'],
      ['age', '年龄'],
      ['talent', '天赋'],
      ['generation', '代数'],
      ['win', '胜/负/平'],
      ['repro', '繁殖'],
    ]) {
      const item = el('div', 'tc-item');
      item.appendChild(el('span', 'tc-k', label));
      const v = el('b', 'tc-v', '—');
      item.appendChild(v);
      grid.appendChild(item);
      gridNodes[key] = v;
    }
    card.appendChild(grid);

    const strat = el('div', 'tc-strategy');
    const stratFills = [];
    const stratPcts = [];
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'tc-srow');
      row.appendChild(el('span', 'tc-sname', MOVE_NAMES[i]));
      const track = el('div', 'tc-strack');
      const fill = el('i', 'tc-sfill');
      fill.style.background = MOVE_COLORS[i];
      track.appendChild(fill);
      row.appendChild(track);
      const pct = el('span', 'tc-spct', '—');
      row.appendChild(pct);
      strat.appendChild(row);
      stratFills.push(fill);
      stratPcts.push(pct);
    }
    card.appendChild(strat);

    const sparkCanvas = el('canvas', 'tc-spark');
    card.appendChild(sparkCanvas);
    const spark = new Sparkline(sparkCanvas);

    const foot = el('div', 'tc-foot');
    const famNode = el('span', 'tc-fam', '家族 —');
    const parentsNode = el('span', 'tc-parents', '');
    foot.appendChild(famNode);
    foot.appendChild(parentsNode);
    card.appendChild(foot);

    return { node: card, id: t.id, idNode, badge, gridNodes, stratFills, stratPcts, spark, famNode, parentsNode, lastRound: -1 };
  }

  function updateTrackedCard(card, t, hud) {
    const names = P.refs.classNames || CLASS_NAMES;
    setText(card.idNode, t.name || '#' + t.id);
    const cls = clamp(t.classId | 0, 0, 3);
    setText(card.badge, names[cls] || CLASS_NAMES[cls]);
    card.badge.className = 'tc-badge class-' + cls;
    setText(card.gridNodes.asset, fmtNum(t.asset));
    setText(card.gridNodes.age, fmtAge(t.age));
    setText(card.gridNodes.talent, t.talentName || '无');
    setText(card.gridNodes.generation, '第 ' + (t.generation || 1) + ' 代');
    setText(card.gridNodes.win, `${t.wins} / ${t.losses} / ${t.draws}`);
    setText(card.gridNodes.repro, String(t.reproCount || 0));
    for (let i = 0; i < 3; i++) {
      const p = t.strategy ? t.strategy[i] : 0;
      setWidth(card.stratFills[i], clamp(p, 0, 1) * 100);
      setText(card.stratPcts[i], fmtPct(p, 1));
    }
    if (t.family) setText(card.famNode, '家族 ' + t.family.name);
    else setText(card.famNode, '家族 —');
    if (t.parents && t.parents.length) setText(card.parentsNode, '父母 #' + t.parents.join(' / #'));
    else setText(card.parentsNode, '');
    // sparkline 仅在新历史点时重绘
    const hist = t.history || [];
    const lastRound = hist.length ? hist[hist.length - 1][0] : -1;
    if (lastRound !== card.lastRound) {
      card.lastRound = lastRound;
      card.spark.render({ history: hist });
    }
  }

  P._updateBottom = function (snap, hud, frame) {
    const b = P.refs.bottom;
    if (!b) return;
    const eng = snap.engine;
    const perf = snap.perf;
    const gl = hud.glStats || {};
    setText(b.nodes.rps, eng.roundsPerSec > 0 ? eng.roundsPerSec.toFixed(1) : '0');
    setText(b.nodes.tick, fmtMs(eng.tickMs));
    setText(b.nodes.analytics, fmtMs(perf.analyticsMs));
    // 并行线程数（真实引擎）/ 单线程标记
    const workers = eng.parallelWorkers || 0;
    setText(b.nodes.parallel, workers > 0 ? workers + ' 线程' : eng.shared ? '共享内存' : '单线程');
    setText(b.nodes.frame, fmtBytes(frame.byteLength));
    setText(b.nodes.samples, fmtInt(perf.sampleCount || (frame.meta && frame.meta.sampleCount) || 0));
    setText(b.nodes.render, String(gl.fps !== undefined ? gl.fps : hud.fps || 0));
    setText(b.nodes.parse, hud.parseMs !== undefined ? hud.parseMs.toFixed(2) + ' ms' : '—');
    setText(b.nodes.heap, perf.heapUsedMB > 0 ? perf.heapUsedMB.toFixed(0) + ' MB' : '—');
    // 结束条件 / 暂停提示
    let endMsg = '';
    if (eng.status === 'ended') endMsg = '已结束 · ' + (eng.endReason || snap.endCondition.label || '结束条件达成');
    else if (eng.status === 'paused') endMsg = '已暂停 · ' + (snap.endCondition.label || '');
    else endMsg = snap.endCondition.label || '';
    setText(b.endText, endMsg);
  };

  P._updateStageHud = function (snap, hud) {
    const h = P.refs.stageHud;
    if (!h) return;
    setText(h['hud-round'], fmtInt(snap.round));
    setText(h['hud-alive'], fmtInt(snap.population.alive));
    setText(h['hud-total'], fmtNum(snap.wealth.total));
    setText(h['hud-gini'], snap.wealth.gini.toFixed(3));
    setText(h.fps, String(hud.glStats && hud.glStats.fps !== undefined ? hud.glStats.fps : hud.fps || 0));
    setText(h.samples, fmtInt((hud.glStats && hud.glStats.points) || snap.perf.sampleCount || 0));
    setText(h.parse, hud.parseMs !== undefined ? hud.parseMs.toFixed(2) + ' ms' : '—');
  };

  /* ============================ 对外 API ============================ */

  P.getConfigPatch = collectConfigPatch;
  P.applyConfig = applyConfig;
  P.getView = () => P.view;
  P.getFieldCount = () => P.fields.size;
  P.getTrackedCount = () => (P._trackedCards ? P._trackedCards.size : 0);
  P.getChartStats = () => P.charts;
  P.snapshotDomCounts = () => countDom(root);

  return P;
}

/* ────────────────────────────── 杂项 ────────────────────────────── */

function eventTagText(type) {
  const t = String(type || '');
  if (t.startsWith('macro')) return '宏观';
  if (t.startsWith('plague')) return '瘟疫';
  if (t.startsWith('population')) return '人口';
  if (t.startsWith('family')) return '家族';
  return '事件';
}

/** 统计已构建的 DOM 节点数量（自检用） */
function countDom(root) {
  let count = 0;
  const walk = (node) => {
    if (!node) return;
    count++;
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
  };
  for (const key of Object.keys(root)) {
    if (key === 'viewTabs' || key === 'legendChips') continue;
    walk(root[key]);
  }
  return count;
}
