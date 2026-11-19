/**
 * Geometry and lifecycle for the glass node field — no DOM, no canvas, so it is unit-testable.
 *
 * The field is SAM's square node/workspace network: brick-offset square nodes, each with up
 * to four workspace slots, waking up, running agents for a while, then winding down, with
 * light pulses travelling along the channels between nodes. `node-field.ts` draws it.
 */

export type GlassNodeFieldMode = 'floor' | 'flat';
export type GlassLight = 'green' | 'amber';

/** A screen-space point: [x, y, scale]. `scale` is pixels per world unit (1 in flat mode). */
export type ScreenPoint = readonly [number, number, number];
export type Quad = readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];

/** Workspace slots per node, cycled across the field (the pattern the old NodeGrid used). */
export const AGENT_COUNTS = [4, 3, 2, 3, 4, 2, 3, 4, 3, 2, 4, 3] as const;

export interface FieldGeometryOptions {
  mode: GlassNodeFieldMode;
  width: number;
  height: number;
  /** Distance between node centres: world units (floor) or CSS px (flat). */
  pitch: number;
  /** Node tile size as a fraction of `pitch`. */
  cell: number;
  /** Floor only: vanishing point x as a fraction of the width. */
  vanishX: number;
  /** Floor only: horizon y as a fraction of the height. */
  horizonY: number;
  /** Floor only: farthest row distance in world units. */
  zmax: number;
  /** Floor only: focal length, scaled with the height relative to a 900px viewport. */
  focal: number;
  seed: number;
}

export interface Projection {
  (u: number, v: number): ScreenPoint;
  /** Floor only: lateral world range visible at depth `z`. */
  uRange?: (z: number) => readonly [number, number];
  /** Floor only: horizon y in CSS px. */
  horizon: number | null;
}

export interface FieldSlot {
  readonly quad: Quad;
  readonly centre: ScreenPoint;
}

export interface FieldNode {
  readonly id: number;
  readonly u: number;
  readonly v: number;
  /** Screen centre in CSS px. */
  readonly x: number;
  readonly y: number;
  readonly quad: Quad;
  readonly slots: readonly [FieldSlot, FieldSlot, FieldSlot, FieldSlot];
  /** Projected tile width in CSS px. */
  readonly size: number;
  /** 1 near, 0 at the horizon (always 1 in flat mode). */
  readonly depth: number;
  agents: number;
  state: 'dormant' | 'waking' | 'active' | 'winding';
  until: number;
  wake: number;
  wakeTarget: number;
  slotAlpha: [number, number, number, number];
  slotTarget: [number, number, number, number];
  slotAt: [number, number, number, number];
  phase: number;
  light: GlassLight;
  pinned: boolean;
  flashAt: number;
  frosted: boolean;
}

export interface Pulse {
  readonly points: readonly (readonly [number, number])[];
  readonly length: number;
  readonly start: number;
  readonly duration: number;
  readonly light: GlassLight;
}

/** Deterministic PRNG so a given seed always lights the same pattern (stable screenshots). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Pinhole projection of a floor plane; the nearest row lands just below the bottom edge. */
export function createProjection(o: FieldGeometryOptions): Projection {
  if (o.mode === 'flat') {
    const flat = ((u: number, v: number) => [u, v, 1] as const) as Projection;
    flat.horizon = null;
    return flat;
  }
  const cx = o.width * o.vanishX;
  const horizon = o.height * o.horizonY;
  const f = o.focal * (o.height / 900);
  const z0 = 600;
  const cameraHeight = ((o.height * 1.06 - horizon) * z0) / f;
  const project = ((u: number, z: number) => {
    const d = z + z0;
    return [cx + (f * u) / d, horizon + (f * cameraHeight) / d, f / d] as const;
  }) as Projection;
  project.uRange = (z: number) => {
    const d = z + z0;
    return [(-cx * d) / f - o.pitch, ((o.width - cx) * d) / f + o.pitch] as const;
  };
  project.horizon = horizon;
  return project;
}

function quadAt(project: Projection, u: number, v: number, half: number): Quad {
  return [project(u - half, v - half), project(u + half, v - half), project(u + half, v + half), project(u - half, v + half)];
}

