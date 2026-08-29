import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('ProjectData alarm ordering', () => {
  it('runs storage safety before heavier lifecycle maintenance', () => {
    const source = readFileSync(
      new URL('../../../src/durable-objects/project-data/index.ts', import.meta.url),
      'utf8',
    );
    const alarmStart = source.indexOf('async alarm(): Promise<void>');
    expect(alarmStart).toBeGreaterThan(-1);

    const alarmBody = source.slice(
      alarmStart,
      source.indexOf('private async runStorageSafetyAlarm', alarmStart),
    );
    const storageSafety = alarmBody.indexOf('await this.runStorageSafetyAlarm()');
    const idleCleanup = alarmBody.indexOf('idleCleanup.checkWorkspaceIdleTimeouts');
    const reconciliation = alarmBody.indexOf('reconciliation.processReconciliationCandidates');
    const taskWaits = alarmBody.indexOf('await this.reconcileTaskWaits()');

    expect(source.indexOf('storageSafety.runProjectDataStorageSafetyAlarm')).toBeGreaterThan(-1);
    expect(storageSafety).toBeGreaterThan(-1);
    expect(idleCleanup).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(-1);
    expect(taskWaits).toBeGreaterThan(-1);
    expect(storageSafety).toBeLessThan(idleCleanup);
    expect(storageSafety).toBeLessThan(reconciliation);
    expect(storageSafety).toBeLessThan(taskWaits);
  });
});
