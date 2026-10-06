import { describe, expect, it } from 'vitest';
import { createLab, LAB, sleepIdle, step, submit } from '../src/components/scheduler/model';
import type { Kind } from '../src/components/scheduler/model';

const burst = (lab: ReturnType<typeof createLab>) => {
  for (const kind of ['chat', 'code', 'review', 'instant'] as Kind[]) submit(lab, kind);
};
describe('scheduler teaching scenarios', () => {
  it('places mixed work on compatible nodes and routes explicit Instant separately', () => {
    const lab = createLab();
    burst(lab);
    step(lab);
    expect(lab.tasks.map((t) => t.state)).toEqual(['running', 'running', 'running', 'running']);
    expect(lab.tasks.find((t) => t.kind === 'code')?.node).toBe(2);
    expect(lab.tasks.find((t) => t.kind === 'instant')?.node).toBeNull();
    expect(lab.nodes.filter((n) => n.state === 'booting')).toHaveLength(0);
  });
  it('serializes a cold burst behind one boot and then shares that machine', () => {
    const lab = createLab('cold');
    burst(lab);
    step(lab);
    expect(lab.nodes.filter((n) => n.state === 'booting')).toHaveLength(1);
    expect(lab.tasks.filter((t) => t.reason.includes('lease held'))).toHaveLength(2);
    for (let i = 0; i < LAB.bootSteps; i++) step(lab);
    expect(lab.tasks[0]?.node).toBe(lab.tasks[1]?.node);
    expect(lab.nodes.filter((n) => n.state === 'booting').length).toBeLessThanOrEqual(1);
  });
  it('uses existing capacity during provider shortage but never downgrades Code', () => {
    const lab = createLab('pressure');
    burst(lab);
    step(lab);
    expect(lab.tasks[0]?.state).toBe('running');
    expect(lab.tasks[1]?.reason).toContain('provider capacity');
    expect(lab.tasks[3]?.state).toBe('running');
    lab.providerAvailable = true;
    for (let i = 0; i <= LAB.bootSteps; i++) step(lab);
    expect(lab.tasks[1]?.state).toBe('running');
    expect(lab.tasks[1]?.node).toBe(2);
  });
  it('terminates a bounded capacity wait visibly', () => {
    const lab = createLab('pressure');
    submit(lab, 'code');
    for (let i = 0; i < LAB.waitSteps; i++) step(lab);
    expect(lab.tasks[0]?.state).toBe('failed');
    expect(lab.tasks[0]?.reason).toContain('deadline');
  });
  it('only sleeps an idle chat and reuses the released warm node', () => {
    const busy = createLab();
    submit(busy, 'chat');
    step(busy);
    sleepIdle(busy);
    expect(busy.tasks[0]?.state).toBe('running');
    const lab = createLab('sleep');
    sleepIdle(lab);
    expect(lab.tasks[0]?.state).toBe('sleeping');
    expect(lab.nodes[0]?.state).toBe('warm');
    submit(lab, 'chat');
    step(lab);
    expect(lab.tasks[1]?.node).toBe(1);
    expect(lab.tasks[1]?.reason).toContain('Warm reuse');
  });
  it('bounds a large burst and never overbooks or runs Code on a small node', () => {
    const lab = createLab('cold');
    for (let i = 0; i < 50; i++) burst(lab);
    expect(lab.tasks).toHaveLength(LAB.maxTasks);
    for (let i = 0; i < 30; i++) {
      step(lab);
      for (const node of lab.nodes)
        expect(
          lab.tasks.filter((t) => t.state === 'running' && t.node === node.id).length
        ).toBeLessThanOrEqual(LAB.slotsPerNode);
      expect(lab.tasks.filter((t) => t.kind === 'code' && t.node === 1)).toHaveLength(0);
      expect(lab.nodes.filter((n) => n.state === 'booting').length).toBeLessThanOrEqual(1);
    }
  });
  it('honors a node ceiling without removing existing compute', () => {
    const lab = createLab('pressure');
    lab.providerAvailable = true;
    lab.maxNodes = 1;
    submit(lab, 'code');
    step(lab);
    expect(lab.tasks[0]?.reason).toContain('node limit');
    expect(lab.nodes[0]?.state).toBe('warm');
    lab.maxNodes = 2;
    step(lab);
    expect(lab.nodes[1]?.state).toBe('booting');
  });
});
