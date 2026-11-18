import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const alarmSources = [
  'node-lifecycle.ts',
  // ProjectData lives in its own package (packages/project-data).
  '../../../../packages/project-data/src/do/index.ts',
  'project-orchestrator/index.ts',
  'task-runner/index.ts',
  'diagnosis-runner.ts',
  'credential-setup-session/index.ts',
] as const;

describe('alarm kill-switch wiring', () => {
  it.each(alarmSources)('%s defers before running alarm work', (relativePath) => {
    const source = readFileSync(
      new URL(`../../../src/durable-objects/${relativePath}`, import.meta.url),
      'utf8'
    );
    const alarmStart = source.indexOf('async alarm(): Promise<void>');
    expect(alarmStart).toBeGreaterThan(-1);
    const alarm = source.slice(alarmStart);
    const schedulingStart = alarm.indexOf('runSchedulingCycle(');
    const allowsLocalExpiry = relativePath === 'project-orchestrator/index.ts';
    const alarmPrefix = alarm.slice(0, allowsLocalExpiry ? schedulingStart : 350);
    if (allowsLocalExpiry) {
      const killSwitchStart = alarm.indexOf('deferAlarmWhenDisabled');
      expect(schedulingStart).toBeGreaterThan(killSwitchStart);
      const expiryStart = alarm.indexOf('expireMissionCancellations(');
      expect(expiryStart).toBeGreaterThan(-1);
      expect(expiryStart).toBeLessThan(killSwitchStart);
      // Only synchronous local expiry may precede the remote operational setting read.
      const killSwitchGuard = alarm.indexOf('if (await deferAlarmWhenDisabled');
      expect(killSwitchGuard).toBeGreaterThan(expiryStart);
      expect(alarm.slice(0, killSwitchGuard)).not.toMatch(/\bawait\b|this\.env/);
    }
    expect(alarmPrefix).toContain('deferAlarmWhenDisabled');
    expect(alarmPrefix).toMatch(/deferAlarmWhenDisabled[\s\S]*return/);
  });
});
