import { describe, expect, it, vi } from 'vitest';

import { handleNodeSelection } from '../../src/durable-objects/task-runner/node-steps';
import type { TaskRunnerContext, TaskRunnerState } from '../../src/durable-objects/task-runner/types';

// Task-runner node reuse must never select cf-container (instant-session)
// nodes: the standalone vm-agent hosts exactly one lightweight workspace and
// rejects task-runner re-dispatch (no `lightweight` flag) with a 409 profile
// conflict — the same class node-lifecycle.ts already guards against. These
// tests capture the SQL the selection step actually issues to D1 and assert
// both reuse queries carry the runtime exclusion.

function makeCapturingDb(issuedSql: string[]) {
  return {
    prepare: (sql: string) => {
      issuedSql.push(sql);
      return {
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
        }),
      };
    },
  };
}

describe('handleNodeSelection runtime guards', () => {
  it('excludes cf-container nodes from both warm-pool and capacity reuse queries', async () => {
    const issuedSql: string[] = [];
    const rc = {
      env: { DATABASE: makeCapturingDb(issuedSql), NODE_LIFECYCLE: {} },
      updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
      advanceToStep: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskRunnerContext;
    const state = {
      taskId: 'task-1',
      userId: 'user-1',
      config: { vmSize: 'small', vmLocation: 'fsn1' },
      stepResults: {},
    } as unknown as TaskRunnerState;

    await handleNodeSelection(state, rc);

    const warmSql = issuedSql.find((sql) => sql.includes('warm_since IS NOT NULL'));
    const capacitySql = issuedSql.find((sql) => sql.includes("health_status != 'unhealthy'"));
    expect(warmSql, 'warm-pool query was not issued').toBeDefined();
    expect(capacitySql, 'capacity reuse query was not issued').toBeDefined();
    expect(warmSql).toContain("runtime IS NULL OR runtime != 'cf-container'");
    expect(capacitySql).toContain("runtime IS NULL OR runtime != 'cf-container'");

    // With no eligible nodes the step falls through to provisioning.
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });
});
