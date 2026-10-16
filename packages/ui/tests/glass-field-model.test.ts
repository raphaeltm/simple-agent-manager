import { describe, expect, it } from 'vitest';

import {
  AGENT_COUNTS,
  buildNodes,
  createProjection,
  type FieldGeometryOptions,
  FieldModel,
  type FieldNode,
  mulberry32,
  pointAlong,
} from '../src/glass/field-model';

const FLOOR: FieldGeometryOptions = {
  mode: 'floor', width: 1440, height: 900, pitch: 58, cell: 0.86,
  vanishX: 0.6, horizonY: 0.44, zmax: 2600, focal: 820, seed: 11,
};
const FLAT: FieldGeometryOptions = { ...FLOOR, mode: 'flat', pitch: 88 };
/** Lifecycle tests simulate up to a minute; a smaller floor keeps them fast under coverage on CI. */
const SMALL: FieldGeometryOptions = { ...FLOOR, width: 640, height: 400 };

function floorModel(density = 0.2) {
  const project = createProjection(SMALL);
  const nodes = buildNodes(SMALL, project);
  return new FieldModel(nodes, { width: SMALL.width, height: SMALL.height, pitch: SMALL.pitch, density, seed: SMALL.seed });
}

/** Advances the lifecycle in 100 ms steps (the renderer clamps a frame's step to 120 ms). */
function run(model: FieldModel, fromMs: number, durationMs: number) {
  let now = fromMs;
  for (let t = 0; t < durationMs; t += 100) {
    now += 100;
    model.update(100, now);
  }
  return now;
}

const active = (model: FieldModel) => model.nodes.filter((n) => n.state !== 'dormant');

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    for (const value of seqA) expect(value).toBeGreaterThanOrEqual(0);
  });
});

describe('createProjection (floor)', () => {
  const project = createProjection(FLOOR);

  it('puts the nearest row below the bottom edge and recedes toward the horizon', () => {
    const horizon = FLOOR.height * FLOOR.horizonY;
    expect(project.horizon).toBeCloseTo(horizon);
    const near = project(0, 0);
    const far = project(0, FLOOR.zmax);
    expect(near[1]).toBeGreaterThan(FLOOR.height);
    expect(far[1]).toBeGreaterThan(horizon);
    expect(far[1]).toBeLessThan(near[1]);
  });

  it('converges on the vanishing point and shrinks with depth', () => {
    const vanish = FLOOR.width * FLOOR.vanishX;
    expect(project(0, 1000)[0]).toBeCloseTo(vanish);
    expect(Math.abs(project(500, 2000)[0] - vanish)).toBeLessThan(Math.abs(project(500, 100)[0] - vanish));
    expect(project(0, 2000)[2]).toBeLessThan(project(0, 100)[2]);
  });

  it('is the identity in flat mode', () => {
    const flat = createProjection(FLAT);
    expect(flat(120, 40)).toEqual([120, 40, 1]);
    expect(flat.horizon).toBeNull();
  });
});

describe('buildNodes', () => {
  it('lays out the floor far-to-near with bounded size and four slots per node', () => {
    const nodes = buildNodes(FLOOR, createProjection(FLOOR));
    expect(nodes.length).toBeGreaterThan(200);
    expect(nodes.length).toBeLessThan(5000);
    // One assertion per property (not per node) keeps this cheap under coverage.
    expect(nodes.every((n, i) => i === 0 || n.depth >= (nodes[i - 1]?.depth ?? 0))).toBe(true);
    expect(nodes.every((n) => n.depth >= 0 && n.depth <= 1)).toBe(true);
    expect(nodes.every((n) => n.slots.length === 4)).toBe(true);
    expect(nodes.every((n) => (AGENT_COUNTS as readonly number[]).includes(n.agents))).toBe(true);
  });

  it('covers the viewport in flat mode with brick-offset rows', () => {
    const nodes = buildNodes(FLAT, createProjection(FLAT));
    const firstRow = nodes.filter((n) => n.v === FLAT.pitch / 2);
    const secondRow = nodes.filter((n) => n.v === FLAT.pitch * 1.5);
    expect(Math.min(...firstRow.map((n) => n.x))).toBeLessThanOrEqual(0);
    expect(Math.max(...firstRow.map((n) => n.x))).toBeGreaterThanOrEqual(FLAT.width);
    expect(Math.max(...nodes.map((n) => n.y))).toBeGreaterThanOrEqual(FLAT.height);
    expect((secondRow[0]!.u - firstRow[0]!.u) % FLAT.pitch).toBeCloseTo(FLAT.pitch / 2);
    expect(firstRow[0]!.size).toBeCloseTo(FLAT.pitch * FLAT.cell);
  });
});

