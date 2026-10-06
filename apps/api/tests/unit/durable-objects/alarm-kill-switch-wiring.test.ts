import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const alarmSources = [
  'node-lifecycle.ts',
  'project-data/index.ts',
  'project-orchestrator/index.ts',
  'task-runner/index.ts',
  'trial-orchestrator/index.ts',
  'diagnosis-runner.ts',
  'credential-setup-session/index.ts',
] as const;

describe('alarm kill-switch wiring', () => {
  it.each(alarmSources)('%s defers before running alarm work', (relativePath) => {
    const source = readFileSync(
      new URL(`../../../src/durable-objects/${relativePath}`, import.meta.url),
      'utf8',
    );
    const alarmStart = source.indexOf('async alarm(): Promise<void>');
    expect(alarmStart).toBeGreaterThan(-1);
    const alarmPrefix = source.slice(alarmStart, alarmStart + 350);
    expect(alarmPrefix).toContain('deferAlarmWhenDisabled');
    expect(alarmPrefix).toMatch(/deferAlarmWhenDisabled[\s\S]*return/);
  });
});