/** Builds every node tile and its four workspace slots, far rows first (painter's order). */
export function buildNodes(o: FieldGeometryOptions, project: Projection): FieldNode[] {
  const rand = mulberry32(o.seed);
  const nodes: FieldNode[] = [];
  const half = (o.pitch * o.cell) / 2;
  const slotOffset = half * 0.44;
  const slotHalf = half * 0.34;
  const add = (u: number, v: number, depth: number) => {
    const id = nodes.length;
    const quad = quadAt(project, u, v, half);
    const [x, y] = project(u, v);
    const slot = (du: number, dv: number): FieldSlot => ({
      quad: quadAt(project, u + du, v + dv, slotHalf),
      centre: project(u + du, v + dv),
    });
    nodes.push({
      id, u, v, x, y, quad, depth,
      slots: [slot(-slotOffset, -slotOffset), slot(slotOffset, -slotOffset), slot(-slotOffset, slotOffset), slot(slotOffset, slotOffset)],
      size: Math.abs(quad[1][0] - quad[0][0]),
      agents: AGENT_COUNTS[id % AGENT_COUNTS.length] ?? 4,
      state: 'dormant', until: 0, wake: 0, wakeTarget: 0,
      slotAlpha: [0, 0, 0, 0], slotTarget: [0, 0, 0, 0], slotAt: [0, 0, 0, 0],
      phase: rand() * Math.PI * 2, light: 'green', pinned: false, flashAt: -1e9, frosted: false,
    });
  };
  const P = o.pitch;
  if (o.mode === 'flat') {
    const cols = Math.ceil(o.width / P) + 2;
    const rows = Math.ceil(o.height / P) + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = -1; c < cols; c++) add(c * P + (r % 2 ? P / 2 : 0), r * P + P / 2, 1);
    }
    return nodes;
  }
  const rows = Math.ceil(o.zmax / P);
  for (let r = rows; r >= 0; r--) {
    const z = r * P + P / 2;
    const [u0, u1] = project.uRange?.(z) ?? [0, 0];
    const offset = r % 2 ? P / 2 : 0;
    for (let c = Math.floor(u0 / P) - 1; c <= Math.ceil(u1 / P) + 1; c++) {
      add(c * P + offset, z, 1 - smoothstep(clamp(z / o.zmax, 0, 1)));
    }
  }
  return nodes;
}

export interface LifecycleOptions {
  width: number;
  height: number;
  pitch: number;
  /** Fraction of eligible nodes kept active. */
  density: number;
  seed: number;
}

/** Node lifecycle (dormant → waking → active → winding down) and light pulses. */
export class FieldModel {
  pulses: Pulse[] = [];
  private wakeClock = 0;
  private pulseClock = 1500;
  private readonly rand: () => number;

  constructor(readonly nodes: FieldNode[], private readonly o: LifecycleOptions) {
    this.rand = mulberry32(o.seed + 1);
  }

  /** Visible enough to light: on screen and not too far away. */
  eligible(n: FieldNode): boolean {
    return n.depth > 0.35 && n.x > 0 && n.x < this.o.width && n.y > 0 && n.y < this.o.height;
  }

  wake(n: FieldNode, now: number): void {
    if (n.state !== 'dormant') return;
    n.state = 'waking';
    n.wakeTarget = 1;
    n.until = now + 600;
  }

  wakeNear(x: number, y: number, radius: number, count: number, now: number): void {
    this.nodes
      .filter((n) => n.state === 'dormant' && this.eligible(n) && Math.hypot(n.x - x, n.y - y) < radius)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
      .slice(0, count)
      .forEach((n, i) => this.wake(n, now + i * 120));
  }

