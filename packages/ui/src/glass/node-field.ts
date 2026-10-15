/**
 * Glass node field — SAM's square node/workspace network drawn as lit glass on a canvas.
 *
 * Framework-agnostic so the Astro marketing site and the React app share one renderer
 * (`GlassNodeField` in `../components` wraps it for React). Two canvases instead of hundreds
 * of DOM nodes: a static layer (tiles, drawn once per resize/theme change) and a dynamic layer
 * (lit workspaces, light pulses). The loop is capped (30 fps by default), stops when the field
 * is offscreen, the tab is hidden or the user pauses, and draws one still frame under
 * `prefers-reduced-motion`. Without a 2D canvas context (e.g. jsdom) every method is a no-op.
 */
import {
  buildNodes,
  createProjection,
  FieldModel,
  type FieldNode,
  type GlassLight,
  type GlassNodeFieldMode,
  pointAlong,
  type Pulse,
  type Quad,
} from './field-model';

export type { GlassLight, GlassNodeFieldMode } from './field-model';
export type GlassNodeFieldTheme = 'dark' | 'light';

export interface FrostRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export interface GlassNodeFieldOptions {
  /** `floor` lays the network out in perspective; `flat` faces the viewer. Default `floor`. */
  mode?: GlassNodeFieldMode;
  /** `auto` follows `html[data-theme]` (site), `html[data-ui-theme]` (app) or the OS. */
  theme?: GlassNodeFieldTheme | 'auto';
  seed?: number;
  /** Node spacing: world units (floor) or CSS px (flat). Default 64. */
  pitch?: number;
  /** Tile size as a fraction of `pitch`. Default 0.86. */
  cell?: number;
  /** Fraction of visible nodes kept running. Default 0.18. */
  density?: number;
  /** Frame cap. Default 30. */
  fps?: number;
  /** Floor: vanishing point x (fraction of width). Default 0.6. */
  vanishX?: number;
  /** Floor: horizon y (fraction of height). Default 0.44. */
  horizonY?: number;
  /** Floor: farthest row distance. Default 2600. */
  zmax?: number;
  /** Floor: focal length at a 900px tall field. Default 820. */
  focal?: number;
  /** `auto` follows `prefers-reduced-motion`. */
  reducedMotion?: boolean | 'auto';
  /** Flat: a region (CSS px, relative to the root) whose tiles are pre-blurred, e.g. under a frosted pane. */
  frost?: () => FrostRect | null;
  /** Upper bound for canvas resolution. Default 1.5. */
  maxDevicePixelRatio?: number;
}

