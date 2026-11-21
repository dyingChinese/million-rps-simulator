/**
 * glview.js — WebGL2 主舞台渲染器（策略星系 / 财富天际线 双视图）
 *
 * 性能硬指标（PROTOCOL §7 / UI-SPEC）：
 *  - program / VAO / buffer / texture 只在初始化时创建一次；
 *  - 每帧点云只做 1 次 drawArrays(POINTS)，热图只做 1 次 quad drawArrays(TRIANGLE_STRIP)；
 *  - 点数据用 bufferSubData、密度纹理用 texSubImage2D 复用，不每帧重建；
 *  - 点云坐标变换全部在顶点着色器内完成（GPU 侧），CPU 只上传原始 stride-7 数据。
 *
 * 交互：滚轮缩放 0.5x~8x、拖拽平移、双击复位、点击就近采样点 → 回调 onPick(id)。
 * 叠加层（2D）：策略三角边框与顶点标签、财富轴网格线、直方图轮廓、选中/追踪标记。
 */

import { CLASS_RGB, PTS_STRIDE } from './protocol.js';

/** 财富轴标签：从 wealthY 反推资产值由外部注入（setWealthLabels） */
const GRID_Y_LEVELS = [0, 0.25, 0.5, 0.75, 1];

const VS_POINTS = `#version 300 es
layout(location = 0) in vec2 aPos;      // uv: 策略视图=(stratX, stratY/0.866) / 财富视图=(laneX, wealthY)
layout(location = 1) in float aClass;   // 阶层 id 0..3
layout(location = 2) in float aWealth;  // wealthY 0..1
layout(location = 3) in float aStreak;  // streakNorm -1..1
uniform vec2 uScale;
uniform vec2 uPan;
uniform float uPointSize;
uniform vec3 uClassColor[4];
out vec3 vColor;
out float vAlpha;
void main() {
  int ci = int(aClass + 0.5);
  if (ci < 0) ci = 0; else if (ci > 3) ci = 3;
  vec3 col = uClassColor[ci];
  float bright = 0.50 + 0.85 * aWealth + 0.28 * aStreak;
  vColor = col * clamp(bright, 0.22, 1.8);
  vAlpha = 0.15 + 0.36 * aWealth + 0.10 * max(aStreak, 0.0);
  vec2 clip = (aPos * 2.0 - 1.0) * uScale + uPan;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = clamp(uPointSize * (0.80 + 0.70 * aWealth), 1.0, 7.0);
}`;

const FS_POINTS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d) * 4.0;
  float soft = 1.0 - smoothstep(0.20, 1.0, r); // 圆形软边，去掉方形边缘
  if (soft <= 0.004) discard;
  outColor = vec4(vColor, vAlpha * soft);
}`;

const VS_QUAD = `#version 300 es
layout(location = 0) in vec2 aPos; // -1..1
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_QUAD = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uGrid;
uniform float uMode; // 0 = 策略星系（密度热图），1 = 财富天际线（背景渐变）
out vec4 outColor;

vec3 densityRamp(float n) {
  vec3 cold = vec3(0.035, 0.085, 0.22);
  vec3 mid  = vec3(0.10, 0.52, 0.92);
  vec3 hot  = vec3(0.62, 0.95, 1.0);
  return mix(mix(cold, mid, smoothstep(0.02, 0.62, n)), hot, smoothstep(0.62, 1.0, n));
}

