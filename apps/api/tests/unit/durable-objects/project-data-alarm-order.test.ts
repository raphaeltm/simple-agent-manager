import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../src/durable-objects/project-data/index.ts', import.meta.url),
  'utf8'
);

function sliceMember(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThan(-1);
  const endIndex = source.indexOf(end, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

// Structural (not behavioural) verification: statement ordering inside alarm()
// cannot be observed from the outside without booting the DO, and rule 02 allows
// source-contract tests for structural checks like this one.
describe('ProjectData alarm ordering', () => {
  it('runs storage safety before heavier lifecycle maintenance', () => {
    const alarmBody = sliceMember('async alarm(): Promise<void>', 'async fetch(');

    const storageSafety = alarmBody.indexOf('this.runStorageSafetyAlarmLocked()');
    const idleCleanup = alarmBody.indexOf('idleCleanup.checkWorkspaceIdleTimeouts');
    const reconciliation = alarmBody.indexOf('reconciliation.processReconciliationCandidates');
    const taskWaits = alarmBody.indexOf('await this.reconcileTaskWaits()');

    expect(storageSafety).toBeGreaterThan(-1);
    expect(idleCleanup).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(-1);
    expect(taskWaits).toBeGreaterThan(-1);
    expect(storageSafety).toBeLessThan(idleCleanup);
    expect(storageSafety).toBeLessThan(reconciliation);
    expect(storageSafety).toBeLessThan(taskWaits);
  });

  it('routes the alarm storage-safety pass through the shared cleanup mutex', () => {
    const wrapper = sliceMember('protected runStorageSafetyAlarmLocked()', '\n  // --- DO Alarm');

    // The alarm and the manual cleanup slice must not interleave their R2 awaits
    // against the same cumulative reservation/cursor state (rule 45).
    expect(wrapper).toContain('this.withToolPayloadCleanupLock(');
    expect(wrapper).toContain('storageSafety.runProjectDataStorageSafetyAlarm');
  });
});
