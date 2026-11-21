/**
 * test/web-dom-stub.js — Node 端最小 DOM / Canvas2D / WebGL2 桩
 *
 * 供 test/web-stub.test.js 与「真实后端端到端联调脚本」复用：
 * 在 Node 中安装 window/document/canvas/WebGL2/rAF 等最小桩，
 * 使 web/js 的原生浏览器模块可以真实执行，从而在无浏览器环境下做验收。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/** 保存 Node 原生 fetch，桩环境里用它访问本地假服务器 */
const nativeFetch = globalThis.fetch;

/* ────────────────────────────── 最小 DOM 桩 ────────────────────────────── */

class ClassList {
  constructor(node) {
    this.node = node;
  }
  _set() {
    if (!this.node.__classes) this.node.__classes = new Set();
    return this.node.__classes;
  }
  add(...names) {
    for (const n of names) this._set().add(n);
    this.node.__syncClass();
  }
  remove(...names) {
    for (const n of names) this._set().delete(n);
    this.node.__syncClass();
  }
  contains(name) {
    return this._set().has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this._set().add(name);
    else this._set().delete(name);
    this.node.__syncClass();
    return on;
  }
}

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.__className = '';
    this.__classes = new Set();
    this.__ownText = '';
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.childNodes = this.children; // 与 children 同一数组，模拟浏览器 childNodes 同步
    this.parentNode = null;
    this._listeners = Object.create(null);
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.width = 0;
    this.height = 0;
    this.classList = new ClassList(this);
  }
  __syncClass() {
    this.__className = Array.from(this.__classes).join(' ');
  }
  get className() {
    return this.__className;
  }
  set className(v) {
    this.__className = v == null ? '' : String(v);
    this.__classes = new Set(this.__className.split(/\s+/).filter(Boolean));
  }
  get textContent() {
    let out = this.__ownText;
    for (const child of this.children) out += child.textContent;
    return out;
  }
  set textContent(v) {
    this.__ownText = v == null ? '' : String(v);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.childNodes = this.children;
  }
  get firstChild() {
    return this.children.length ? this.children[0] : null;
  }
  get lastChild() {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  insertBefore(child, ref) {
    const idx = this.children.indexOf(ref);
    if (idx < 0) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(idx, 0, child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event) {
    const list = this._listeners[type] || [];
    const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event || {});
    for (const fn of list.slice()) fn(ev);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    const r = RECTS[this.id];
    if (r) return { x: r[0], y: r[1], left: r[0], top: r[1], width: r[2], height: r[3], right: r[0] + r[2], bottom: r[1] + r[3] };
    return { x: 0, y: 0, left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 };
  }
  get clientWidth() {
    if (this.id === 'gl-canvas' || this.id === 'overlay-canvas') return 920;
    if (this.tagName === 'CANVAS') return 328;
    return 300;
  }
  get clientHeight() {
    if (this.id === 'gl-canvas' || this.id === 'overlay-canvas') return 740;
    if (this.tagName === 'CANVAS') return chartCanvasHeight(this.className);
    return 24;
  }
  get offsetWidth() {
    return this.clientWidth;
  }
  get offsetHeight() {
    return this.clientHeight;
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }
}

class StubCanvas extends StubElement {
  constructor() {
    super('canvas');
    this._ctx2d = null;
    this._gl = null;
  }
  getContext(kind) {
    if (kind === '2d') {
      if (!this._ctx2d) this._ctx2d = create2dContext(this);
      return this._ctx2d;
    }
    if (kind === 'webgl2') {
      if (!this._gl) this._gl = createGlContext(this);
      return this._gl;
    }
    return null;
  }
}

function chartCanvasHeight(className) {
  const c = String(className || '');
  if (c.includes('chart-hist')) return 92;
  if (c.includes('chart-lorenz')) return 124;
  if (c.includes('chart-series')) return 118;
  if (c.includes('chart-stacked')) return 96;
  if (c.includes('chart-class')) return 56;
  if (c.includes('tc-spark')) return 28;
  return 100;
}

/** 固定布局矩形（模拟 1600×900 下 CSS Grid 的测量结果） */
const RECTS = {
  topbar: [0, 0, 1600, 56],
  left: [0, 56, 300, 810],
  center: [300, 56, 940, 810],
  right: [1240, 56, 360, 810],
  bottom: [0, 866, 1600, 34],
  'gl-canvas': [310, 90, 920, 740],
  'overlay-canvas': [310, 90, 920, 740],
};

