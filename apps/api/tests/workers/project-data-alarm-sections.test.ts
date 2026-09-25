/**
 * The real `ProjectData.alarm()` in the workerd runtime: which sections a tick runs, and the
 * per-section completion log that attributes the object's maintenance cost (idea
 * `01M27M86R544BQX86VZANZGSQ2`). Scheduler edge cases live in the unit suite; these prove the
 * production handler is wired to it.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_DATA_ALARM_SECTIONS } from '../../src/durable-objects/project-data/alarm-schedule';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

type Completion = {
  mode: 'full' | 'gated';
  fullRunReason: string | null;
  projectId: string | null;
  ranSections: string[];
  skippedSections: string[];
  failedSections: string[];
  sections: Array<{ section: string; status: string; rowsRead: number }>;
};

function completions(spy: ReturnType<typeof vi.spyOn>, projectId: string): Completion[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry?.event === 'project_data.alarm.completed' && entry.projectId === projectId
    ) as unknown as Completion[];
}

function stubFor(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectData alarm sections', () => {
  it('runs every section on its first tick, then only the sections that are due', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const projectId = `alarm-sections-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
      await instance.alarm();
    });

    const ticks = completions(logSpy, projectId);
    const first = ticks[0];
    expect(first).toMatchObject({ mode: 'full', fullRunReason: 'first_tick' });
    expect(first?.ranSections).toEqual([...PROJECT_DATA_ALARM_SECTIONS]);
    // The metered SqlStorage is the object's own: storage safety's reads are attributed to it.
    expect(first?.sections.find((s) => s.section === 'storage_safety')?.rowsRead).toBeGreaterThan(
      0
    );

    // Storage was just measured, so a follow-up tick in the same instance must not repeat it.
    const last = ticks.at(-1);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(last).toMatchObject({ mode: 'gated', fullRunReason: null, failedSections: [] });
    expect(last?.skippedSections).toContain('storage_safety');
    expect(last?.ranSections).not.toContain('storage_safety');
  });

  it('runs every section on every tick when gating is switched off', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const projectId = `alarm-sections-off-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);

    await runInDurableObject(stub, async (instance) => {
      const instanceEnv = (instance as unknown as { env: Record<string, string | undefined> }).env;
      instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED = 'false';
      try {
        await instance.alarm();
        await instance.alarm();
      } finally {
        delete instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED;
      }
    });

    const last = completions(logSpy, projectId).at(-1);
    expect(last).toMatchObject({ mode: 'full', fullRunReason: 'gating_disabled' });
    expect(last?.ranSections).toContain('storage_safety');
  });
});