/** Opaque handle to one node, in CSS px relative to the root. */
export interface GlassNodeRef {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface GlassNodeFieldHandle {
  /** Begins the ambient lifecycle (or paints the still frame under reduced motion). */
  start(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  nodeNear(x: number, y: number): GlassNodeRef | null;
  wakeNear(x: number, y: number, radius: number, count: number): void;
  /** Holds a node fully lit: green = working, amber = needs input. */
  pin(node: GlassNodeRef | null, light: GlassLight): void;
  /** Sends light pulses from a node to its nearest running neighbours. */
  burst(node: GlassNodeRef | null, count?: number, light?: GlassLight): void;
  setTheme(theme: GlassNodeFieldTheme | 'auto'): void;
  /** Floor horizon in CSS px (null in flat mode). */
  readonly horizon: number | null;
  destroy(): void;
}

interface Palette {
  tile: string; tileAlpha: number; sheen: string; sheenAlpha: number;
  rim: string; rimAlpha: number; edge: string; edgeAlpha: number; bounceAlpha: number;
  slot: string; slotOn: number; slotOff: number;
  green: string; amber: string; core: string; spec: string;
  composite: GlobalCompositeOperation; glowGain: number;
}

const PALETTES: Record<GlassNodeFieldTheme, Palette> = {
  dark: {
    tile: '9,18,15', tileAlpha: 0.6, sheen: '255,255,255', sheenAlpha: 0.022,
    rim: '255,255,255', rimAlpha: 0.05, edge: '255,255,255', edgeAlpha: 0.17, bounceAlpha: 0.13,
    slot: '255,255,255', slotOn: 0.035, slotOff: 0.012,
    green: '34,197,94', amber: '245,158,11', core: '215,255,228', spec: '235,255,242',
    composite: 'lighter', glowGain: 1,
  },
  light: {
    tile: '255,255,255', tileAlpha: 0.55, sheen: '255,255,255', sheenAlpha: 0.35,
    rim: '17,39,29', rimAlpha: 0.08, edge: '255,255,255', edgeAlpha: 0.95, bounceAlpha: 0.2,
    slot: '17,39,29', slotOn: 0.06, slotOff: 0.025,
    green: '22,163,74', amber: '217,119,6', core: '240,255,245', spec: '255,255,255',
    composite: 'source-over', glowGain: 0.55,
  },
};

const DEFAULTS = {
  mode: 'floor' as GlassNodeFieldMode, seed: 7, pitch: 64, cell: 0.86, density: 0.18, fps: 30,
  vanishX: 0.6, horizonY: 0.44, zmax: 2600, focal: 820, maxDevicePixelRatio: 1.5,
};

const rgba = (rgb: string, alpha: number) => `rgba(${rgb},${Math.max(0, Math.min(1, alpha))})`;

function sprite(rgb: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, rgba(rgb, 0.95));
    g.addColorStop(0.18, rgba(rgb, 0.5));
    g.addColorStop(0.5, rgba(rgb, 0.13));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return canvas;
}

function detectTheme(): GlassNodeFieldTheme {
  const root = document.documentElement;
  const site = root.getAttribute('data-theme');
  if (site === 'light' || site === 'dark') return site;
  const app = root.getAttribute('data-ui-theme');
  if (app) return app.includes('light') ? 'light' : 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const NOOP_HANDLE: GlassNodeFieldHandle = {
  start() {}, pause() {}, resume() {}, paused: false,
  nodeNear: () => null, wakeNear() {}, pin() {}, burst() {}, setTheme() {},
  horizon: null, destroy() {},
};

export function createGlassNodeField(root: HTMLElement, options: GlassNodeFieldOptions = {}): GlassNodeFieldHandle {
  // Explicit `undefined` (e.g. an unset React prop) must not erase a default.
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const o: typeof DEFAULTS & GlassNodeFieldOptions = { ...DEFAULTS, ...defined };
  const staticCanvas = document.createElement('canvas');
  const dynamicCanvas = document.createElement('canvas');
  const staticContext = staticCanvas.getContext('2d');
  const dynamicContext = dynamicCanvas.getContext('2d');
  if (!staticContext || !dynamicContext) return NOOP_HANDLE;
  const sctx: CanvasRenderingContext2D = staticContext;
  const dctx: CanvasRenderingContext2D = dynamicContext;
  for (const canvas of [staticCanvas, dynamicCanvas]) {
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    root.appendChild(canvas);
  }

  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => (o.reducedMotion === 'auto' || o.reducedMotion === undefined ? Boolean(motionQuery?.matches) : o.reducedMotion);
  let themeSetting: GlassNodeFieldTheme | 'auto' = o.theme ?? 'auto';
  let palette = PALETTES[themeSetting === 'auto' ? detectTheme() : themeSetting];
  let sprites = { green: sprite(palette.green), amber: sprite(palette.amber) };
  // The frame loop draws with these opaque colours and puts each draw's alpha in globalAlpha,
  // so it allocates no colour strings or gradients per frame (gradients are cached per node).
  const solidColours = () => ({
    green: rgba(palette.green, 1),
    amber: rgba(palette.amber, 1),
    spec: rgba(palette.spec, 1),
    core: rgba(palette.core, 1),
  });
  let colours = solidColours();
  let tileFills = new WeakMap<FieldNode, Partial<Record<GlassLight, CanvasGradient>>>();
  let width = 0, height = 0, dpr = 1;
  let model = new FieldModel([], { width: 0, height: 0, pitch: o.pitch, density: o.density, seed: o.seed });
  let project = createProjection({ ...o, width: 1, height: 1 });
  let raf = 0, last = 0, started = false, userPaused = false, onScreen = true, destroyed = false;

  // ---------- drawing ----------
  const path = (ctx: CanvasRenderingContext2D, q: Quad) => {
    ctx.beginPath();
    ctx.moveTo(q[0][0] * dpr, q[0][1] * dpr);
    ctx.lineTo(q[1][0] * dpr, q[1][1] * dpr);
    ctx.lineTo(q[2][0] * dpr, q[2][1] * dpr);
    ctx.lineTo(q[3][0] * dpr, q[3][1] * dpr);
    ctx.closePath();
  };
  const line = (ctx: CanvasRenderingContext2D, a: readonly number[], b: readonly number[]) => {
    ctx.beginPath();
    ctx.moveTo((a[0] ?? 0) * dpr, (a[1] ?? 0) * dpr);
    ctx.lineTo((b[0] ?? 0) * dpr, (b[1] ?? 0) * dpr);
    ctx.stroke();
  };
  const glow = (light: GlassLight, x: number, y: number, size: number, alpha: number, squash: number) => {
    const a = alpha * palette.glowGain;
    if (a <= 0.003) return;
    dctx.globalAlpha = Math.min(1, a);
    const w = size * dpr, h = size * dpr * squash;
    dctx.drawImage(sprites[light], x * dpr - w / 2, y * dpr - h / 2, w, h);
  };
  const visible = (n: FieldNode) => n.x > -n.size && n.x < width + n.size && n.y > -n.size && n.y < height + n.size;
  // Edges catching the light: the far edge on the floor; the top edge when flat.
  const litEdge = (ctx: CanvasRenderingContext2D, q: Quad) => (o.mode === 'flat' ? line(ctx, q[0], q[1]) : line(ctx, q[3], q[2]));
  const lowerEdge = (ctx: CanvasRenderingContext2D, q: Quad) => (o.mode === 'flat' ? line(ctx, q[3], q[2]) : line(ctx, q[0], q[1]));
  /** A tile's vertical fill, cached until the field is rebuilt or the theme changes. */
  const tileFill = (n: FieldNode, light: GlassLight): CanvasGradient => {
    let byLight = tileFills.get(n);
    if (!byLight) {
      byLight = {};
      tileFills.set(n, byLight);
    }
    let fill = byLight[light];
    if (!fill) {
      let top = Infinity;
      let bottom = -Infinity;
      for (const p of n.quad) {
        top = Math.min(top, p[1]);
        bottom = Math.max(bottom, p[1]);
      }
      const rgb = light === 'amber' ? palette.amber : palette.green;
      fill = dctx.createLinearGradient(0, top * dpr, 0, bottom * dpr);
      // Drawn at globalAlpha 0.16·a, so these stops give 0.03·a at the top and 0.16·a at the bottom.
      fill.addColorStop(0, rgba(rgb, 0.03 / 0.16));
      fill.addColorStop(1, rgba(rgb, 1));
      byLight[light] = fill;
    }
    return fill;
  };
  const alpha = (value: number) => Math.min(1, Math.max(0, value));

  function drawStatic() {
    sctx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);
    sctx.lineJoin = 'round';
    sctx.lineWidth = dpr;
    for (const n of model.nodes) {
      if (!visible(n) || n.depth < 0.02) continue;
      const a = n.depth;
      path(sctx, n.quad);
      sctx.fillStyle = rgba(palette.tile, palette.tileAlpha * a);
      sctx.fill();
      sctx.fillStyle = rgba(palette.sheen, palette.sheenAlpha * a);
      sctx.fill();
      sctx.strokeStyle = rgba(palette.rim, palette.rimAlpha * a);
      sctx.stroke();
      sctx.strokeStyle = rgba(palette.edge, palette.edgeAlpha * a);
      litEdge(sctx, n.quad);
      if (o.mode === 'flat') line(sctx, n.quad[0], n.quad[3]);
      sctx.strokeStyle = rgba(palette.green, palette.bounceAlpha * a);
      lowerEdge(sctx, n.quad);
      if (n.size <= 18) continue;
      n.slots.forEach((slot, k) => {
        path(sctx, slot.quad);
        sctx.fillStyle = rgba(palette.slot, (k < n.agents ? palette.slotOn : palette.slotOff) * a);
        sctx.fill();
        sctx.strokeStyle = rgba(palette.slot, (k < n.agents ? palette.slotOn * 1.7 : palette.slotOff * 2) * a);
        sctx.stroke();
      });
    }
    frostStatic();
  }

  function frostStatic() {
    const rect = o.mode === 'flat' ? o.frost?.() : null;
    for (const n of model.nodes) n.frosted = false;
    if (!rect) return;
    for (const n of model.nodes) {
      n.frosted = n.x > rect.x && n.x < rect.x + rect.width && n.y > rect.y && n.y < rect.y + rect.height;
    }
    const blurred = document.createElement('canvas');
    blurred.width = staticCanvas.width;
    blurred.height = staticCanvas.height;
    const bctx = blurred.getContext('2d');
    const canBlur = bctx && typeof bctx.filter === 'string';
    if (bctx && canBlur) {
      bctx.filter = `blur(${11 * dpr}px)`;
      bctx.drawImage(staticCanvas, 0, 0);
    }
    sctx.save();
    sctx.beginPath();
    const r = (rect.radius ?? 28) * dpr;
    if (typeof sctx.roundRect === 'function') sctx.roundRect(rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr, r);
    else sctx.rect(rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr);
    sctx.clip();
    sctx.clearRect(rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr);
    if (canBlur) {
      sctx.globalAlpha = 0.9;
      sctx.drawImage(blurred, 0, 0);
    }
    sctx.restore();
  }

  function drawNode(n: FieldNode, now: number) {
    const colour = n.light === 'amber' ? colours.amber : colours.green;
    const flash = Math.max(0, 1 - (now - n.flashAt) / 700);
    const a = n.depth * n.wake * (1 + flash * 0.8);
    const squash = o.mode === 'floor' ? 0.42 : 1;
    dctx.globalCompositeOperation = palette.composite;
    glow(n.light, n.x, n.y, n.size * (n.frosted ? 3.4 : 2.8), (n.frosted ? 0.32 : 0.2) * a, squash);
    dctx.globalCompositeOperation = 'source-over';
    if (!n.frosted) {
      path(dctx, n.quad);
      dctx.fillStyle = tileFill(n, n.light);
      dctx.globalAlpha = alpha(0.16 * a);
      dctx.fill();
      dctx.lineWidth = 1.1 * dpr;
      dctx.strokeStyle = colour;
      dctx.globalAlpha = alpha(0.42 * a);
      dctx.stroke();
      dctx.strokeStyle = colours.spec;
      dctx.globalAlpha = alpha(0.28 * a);
      litEdge(dctx, n.quad);
    }
    for (let k = 0; k < n.agents; k++) {
      const slot = n.slots[k];
      if (!slot) continue;
      const breathe = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 520 + n.phase + k * 1.7));
      const s = (n.slotAlpha[k] ?? 0) * breathe * n.depth * (1 + flash);
      if (s < 0.01) continue;
      if (!n.frosted && n.size > 10) {
        path(dctx, slot.quad);
        dctx.fillStyle = colour;
        dctx.globalAlpha = alpha((o.mode === 'flat' ? 0.38 : 0.5) * s);
        dctx.fill();
        const cx = slot.centre[0];
        const cy = slot.centre[1];
        const hw = Math.abs(slot.quad[1][0] - slot.quad[0][0]) * 0.22;
        const hh = hw * squash;
        dctx.fillStyle = colours.core;
        dctx.globalAlpha = alpha((o.mode === 'flat' ? 0.4 : 0.55) * s);
        dctx.fillRect((cx - hw) * dpr, (cy - hh) * dpr, hw * 2 * dpr, hh * 2 * dpr);
        dctx.lineWidth = dpr;
        dctx.strokeStyle = colours.spec;
        dctx.globalAlpha = alpha(0.45 * s);
        litEdge(dctx, slot.quad);
      }
      dctx.globalCompositeOperation = palette.composite;
      glow(n.light, slot.centre[0], slot.centre[1], n.size * (n.frosted ? 0.9 : 0.75), (n.frosted ? 0.42 : 0.35) * s, squash);
      dctx.globalCompositeOperation = 'source-over';
    }
    dctx.globalAlpha = 1;
  }

  function drawPulse(p: Pulse, now: number) {
    const k = Math.max(0, Math.min(1, (now - p.start) / p.duration));
    if (now < p.start) return;
    const head = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const fade = k > 0.85 ? (1 - k) / 0.15 : 1;
    const rgb = p.light === 'amber' ? palette.amber : palette.green;
    dctx.globalCompositeOperation = palette.composite;
    dctx.lineCap = 'round';
    dctx.strokeStyle = rgba(rgb, 1);
    let prev = project(...pointAlong(p, head - 0.28));
    for (let j = 1; j <= 14; j++) {
      const cur = project(...pointAlong(p, head - 0.28 + (0.28 * j) / 14));
      dctx.globalAlpha = (j / 14) * 0.85 * fade * palette.glowGain;
      dctx.lineWidth = Math.max(1, 2.2 * cur[2] * (o.mode === 'floor' ? 0.9 : 1)) * dpr;
      line(dctx, prev, cur);
      prev = cur;
    }
    const h = project(...pointAlong(p, head));
    const size = 34 * (o.mode === 'floor' ? Math.max(0.35, h[2] * 1.1) : 1);
    glow(p.light, h[0], h[1], size, 0.9 * fade, o.mode === 'floor' ? 0.5 : 1);
    dctx.globalCompositeOperation = 'source-over';
    dctx.globalAlpha = 1;
  }

  function drawDynamic(now: number) {
    dctx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
    for (const n of model.nodes) if (n.wake >= 0.01 && visible(n)) drawNode(n, now);
    for (const p of model.pulses) drawPulse(p, now);
  }

  // ---------- layout & loop ----------
  function layout() {
    const box = root.getBoundingClientRect();
    width = Math.max(1, Math.round(box.width));
    height = Math.max(1, Math.round(box.height));
    dpr = Math.min(window.devicePixelRatio || 1, o.maxDevicePixelRatio);
    for (const canvas of [staticCanvas, dynamicCanvas]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const geometry = { ...o, width, height };
    project = createProjection(geometry);
    model = new FieldModel(buildNodes(geometry, project), { width, height, pitch: o.pitch, density: o.density, seed: o.seed });
    drawStatic();
    // A rebuilt model starts dark; when nothing will animate it in, show the settled frame.
    if (started && !running()) paintStill();
  }

  function paintStill() {
    model.settle();
    drawDynamic(performance.now());
  }

  const running = () => started && !userPaused && onScreen && !document.hidden && !reduced() && !destroyed;
  function frame(ts: number) {
    raf = 0;
    if (!running()) return;
    raf = requestAnimationFrame(frame);
    const dt = ts - last;
    if (dt < 1000 / o.fps - 2) return;
    last = ts;
    model.update(Math.min(dt, 120), ts);
    drawDynamic(ts);
  }
  function sync() {
    if (running() && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!running() && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function applyTheme() {
    palette = PALETTES[themeSetting === 'auto' ? detectTheme() : themeSetting];
    sprites = { green: sprite(palette.green), amber: sprite(palette.amber) };
    colours = solidColours();
    tileFills = new WeakMap();
    drawStatic();
    drawDynamic(performance.now());
  }

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => { onScreen = Boolean(entry?.isIntersecting); sync(); })
    : null;
  io?.observe(root);
  let resizeQueued = 0;
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = requestAnimationFrame(() => { resizeQueued = 0; layout(); });
      })
    : null;
  ro?.observe(root);
  const themeObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => { if (themeSetting === 'auto') applyTheme(); })
    : null;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ui-theme'] });
  const onVisibility = () => sync();
  const onMotion = () => { if (reduced() && started) paintStill(); sync(); };
  document.addEventListener('visibilitychange', onVisibility);
  motionQuery?.addEventListener?.('change', onMotion);

  layout();

  const ref = (n: FieldNode | null): GlassNodeRef | null => (n ? { id: n.id, x: n.x, y: n.y } : null);
  const nodeOf = (r: GlassNodeRef | null) => (r ? model.nodes[r.id] ?? null : null);
  const redrawIfStill = () => { if (started && !running()) drawDynamic(performance.now()); };

  return {
    start() {
      started = true;
      if (reduced()) paintStill();
      sync();
    },
    pause() { userPaused = true; sync(); },
    resume() { userPaused = false; sync(); },
    get paused() { return userPaused; },
    nodeNear: (x, y) => ref(model.nodeNear(x, y)),
    wakeNear(x, y, radius, count) { model.wakeNear(x, y, radius, count, performance.now()); },
    pin(r, light) {
      const n = nodeOf(r);
      if (!n) return;
      model.pin(n, light, performance.now());
      if (reduced()) {
        n.wake = 1;
        n.slotAlpha = [1, 1, 1, 1];
      }
      redrawIfStill();
    },
    burst(r, count = 3, light = 'green') {
      const n = nodeOf(r);
      if (n && !reduced()) model.burst(n, count, light, performance.now());
    },
    setTheme(theme) { themeSetting = theme; applyTheme(); },
    get horizon() { return project.horizon; },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (resizeQueued) cancelAnimationFrame(resizeQueued);
      io?.disconnect();
      ro?.disconnect();
      themeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotion);
      staticCanvas.remove();
      dynamicCanvas.remove();
    },
  };
}