/* ----- Canvas2D 记录桩（统计指令数、校验坐标有限、伪造像素读回） ----- */

const ctx2dRegistry = [];

function create2dContext(canvas) {
  const ctx = {
    canvas,
    ops: 0,
    invalid: 0,
    textOps: 0,
    fillOps: 0,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px monospace',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: 'transparent',
    shadowBlur: 0,
    imageSmoothingEnabled: true,
  };
  const numeric = (name, args, from = 0) => {
    for (let i = from; i < args.length; i++) {
      const v = args[i];
      if (typeof v === 'number' && !Number.isFinite(v)) {
        ctx.invalid++;
        throw new Error(`Canvas2D ${name} 收到非法数值参数: ${String(v)}`);
      }
    }
  };
  const drawMethods = [
    'clearRect', 'setTransform', 'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
    'stroke', 'fill', 'closePath', 'fillRect', 'strokeRect', 'fillText', 'strokeText',
    'arc', 'rect', 'setLineDash', 'translate', 'scale', 'rotate', 'clip',
    'quadraticCurveTo', 'bezierCurveTo', 'roundRect', 'drawImage', 'resetTransform',
  ];
  for (const name of drawMethods) {
    ctx[name] = (...args) => {
      numeric(name, args);
      ctx.ops++;
      if (name === 'fillText' || name === 'strokeText') ctx.textOps++;
      if (name === 'fill' || name === 'fillRect' || name === 'stroke' || name === 'strokeRect') ctx.fillOps++;
    };
  }
  ctx.createLinearGradient = (...args) => {
    numeric('createLinearGradient', args);
    ctx.ops++;
    return { addColorStop() {} };
  };
  ctx.createRadialGradient = (...args) => {
    numeric('createRadialGradient', args);
    ctx.ops++;
    return { addColorStop() {} };
  };
  ctx.createPattern = () => null;
  ctx.measureText = (text) => ({ width: String(text == null ? '' : text).length * 6 });
  ctx.getImageData = (x, y, w, h) => {
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    const data = new Uint8ClampedArray(width * height * 4);
    if (ctx.ops > 15) data.fill(255); // 有绘制指令 → 视为“已绘制”
    return { data, width, height };
  };
  ctx.putImageData = () => {};
  ctx2dRegistry.push(ctx);
  return ctx;
}

/* ----- WebGL2 记录桩 ----- */

const glStats = {
  createProgram: 0,
  linkProgram: 0,
  drawArrays: [],
  bufferData: 0,
  bufferSubData: 0,
  texImage2D: 0,
  texSubImage2D: 0,
  clear: 0,
  uniforms: 0,
  attribPointers: 0,
  byMode: Object.create(null),
};
const GL_ENUM = {
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  POINTS: 0, TRIANGLE_STRIP: 5, TRIANGLES: 4,
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, R8: 0x8229, RED: 0x1903,
  UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, LINEAR: 0x2601, NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, UNPACK_ALIGNMENT: 0x0cf5,
  DEPTH_TEST: 0x0b71, BLEND: 0x0be2, SRC_ALPHA: 0x0302, ONE: 1,
  COLOR_BUFFER_BIT: 0x4000, RGBA: 0x1908,
};
const ATTRIB_LOCS = { aPos: 0, aClass: 1, aWealth: 2, aStreak: 3 };