// Simulates tens of seconds of lifecycle; allow for coverage instrumentation on shared CI runners.
describe('FieldModel lifecycle', { timeout: 15_000 }, () => {
  it('starts dark and ramps up to roughly the target density', () => {
    const model = floorModel(0.2);
    expect(active(model)).toHaveLength(0);
    run(model, 0, 12_000);
    const eligible = model.nodes.filter((n) => model.eligible(n)).length;
    const lit = active(model).length;
    expect(lit).toBeGreaterThanOrEqual(3);
    expect(lit).toBeLessThanOrEqual(Math.ceil(eligible * 0.2) + 3);
  });

  it('winds nodes back down so the pattern keeps changing', () => {
    const model = floorModel(0.2);
    const now = run(model, 0, 8_000);
    const firstWave = new Set(active(model).map((n) => n.id));
    // Active nodes run 9-21 s, then wind down over 2.6 s.
    run(model, now, 24_000);
    const stillLit = active(model).filter((n) => firstWave.has(n.id));
    expect(stillLit.length).toBeLessThan(firstWave.size);
  });

  it('keeps a pinned node lit in its colour indefinitely', () => {
    const model = floorModel(0.2);
    const node = model.nodeNear(SMALL.width * 0.6, SMALL.height * 0.9)!;
    model.pin(node, 'amber', 0);
    // Sample every second for longer than any unpinned node stays lit (21 s active + 2.6 s
    // winding): a pinned node must never leave the active state, not merely end up active.
    const states: string[] = [];
    let now = 0;
    for (let second = 0; second < 30; second++) {
      now = run(model, now, 1000);
      states.push(node.state);
    }
    expect(states.every((state) => state === 'active')).toBe(true);
    expect(node.light).toBe('amber');
    expect(node.agents).toBe(4);
    expect(Math.min(...node.slotAlpha)).toBeGreaterThan(0.95);
  });

  it('sends pulses only to running neighbours, nearest first', () => {
    const model = floorModel(0.25);
    const now = run(model, 0, 10_000);
    const from = model.nodeNear(SMALL.width * 0.6, SMALL.height * 0.9)!;
    model.pulses = [];
    model.burst(from, 3, 'green', now);
    expect(model.pulses.length).toBeGreaterThan(0);
    expect(model.pulses.length).toBeLessThanOrEqual(3);
    for (const pulse of model.pulses) {
      const end = pulse.points[pulse.points.length - 1]!;
      const target = model.nodes.find((n: FieldNode) => n.u === end[0] && n.v === end[1]);
      expect(target?.state).toBe('active');
    }
  });

  it('settles into a deterministic still frame', () => {
    const a = floorModel(0.2);
    const b = floorModel(0.2);
    a.settle();
    b.settle();
    const lit = (m: FieldModel) => active(m).map((n) => n.id);
    expect(lit(a)).toEqual(lit(b));
    expect(lit(a).length).toBeGreaterThan(0);
    for (const n of active(a)) expect(n.slotAlpha).toEqual([1, 1, 1, 1]);
  });

  it('nodeNear ignores far, faint rows', () => {
    const model = floorModel();
    const horizon = SMALL.height * SMALL.horizonY;
    const node = model.nodeNear(SMALL.width * 0.6, horizon + 2);
    expect(node?.depth).toBeGreaterThanOrEqual(0.5);
  });
});

describe('pointAlong', () => {
  it('walks the polyline by length', () => {
    const pulse = { points: [[0, 0], [10, 0], [10, 10]] as const, length: 20, start: 0, duration: 1, light: 'green' as const };
    expect(pointAlong(pulse, 0)).toEqual([0, 0]);
    expect(pointAlong(pulse, 0.5)).toEqual([10, 0]);
    expect(pointAlong(pulse, 0.75)).toEqual([10, 5]);
    expect(pointAlong(pulse, 1)).toEqual([10, 10]);
    expect(pointAlong(pulse, 2)).toEqual([10, 10]);
  });
});