void main() {
  vec3 bg = mix(vec3(0.018, 0.028, 0.050), vec3(0.042, 0.072, 0.128), vUv.y);
  // 舞台中心的极淡辉光
  float d = length(vUv - vec2(0.5, 0.52));
  bg += vec3(0.020, 0.035, 0.055) * (1.0 - smoothstep(0.0, 0.75, d)) * 0.8;
  if (uMode > 0.5) {
    outColor = vec4(bg, 1.0);
    return;
  }
  float n = texture(uGrid, vUv).r;
  n = pow(clamp(n, 0.0, 1.0), 1.1);
  // 策略三角内部遮罩：顶点 石(0,0) / 剪(0.5,1) / 布(1,0)
  float d1 = vUv.y;
  float d2 = vUv.x - 0.5 * vUv.y;
  float d3 = 1.0 - vUv.x - 0.5 * vUv.y;
  float inside = smoothstep(-0.010, 0.014, min(min(d1, d2), d3));
  vec3 col = bg * (1.0 - 0.88 * inside) + densityRamp(n) * inside * (0.85 + 0.5 * n);
  outColor = vec4(col, 1.0);
}`;

export class GlStage {
  /**
   * @param {HTMLCanvasElement} canvas WebGL2 画布
   * @param {HTMLCanvasElement} overlay 叠加 2D 画布（交互事件也挂在这里）
   */
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.overlayCtx = overlay ? overlay.getContext('2d') : null;
    this.gl = null;
    this.glOk = false;
    this.view = 'galaxy';
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.cssW = 800;
    this.cssH = 600;
    this.dpr = 1;
    this.pxW = 800;
    this.pxH = 600;

    /** @type {object|null} 最近一帧（保持引用以让 TypedArray 视图存活） */
    this.frame = null;
    this.pts = null;
    this.ids = null;
    this.sampleCount = 0;
    this.hist = null;
    this.mapping = null;
    this.trackedIds = new Set();
    this.trackedPoints = [];
    this.selectedId = -1;
    this.selectedPoint = null;

    /** 回调与统计 */
    this.onPick = null;
    this.stats = {
      fps: 0,
      drawCalls: 0,
      points: 0,
      frameMs: 0,
      uploadMs: 0,
      bufferDataCalls: 0,
      bufferSubDataCalls: 0,
      texImageCalls: 0,
      texSubImageCalls: 0,
      drawArraysTotal: 0,
      renders: 0,
    };
    this._frames = 0;
    this._fpsT0 = 0;
    this._fallbackPoints = null;

    /** 交互内部状态 */
    this._drag = null;
    this._moved = false;
    this._lastClick = 0;

    this._pointBufBytes = 0;
    this._gridW = 0;
    this._gridH = 0;
    this._r8 = null;
    this._uniforms = {};
    this._attribs = {};

    this._bindEvents();
  }

  /* ───────────────────────── 初始化 ───────────────────────── */

  init() {
    const opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    };
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', opts);
    } catch (err) {
      gl = null;
    }
    this.glOk = !!gl;
    if (!gl) {
      // 回退：用叠加层 2D 绘制散点，保证舞台不是空白
      this.gl = null;
      this.resize();
      return false;
    }
    this.gl = gl;
    const pointProg = this._createProgram(VS_POINTS, FS_POINTS);
    const quadProg = this._createProgram(VS_QUAD, FS_QUAD);
    if (!pointProg || !quadProg) {
      this.glOk = false;
      this.gl = null;
      this.resize();
      return false;
    }
    this.pointProg = pointProg;
    this.quadProg = quadProg;
    this._uniforms.point = {
      scale: gl.getUniformLocation(pointProg, 'uScale'),
      pan: gl.getUniformLocation(pointProg, 'uPan'),
      pointSize: gl.getUniformLocation(pointProg, 'uPointSize'),
      classColor: gl.getUniformLocation(pointProg, 'uClassColor'),
    };
    this._uniforms.quad = {
      grid: gl.getUniformLocation(quadProg, 'uGrid'),
      mode: gl.getUniformLocation(quadProg, 'uMode'),
    };
    // 静态全屏 quad
    this.quadVao = gl.createVertexArray();
    this.quadBuf = gl.createBuffer();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const quadLoc = gl.getAttribLocation(quadProg, 'aPos');
    gl.enableVertexAttribArray(quadLoc);
    gl.vertexAttribPointer(quadLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // 点云 VAO + 动态缓冲
    this.pointVao = gl.createVertexArray();
    this.pointBuf = gl.createBuffer();
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    this._setupPointAttribs();
    gl.bindVertexArray(null);

    // 密度纹理（先建 1×1 占位，避免首帧 sampling 不完整纹理）
    this.gridTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // 加法混合 → 星云感

    // 上下文丢失：阻止默认行为以便自动恢复，同时标记
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.glOk = false;
    });
    this.resize();
    return true;
  }

  /** 建立 stride=7 的交错属性指针（两视图共用同一块缓冲，偏移不同） */
  _setupPointAttribs() {
    const gl = this.gl;
    if (!gl) return;
    const stride = PTS_STRIDE * 4;
    const view = this.view;
    const posOffset = view === 'skyline' ? 0 : 5 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, posOffset);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 2 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 1 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 4 * 4);
  }

  _createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!ok) {
      this.lastError = '链接着色器失败: ' + gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      this.lastError = '编译着色器失败: ' + gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  /* ───────────────────────── 尺寸 ───────────────────────── */

  resize() {
    const cv = this.canvas;
    const ov = this.overlay;
    const cssW = Math.max(120, cv.clientWidth || cv.parentElement?.clientWidth || 800);
    const cssH = Math.max(120, cv.clientHeight || cv.parentElement?.clientHeight || 600);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.cssW === cssW && this.cssH === cssH && this.dpr === dpr && cv.width === Math.round(cssW * dpr)) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.pxW = Math.round(cssW * dpr);
    this.pxH = Math.round(cssH * dpr);
    cv.width = this.pxW;
    cv.height = this.pxH;
    if (ov) {
      ov.width = this.pxW;
      ov.height = this.pxH;
    }
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.pxW, this.pxH);
    }
  }

  /* ───────────────────────── 数据上传 ───────────────────────── */

  /**
   * 上传一帧数据（在 rAF 中调用；只做 GPU 上传，不重建 program/buffer）。
   * @param {object} frame protocol.parseFrame 的结果
   * @param {object} [mapping] 财富映射器（叠加层轴标签用）
   */
  setFrame(frame, mapping) {
    this.frame = frame;
    this.pts = (frame.sections && frame.sections.pts) || null;
    this.ids = (frame.sections && frame.sections.ids) || null;
    this.hist = (frame.sections && frame.sections.hist) || null;
    this.sampleCount = frame.meta ? frame.meta.sampleCount : 0;
    if (mapping) this.mapping = mapping;
    if (!this.gl || !this.pts || this.sampleCount <= 0) {
      this._prepareFallback();
      this._locateMarkers();
      return;
    }
    const gl = this.gl;
    const need = this.pts.byteLength;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    const t0 = performance.now();
    if (need > this._pointBufBytes) {
      // 容量增长：整块重分配（不是每帧行为，仅初始化/扩容）
      this._pointBufBytes = Math.max(need, this._pointBufBytes * 2 || need);
      gl.bufferData(gl.ARRAY_BUFFER, this._pointBufBytes, gl.DYNAMIC_DRAW);
      this.stats.bufferDataCalls++;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pts);
    this.stats.bufferSubDataCalls++;
    this.stats.uploadMs = performance.now() - t0;
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this._uploadGrid(frame);
    this._locateMarkers();
  }

  /** 策略密度网格 → R8 纹理（对数色阶，texSubImage2D 复用） */
  _uploadGrid(frame) {
    const gl = this.gl;
    const grid = frame.sections && frame.sections.strategyGrid;
    if (!gl || !grid) return;
    const w = frame.meta.gridW | 0;
    const h = frame.meta.gridH | 0;
    if (w <= 0 || h <= 0 || grid.length < w * h) return;
    const n = w * h;
    if (!this._r8 || this._r8.length !== n) this._r8 = new Uint8Array(n);
    const r8 = this._r8;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = grid[i];
      if (v > max) max = v;
    }
    const inv = max > 0 ? 255 / Math.log1p(max) : 0;
    for (let i = 0; i < n; i++) {
      const v = grid[i];
      r8[i] = v > 0 ? Math.min(255, Math.round(Math.log1p(v) * inv)) : 0;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    if (w !== this._gridW || h !== this._gridH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, r8);
      this._gridW = w;
      this._gridH = h;
      this.stats.texImageCalls++;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, r8);
      this.stats.texSubImageCalls++;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** 预计算追踪/选中个体在本帧的 uv 坐标（每帧一次 O(N)，不在 render 里做） */
  _locateMarkers() {
    this.trackedPoints = [];
    this.selectedPoint = null;
    const pts = this.pts;
    const ids = this.ids;
    const count = this.sampleCount;
    if (!pts || !ids || count <= 0) return;
    const tracked = this.trackedIds;
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      const isTracked = tracked.size > 0 && tracked.has(id);
      const isSelected = id === this.selectedId;
      if (!isTracked && !isSelected) continue;
      const o = i * PTS_STRIDE;
      const u = this.view === 'skyline' ? pts[o] : pts[o + 5];
      const v = this.view === 'skyline' ? pts[o + 1] : pts[o + 6] / 0.8660254;
      const cls = pts[o + 2] | 0;
      if (isSelected) this.selectedPoint = { id, u, v, cls };
      if (isTracked) this.trackedPoints.push({ id, u, v, cls });
    }
  }

  _prepareFallback() {
    if (this.gl) return;
    const pts = this.pts;
    const count = this.sampleCount;
    if (!pts || count <= 0) {
      this._fallbackPoints = null;
      return;
    }
    // 回退渲染：抽样最多 9000 个点（每个 [x, y, class]）
    const budget = Math.min(count, 9000);
    const step = Math.max(1, Math.floor(count / budget));
    const out = [];
    for (let i = 0; i < count; i += step) {
      const o = i * PTS_STRIDE;
      out.push(
        this.view === 'skyline' ? pts[o] : pts[o + 5],
        this.view === 'skyline' ? pts[o + 1] : pts[o + 6] / 0.8660254,
        pts[o + 2] | 0,
      );
    }
    this._fallbackPoints = out;
  }

  /* ───────────────────────── 视图 / 追踪 ───────────────────────── */

  setView(view) {
    this.view = view === 'skyline' ? 'skyline' : 'galaxy';
    if (this.gl) {
      const gl = this.gl;
      gl.bindVertexArray(this.pointVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
      this._setupPointAttribs();
      gl.bindVertexArray(null);
    }
    this._locateMarkers();
    this._prepareFallback();
  }

  setTracked(ids) {
    this.trackedIds = new Set(Array.isArray(ids) ? ids : []);
    this._locateMarkers();
  }

  setSelected(id) {
    this.selectedId = Number.isFinite(id) ? id : -1;
    this._locateMarkers();
  }

  resetTransform() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  /* ───────────────────────── 坐标变换 ───────────────────────── */

  _clampPan() {
    const lim = this.zoom + 0.6;
    if (this.panX < -lim) this.panX = -lim;
    else if (this.panX > lim) this.panX = lim;
    if (this.panY < -lim) this.panY = -lim;
    else if (this.panY > lim) this.panY = lim;
  }

  /** uv(0..1) → 屏幕 CSS 像素 */
  projectUV(u, v) {
    const clipX = (u * 2 - 1) * this.zoom + this.panX;
    const clipY = (v * 2 - 1) * this.zoom + this.panY;
    return [(clipX + 1) * 0.5 * this.cssW, (1 - (clipY + 1) * 0.5) * this.cssH];
  }

  /** 屏幕 CSS 像素 → clip 坐标 */
  _screenToClip(sx, sy) {
    return [(sx / this.cssW) * 2 - 1, 1 - (sy / this.cssH) * 2];
  }

  /* ───────────────────────── 渲染 ───────────────────────── */

  render(now) {
    const t0 = performance.now();
    this.resize();
    if (this.gl && this.glOk) this._renderGL();
    else this._renderFallback2D();
    this._renderOverlay();
    // FPS 统计
    this._frames++;
    if (now - this._fpsT0 >= 500) {
      this.stats.fps = Math.round((this._frames * 1000) / (now - this._fpsT0));
      this._frames = 0;
      this._fpsT0 = now;
    }
    this.stats.frameMs = performance.now() - t0;
    this.stats.points = this.sampleCount;
  }

  _renderGL() {
    const gl = this.gl;
    const uq = this._uniforms.quad;
    gl.viewport(0, 0, this.pxW, this.pxH);
    gl.clearColor(0.018, 0.028, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let drawCalls = 0;

    // ① 单 quad：策略星系密度热图 / 财富视图背景
    gl.useProgram(this.quadProg);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    gl.uniform1i(uq.grid, 0);
    gl.uniform1f(uq.mode, this.view === 'skyline' ? 1 : 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    drawCalls++;
    this.stats.drawArraysTotal++;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    // ② 单次 drawArrays：点云（坐标变换在 VS 内）
    if (this.pts && this.sampleCount > 0) {
      const up = this._uniforms.point;
      gl.useProgram(this.pointProg);
      gl.bindVertexArray(this.pointVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
      gl.uniform2f(up.scale, this.zoom, this.zoom);
      gl.uniform2f(up.pan, this.panX, this.panY);
      const ps = Math.max(1, 1.55 * this.dpr * Math.pow(this.zoom, 0.35));
      gl.uniform1f(up.pointSize, ps);
      gl.uniform3fv(up.classColor, CLASS_COLOR_FLAT);
      gl.drawArrays(gl.POINTS, 0, this.sampleCount);
      drawCalls++;
      this.stats.drawArraysTotal++;
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    gl.bindVertexArray(null);
    this.stats.drawCalls = drawCalls;
    this.stats.renders++;
  }

  /** WebGL2 不可用时的兜底：在 2D 叠加层画散点（保证舞台不空白） */
  _renderFallback2D() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a1018';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const pts = this._fallbackPoints;
    if (pts) {
      const n = pts.length / 3;
      for (let i = 0; i < n; i++) {
        const [sx, sy] = this.projectUV(pts[i * 3], pts[i * 3 + 1]);
        if (sx < -2 || sx > this.cssW + 2 || sy < -2 || sy > this.cssH + 2) continue;
        const c = CLASS_RGB[pts[i * 3 + 2] & 3];
        ctx.fillStyle = `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},0.55)`;
        ctx.fillRect(sx, sy, 1.6, 1.6);
      }
    }
    ctx.restore();
    this.stats.drawCalls = 0;
  }

  /* ───────────────────────── 叠加层（2D） ───────────────────────── */

  _renderOverlay() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    const W = this.cssW;
    const H = this.cssH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    if (this.view === 'galaxy') this._overlayGalaxy(ctx, W, H);
    else this._overlaySkyline(ctx, W, H);
    this._overlayMarkers(ctx);
  }

  _overlayGalaxy(ctx, W, H) {
    // 三角边框
    const p0 = this.projectUV(0, 0); // 石
    const p1 = this.projectUV(1, 0); // 布
    const p2 = this.projectUV(0.5, 1); // 剪
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(84,211,255,0.30)';
    ctx.stroke();
    // 顶点标签
    ctx.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(91,140,255,0.95)'; // 石头
    ctx.fillText('石 ROCK', p0[0], p0[1] - 12);
    ctx.fillStyle = 'rgba(245,185,66,0.95)'; // 布
    ctx.fillText('布 PAPER', p1[0], p1[1] - 12);
    ctx.fillStyle = 'rgba(66,211,146,0.95)'; // 剪刀
    const labelY = p2[1] + 14 > H - 8 ? p2[1] - 14 : p2[1] + 14;
    ctx.fillText('剪 SCISSORS', p2[0], labelY);
  }

  _overlaySkyline(ctx, W, H) {
    const mapping = this.mapping;
    // 水平网格线 + 资产轴标签
    ctx.font = '10px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < GRID_Y_LEVELS.length; i++) {
      const y = GRID_Y_LEVELS[i];
      const p = this.projectUV(0, y);
      if (p[1] < -20 || p[1] > H + 20) continue;
      ctx.beginPath();
      ctx.moveTo(0, p[1]);
      ctx.lineTo(W, p[1]);
      ctx.strokeStyle = i === 0 ? 'rgba(34,48,74,0.95)' : 'rgba(34,48,74,0.55)';
      ctx.stroke();
      if (mapping) {
        const asset = mapping.fromY(y);
        const label = formatAxisAsset(asset);
        ctx.fillStyle = 'rgba(95,115,145,0.9)';
        ctx.fillText(label, 8, p[1] - 8);
      }
    }
    // 直方图轮廓（右侧竖排条：财富分布"天际线"）
    const hist = this.hist;
    if (hist && hist.length > 0) {
      const bins = hist.length;
      let max = 0;
      for (let i = 0; i < bins; i++) if (hist[i] > max) max = hist[i];
      if (max > 0) {
        const maxW = Math.min(W * 0.16, 140);
        ctx.beginPath();
        ctx.moveTo(W, H);
        for (let i = 0; i < bins; i++) {
          const y = (i + 0.5) / bins; // bin 0 在底部（最穷）
          const p = this.projectUV(0, y);
          const wgt = Math.log1p(hist[i]) / Math.log1p(max);
          const x = W - 4 - wgt * maxW;
          ctx.lineTo(x, p[1]);
        }
        ctx.lineTo(W, 0);
        ctx.closePath();
        const grad = ctx.createLinearGradient(W - maxW, 0, W, 0);
        grad.addColorStop(0, 'rgba(84,211,255,0.02)');
        grad.addColorStop(1, 'rgba(84,211,255,0.20)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(84,211,255,0.45)';
        ctx.stroke();
      }
    }
    // 左侧竖线（泳道原点）
    ctx.beginPath();
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, H);
    ctx.strokeStyle = 'rgba(34,48,74,0.9)';
    ctx.stroke();
  }

  _overlayMarkers(ctx) {
    // 选中个体：双层圆环
    if (this.selectedPoint) {
      const [sx, sy] = this.projectUV(this.selectedPoint.u, this.selectedPoint.v);
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 12, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(84,211,255,0.55)';
      ctx.stroke();
    }
    // 追踪个体：小菱形
    for (let i = 0; i < this.trackedPoints.length; i++) {
      const tp = this.trackedPoints[i];
      const [sx, sy] = this.projectUV(tp.u, tp.v);
      ctx.beginPath();
      ctx.moveTo(sx, sy - 4);
      ctx.lineTo(sx + 4, sy);
      ctx.lineTo(sx, sy + 4);
      ctx.lineTo(sx - 4, sy);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(247,211,67,0.95)';
      ctx.stroke();
    }
  }

  /* ───────────────────────── 交互 ───────────────────────── */

  _bindEvents() {
    const ov = this.overlay;
    if (!ov) return;
    ov.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = ov.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const [cx, cy] = this._screenToClip(sx, sy);
        const wx = ((cx - this.panX) / this.zoom + 1) * 0.5;
        const wy = ((cy - this.panY) / this.zoom + 1) * 0.5;
        const factor = Math.exp(-e.deltaY * 0.0016);
        let nz = this.zoom * factor;
        if (nz < 0.5) nz = 0.5;
        else if (nz > 8) nz = 8;
        this.zoom = nz;
        this.panX = cx - (wx * 2 - 1) * nz;
        this.panY = cy - (wy * 2 - 1) * nz;
        this._clampPan();
      },
      { passive: false },
    );

    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = ov.getBoundingClientRect();
      this._drag = { x: e.clientX - rect.left, y: e.clientY - rect.top, panX: this.panX, panY: this.panY };
      this._moved = false;
      try {
        ov.setPointerCapture?.(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    });

    ov.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const rect = ov.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dx = sx - this._drag.x;
      const dy = sy - this._drag.y;
      if (!this._moved && dx * dx + dy * dy > 9) this._moved = true;
      if (!this._moved) return;
      this.panX = this._drag.panX + (dx / this.cssW) * 2;
      this.panY = this._drag.panY - (dy / this.cssH) * 2;
      this._clampPan();
    });

    const endDrag = (e) => {
      if (!this._drag) return;
      const wasMoved = this._moved;
      this._drag = null;
      this._moved = false;
      try {
        ov.releasePointerCapture?.(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
      if (wasMoved) return;
      const rect = ov.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = this.pick(sx, sy);
      if (hit && this.onPick) this.onPick(hit);
    };
    ov.addEventListener('pointerup', endDrag);
    ov.addEventListener('pointercancel', () => {
      this._drag = null;
      this._moved = false;
    });

    ov.addEventListener('dblclick', () => this.resetTransform());
  }

  /**
   * 屏幕空间最近采样点（点击追踪）。
   * @param {number} sx 相对画布的 CSS 像素 x
   * @param {number} sy 相对画布的 CSS 像素 y
   * @returns {{id:number,index:number,sx:number,sy:number,dist:number}|null}
   */
  pick(sx, sy) {
    const pts = this.pts;
    const ids = this.ids;
    if (!pts || !ids) return null;
    const count = this.sampleCount;
    const W = this.cssW;
    const H = this.cssH;
    const zoom = this.zoom;
    const panX = this.panX;
    const panY = this.panY;
    const radius = 22;
    let best = -1;
    let bestDist = radius * radius;
    let bestSx = 0;
    let bestSy = 0;
    const skyline = this.view === 'skyline';
    for (let i = 0; i < count; i++) {
      const o = i * PTS_STRIDE;
      const u = skyline ? pts[o] : pts[o + 5];
      const v = skyline ? pts[o + 1] : pts[o + 6] / 0.8660254;
      const clipX = (u * 2 - 1) * zoom + panX;
      const clipY = (v * 2 - 1) * zoom + panY;
      const px = (clipX + 1) * 0.5 * W;
      const py = (1 - (clipY + 1) * 0.5) * H;
      const dx = px - sx;
      const dy = py - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        best = i;
        bestSx = px;
        bestSy = py;
      }
    }
    if (best < 0) return null;
    return { id: ids[best], index: best, sx: bestSx, sy: bestSy, dist: Math.sqrt(bestDist) };
  }

  getStats() {
    return {
      glOk: this.glOk,
      fps: this.stats.fps,
      drawCalls: this.stats.drawCalls,
      points: this.stats.points,
      uploadMs: this.stats.uploadMs,
      frameMs: this.stats.frameMs,
      view: this.view,
      zoom: this.zoom,
      gridW: this._gridW,
      gridH: this._gridH,
      bufferDataCalls: this.stats.bufferDataCalls,
      bufferSubDataCalls: this.stats.bufferSubDataCalls,
      texImageCalls: this.stats.texImageCalls,
      texSubImageCalls: this.stats.texSubImageCalls,
      drawArraysTotal: this.stats.drawArraysTotal,
      renders: this.stats.renders,
    };
  }
}

/** 类颜色扁平数组（uniform3fv 用） */
const CLASS_COLOR_FLAT = new Float32Array(12);
for (let i = 0; i < 4; i++) {
  CLASS_COLOR_FLAT[i * 3] = CLASS_RGB[i][0];
  CLASS_COLOR_FLAT[i * 3 + 1] = CLASS_RGB[i][1];
  CLASS_COLOR_FLAT[i * 3 + 2] = CLASS_RGB[i][2];
}

/** 资产轴标签（与 format.fmtCompact 类似，但避免循环依赖） */
function formatAxisAsset(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(0) + '万';
  if (a >= 1000) return String(Math.round(v));
  if (a >= 10) return String(Math.round(v));
  return v.toFixed(1);
}

export { formatAxisAsset };