function createGlContext(canvas) {
  const gl = Object.assign({}, GL_ENUM, {
    canvas,
    drawingBufferWidth: 920,
    drawingBufferHeight: 740,
    __calls: glStats,
  });
  gl.createShader = () => ({ kind: 'shader' });
  gl.shaderSource = () => {};
  gl.compileShader = () => {};
  gl.getShaderParameter = () => true;
  gl.getShaderInfoLog = () => '';
  gl.createProgram = () => {
    glStats.createProgram++;
    return { kind: 'program' };
  };
  gl.attachShader = () => {};
  gl.linkProgram = () => {
    glStats.linkProgram++;
  };
  gl.getProgramParameter = () => true;
  gl.getProgramInfoLog = () => '';
  gl.getUniformLocation = (prog, name) => ({ name });
  gl.getAttribLocation = (prog, name) => (ATTRIB_LOCS[name] !== undefined ? ATTRIB_LOCS[name] : 0);
  gl.createVertexArray = () => ({ kind: 'vao' });
  gl.bindVertexArray = () => {};
  gl.deleteVertexArray = () => {};
  gl.createBuffer = () => ({ kind: 'buffer' });
  gl.bindBuffer = () => {};
  gl.deleteBuffer = () => {};
  gl.bufferData = (target, data, usage) => {
    glStats.bufferData++;
    if (typeof data !== 'number' && data && data.byteLength === undefined) throw new Error('bufferData 收到非法 data');
  };
  gl.bufferSubData = (target, offset, data) => {
    glStats.bufferSubData++;
    if (!data || data.byteLength === undefined) throw new Error('bufferSubData 需要 TypedArray');
  };
  gl.createTexture = () => ({ kind: 'texture' });
  gl.bindTexture = () => {};
  gl.deleteTexture = () => {};
  gl.texParameteri = () => {};
  gl.pixelStorei = () => {};
  gl.activeTexture = () => {};
  gl.texImage2D = () => {
    glStats.texImage2D++;
  };
  gl.texSubImage2D = () => {
    glStats.texSubImage2D++;
  };
  gl.generateMipmap = () => {};
  gl.useProgram = () => {};
  gl.enableVertexAttribArray = () => {};
  gl.vertexAttribPointer = () => {
    glStats.attribPointers++;
  };
  gl.uniform1i = () => {
    glStats.uniforms++;
  };
  gl.uniform1f = () => {
    glStats.uniforms++;
  };
  gl.uniform2f = () => {
    glStats.uniforms++;
  };
  gl.uniform3fv = () => {
    glStats.uniforms++;
  };
  gl.uniform4f = () => {
    glStats.uniforms++;
  };
  gl.uniformMatrix4fv = () => {};
  gl.enable = () => {};
  gl.disable = () => {};
  gl.blendFunc = () => {};
  gl.blendFuncSeparate = () => {};
  gl.depthMask = () => {};
  gl.clearColor = () => {};
  gl.clear = () => {
    glStats.clear++;
  };
  gl.viewport = () => {};
  gl.drawArrays = (mode, first, count) => {
    if (!Number.isFinite(count) || count <= 0) throw new Error(`drawArrays count 非法: ${count}`);
    const key = String(mode);
    glStats.byMode[key] = (glStats.byMode[key] || 0) + 1;
    glStats.drawArrays.push({ mode, first, count });
  };
  gl.drawElements = () => {
    throw new Error('不应使用 drawElements');
  };
  gl.readPixels = (x, y, w, h, format, type, buf) => {
    if (buf && buf.fill) buf.fill(64);
  };
  gl.getExtension = () => null;
  gl.getParameter = () => 0;
  gl.getError = () => 0;
  gl.deleteShader = () => {};
  gl.deleteProgram = () => {};
  gl.pixelStorei = () => {};
  gl.uniform3f = () => {};
  return gl;
}

/* ----- document 桩 ----- */

function parseSelectorPart(part) {
  const m = String(part).trim().match(/^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/);
  if (!m) return null;
  return {
    tag: m[1] || null,
    id: m[2] || null,
    classes: m[3] ? m[3].split('.').filter(Boolean) : [],
  };
}

function matchesPart(node, part) {
  if (!part || !node || !node.tagName) return false;
  if (part.tag && node.tagName !== part.tag.toUpperCase()) return false;
  if (part.id && node.id !== part.id) return false;
  for (const cls of part.classes) {
    if (!node.classList.contains(cls)) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  for (const group of groups) {
    const parts = group.split(/\s+/).filter(Boolean).map(parseSelectorPart);
    if (parts.some((p) => !p)) continue;
    let idx = parts.length - 1;
    if (!matchesPart(node, parts[idx])) continue;
    idx--;
    let cur = node.parentNode;
    while (idx >= 0 && cur) {
      if (matchesPart(cur, parts[idx])) idx--;
      cur = cur.parentNode;
    }
    if (idx < 0) return true;
  }
  return false;
}

function walk(node, fn) {
  for (const child of node.children) {
    fn(child);
    walk(child, fn);
  }
}

function queryAll(root, selector) {
  const out = [];
  walk(root, (node) => {
    if (matchesSelector(node, selector)) out.push(node);
  });
  return out;
}

function createDocument() {
  const body = new StubElement('body');
  const documentShim = {
    body,
    head: new StubElement('head'),
    documentElement: new StubElement('html'),
    activeElement: null,
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return new StubCanvas();
      return new StubElement(tag);
    },
    createTextNode(text) {
      const node = new StubElement('text');
      node.textContent = text;
      return node;
    },
    getElementById(id) {
      let found = null;
      walk(body, (node) => {
        if (!found && node.id === id) found = node;
      });
      return found;
    },
    querySelectorAll(selector) {
      return queryAll(body, selector);
    },
    querySelector(selector) {
      return queryAll(body, selector)[0] || null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return documentShim;
}

/** 构建与 web/index.html 一致的骨架 DOM（从真实 index.html 解析，确保 id/结构不脱节） */
const VOID_TAGS = new Set(['meta', 'link', 'br', 'img', 'input', 'hr', 'source']);

function parseAttrs(attrStr) {
  const out = [];
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(attrStr || ''))) out.push([m[1], m[2] === undefined ? '' : m[2]]);
  return out;
}