  nodeNear(x: number, y: number): FieldNode | null {
    let best: FieldNode | null = null;
    let bestDistance = Infinity;
    for (const n of this.nodes) {
      if (n.depth < 0.5 || n.frosted) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = n;
      }
    }
    return best;
  }

  /** Holds a node fully lit in one colour (green = working, amber = needs input). */
  pin(n: FieldNode, light: GlassLight, now: number): void {
    n.pinned = true;
    n.light = light;
    n.state = 'active';
    n.wakeTarget = 1;
    n.agents = 4;
    n.slotTarget = [1, 1, 1, 1];
    n.slotAt = [now, now, now, now];
    n.flashAt = now;
  }

  burst(from: FieldNode, count: number, light: GlassLight, now: number): void {
    this.nodes
      .filter((n) => n !== from && n.state === 'active' && this.eligible(n))
      .sort((a, b) => Math.hypot(a.u - from.u, a.v - from.v) - Math.hypot(b.u - from.u, b.v - from.v))
      .slice(0, count)
      .forEach((target, i) => this.spawnPulse(from, target, light, now + i * 220));
    from.flashAt = now;
  }

  /** A still, deterministic lit pattern (reduced motion). */
  settle(): void {
    const rand = mulberry32(this.o.seed + 99);
    for (const n of this.nodes) {
      if (!this.eligible(n) || rand() >= this.o.density) continue;
      n.state = 'active';
      n.wake = n.wakeTarget = 1;
      n.slotAlpha = [1, 1, 1, 1];
      n.slotTarget = [1, 1, 1, 1];
    }
  }

  update(dt: number, now: number): void {
    this.wakeClock += dt;
    this.pulseClock -= dt;
    const pool = this.nodes.filter((n) => this.eligible(n));
    const target = Math.max(3, Math.round(pool.length * this.o.density));
    const active = pool.filter((n) => n.state !== 'dormant').length;
    if (this.wakeClock > 700 && active < target) {
      this.wakeClock = 0;
      const dormant = pool.filter((n) => n.state === 'dormant');
      const howMany = active < target * 0.5 ? 3 : 1; // ramp up quickly, then trickle
      for (let i = 0; i < howMany && dormant.length > 0; i++) {
        const [picked] = dormant.splice(Math.floor(this.rand() * dormant.length), 1);
        if (picked) this.wake(picked, now);
      }
    }
    for (const n of this.nodes) this.step(n, dt, now);
    if (this.pulseClock <= 0) {
      this.pulseClock = 1800 + this.rand() * 1800;
      this.spawnAmbientPulse(now);
    }
    this.pulses = this.pulses.filter((p) => now - p.start < p.duration + 50);
  }

  private step(n: FieldNode, dt: number, now: number): void {
    if (n.state === 'waking' && now > n.until) {
      n.state = 'active';
      for (let k = 0; k < 4; k++) n.slotAt[k] = now + 250 + k * (350 + this.rand() * 700);
      n.until = now + 9000 + this.rand() * 12000;
    } else if (n.state === 'active') {
      for (let k = 0; k < n.agents; k++) if (now > (n.slotAt[k] ?? 0)) n.slotTarget[k] = 1;
      if (!n.pinned && now > n.until) {
        n.state = 'winding';
        for (let k = 0; k < 4; k++) n.slotAt[k] = now + k * (300 + this.rand() * 500);
        n.until = now + 2600;
      }
    } else if (n.state === 'winding') {
      for (let k = 0; k < 4; k++) if (now > (n.slotAt[k] ?? 0)) n.slotTarget[k] = 0;
      if (now > n.until) {
        n.state = 'dormant';
        n.wakeTarget = 0;
      }
    }
    n.wake += (n.wakeTarget - n.wake) * Math.min(1, dt / 450);
    const ease = Math.min(1, dt / 320);
    for (let k = 0; k < 4; k++) {
      const alpha = n.slotAlpha[k] ?? 0;
      n.slotAlpha[k] = alpha + ((n.slotTarget[k] ?? 0) - alpha) * ease;
    }
  }

  private spawnAmbientPulse(now: number): void {
    const live = this.nodes.filter((n) => n.state === 'active' && this.eligible(n));
    const from = live[Math.floor(this.rand() * live.length)];
    if (!from) return;
    const near = live.filter((n) => n !== from && Math.abs(n.u - from.u) < this.o.pitch * 6 && Math.abs(n.v - from.v) < this.o.pitch * 5);
    const to = near[Math.floor(this.rand() * near.length)];
    if (to) this.spawnPulse(from, to, 'green', now);
  }

  /** Light runs along the channels between rows, never through a tile. */
  private spawnPulse(a: FieldNode, b: FieldNode, light: GlassLight, start: number): void {
    const channel = this.o.pitch * 0.5;
    const mid = a.u + (b.u - a.u) / 2;
    const points = [
      [a.u, a.v], [a.u, a.v + channel], [mid, a.v + channel], [mid, b.v + channel], [b.u, b.v + channel], [b.u, b.v],
    ] as const;
    let length = 0;
    for (let k = 1; k < points.length; k++) {
      const p0 = points[k - 1];
      const p1 = points[k];
      if (p0 && p1) length += Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    }
    const duration = 1500 + length * 0.6;
    this.pulses.push({ points, length, start, duration, light });
    a.flashAt = Math.max(a.flashAt, start);
    b.flashAt = Math.max(b.flashAt, start + duration - 200);
  }
}

/** Position along a pulse path (plane coordinates) for progress 0..1. */
export function pointAlong(pulse: Pulse, progress: number): readonly [number, number] {
  let remaining = clamp(progress, 0, 1) * pulse.length;
  for (let k = 1; k < pulse.points.length; k++) {
    const a = pulse.points[k - 1];
    const b = pulse.points[k];
    if (!a || !b) continue;
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= segment) {
      const f = segment ? remaining / segment : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    remaining -= segment;
  }
  return pulse.points[pulse.points.length - 1] ?? [0, 0];
}
