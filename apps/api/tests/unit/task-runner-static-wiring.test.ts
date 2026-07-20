/**
 * Static wiring checks for TaskRunner definitions that are not useful to execute
 * as behavior in unit tests. Runtime behavior belongs in behavioral tests such
 * as task-runner-agent-session.test.ts, task-runner-state-machine.test.ts, and
 * workers/task-runner-do.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const taskRunnerIndexSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner/index.ts'),
  'utf8',
);
const taskRunnerTypesSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner/types.ts'),
  'utf8',
);

describe('TaskRunner static public contract', () => {
  it('exports the Durable Object RPC surface used by Worker callers', () => {
    expect(taskRunnerIndexSource).toContain('async start(input: StartTaskInput): Promise<void>');
    expect(taskRunnerIndexSource).toContain('async advanceWorkspaceReady(');
    expect(taskRunnerIndexSource).toContain('async getStatus(): Promise<TaskRunnerState | null>');
    expect(taskRunnerIndexSource).toContain('async ensureStarted(): Promise<boolean>');
  });

  it('commits initial state and the first alarm atomically', () => {
    expect(taskRunnerIndexSource).toContain('this.ctx.storage.transaction(async (transaction) =>');
    expect(taskRunnerIndexSource).toContain("await transaction.put('state', state)");
    expect(taskRunnerIndexSource).toContain('await transaction.setAlarm(now)');
  });

  it('keeps TaskRunnerState versioned and exportable for DO storage compatibility', () => {
    expect(taskRunnerTypesSource).toContain('export interface TaskRunnerState');
    expect(taskRunnerTypesSource).toContain('version: 1');
  });

  it('keeps StepResults fields that persisted DO state already depends on', () => {
    expect(taskRunnerTypesSource).toContain('export interface StepResults');
    expect(taskRunnerTypesSource).toContain('agentSessionId: string | null');
    expect(taskRunnerTypesSource).toContain('agentStarted: boolean');
    expect(taskRunnerTypesSource).toContain('mcpToken: string | null');
    expect(taskRunnerTypesSource).toContain('provisionedVmSize: VMSize | null');
  });
});