/** 极简 HTML 解析（本项目的 index.html 结构简单且规范，足够校验骨架） */
function loadIndexHtml() {
  return readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
}

function buildSkeleton(doc) {
  const html = loadIndexHtml();
  const bodyOpen = html.indexOf('<body>');
  const bodyClose = html.lastIndexOf('</body>');
  assert.ok(bodyOpen >= 0 && bodyClose > bodyOpen, 'index.html 必须包含 <body>');
  const bodyHtml = html.slice(bodyOpen + '<body>'.length, bodyClose).replace(/<!--[\s\S]*?-->/g, '');
  const stack = [doc.body];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(bodyHtml))) {
    const closing = m[1] === '/';
    const tagName = m[2].toLowerCase();
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = doc.createElement(tagName);
    for (const [key, value] of parseAttrs(m[3])) {
      if (key === 'class') node.className = value;
      else if (key === 'id') node.id = value;
      else if (key === 'type') node.type = value;
      else node.setAttribute(key, value);
    }
    stack[stack.length - 1].appendChild(node);
    if (!m[4] && !VOID_TAGS.has(tagName)) stack.push(node);
  }
  // 关键 id 必须全部存在（防止 index.html 与 app/panels 的契约脱节）
  const requiredIds = [
    'app', 'topbar', 'left', 'center', 'right', 'bottom', 'view-tabs', 'stage-legend',
    'stage-wrap', 'gl-canvas', 'overlay-canvas', 'stage-hud-tl', 'stage-hud-tr',
    'gl-fallback-tag', 'stage-foot', 'alertbar', 'crash',
  ];
  const missing = requiredIds.filter((id) => !doc.getElementById(id));
  assert.deepEqual(missing, [], 'index.html 缺少必需节点: ' + missing.join(', '));
  assert.ok(html.includes('/css/style.css'), 'index.html 应引用 /css/style.css');
  assert.ok(html.includes('type="module"') && html.includes('/js/app.js'), 'index.html 应以 ESM 方式加载 /js/app.js');
  return { app: doc.getElementById('app'), html };
}

/** 安装全局桩，返回 driver */
function installDomStub(options = {}) {
  const errors = [];
  const doc = createDocument();
  const skeleton = buildSkeleton(doc);

  const rafQueue = [];
  const requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  const cancelAnimationFrame = () => {};
  const rafTimer = setInterval(() => {
    const t = performance.now();
    const pending = rafQueue.splice(0);
    for (const cb of pending) {
      try {
        cb(t);
      } catch (err) {
        errors.push(err);
      }
    }
  }, 16);
  rafTimer.unref();

  const search = options.search !== undefined ? options.search : '?mock=1';
  const origin = options.origin || 'http://127.0.0.1:8090';
  const locationShim = {
    search,
    href: origin + '/' + search,
    host: origin.replace(/^https?:\/\//, ''),
    hostname: '127.0.0.1',
    origin,
    protocol: 'http:',
    pathname: '/',
  };
  const windowListeners = Object.create(null);
  const windowShim = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: locationShim,
    addEventListener(type, fn) {
      (windowListeners[type] || (windowListeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    requestAnimationFrame,
    cancelAnimationFrame,
    performance: globalThis.performance,
  };

  const realFetch = options.realFetch || null;
  globalThis.window = windowShim;
  globalThis.document = doc;
  globalThis.location = locationShim;
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = requestAnimationFrame;
  globalThis.cancelAnimationFrame = cancelAnimationFrame;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.fetch = realFetch
    ? (input, init) => realFetch(new URL(String(input), origin).href, init)
    : async () => {
        throw new Error('stub 环境不访问网络');
      };

  return {
    doc,
    skeleton,
    windowShim,
    windowListeners,
    errors,
    ctx2dRegistry,
    glStats,
    stop() {
      clearInterval(rafTimer);
      rafQueue.length = 0;
    },
  };
}
export { installDomStub, nativeFetch, ctx2dRegistry, glStats };
