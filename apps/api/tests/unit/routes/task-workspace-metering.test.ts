import { describe, expect, it, vi } from 'vitest';

import type { TaskRunnerContext, TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import { handleWorkspaceCreation } from '../../../src/durable-objects/task-runner/workspace-steps';
import { fixture, seedHost } from './node-pool-upgrade-test-helpers';

describe('task reuse metering through real placement and SQL', () => {
  it.each([true, false])('preserves node pricing when known=%s without inventing unknown prices', async (known) => {
    const f = fixture();
    const start = await f.run({ resourceRequirements: { minVcpu: 1, minMemoryGb: 1, minDiskGb: 0 } });
    const snapshot = await seedHost(f, start);
    const prices = known ? ['€8.49/mo', 'EUR', 849, 13600] : [null, null, null, null];
    f.sqlite.prepare(`UPDATE nodes SET provider_instance_price_display = ?,
      provider_instance_price_currency = ?, provider_instance_price_monthly_cents = ?,
      provider_instance_price_hourly_micros = ? WHERE id = 'host'`).run(...prices);
    const state = {
      ...start,
      config: { ...start.config, branch: 'main', defaultBranch: 'main' },
      stepResults: { nodeId: 'host', capacityPlacementSnapshot: snapshot },
    } as TaskRunnerState;
    const rc = {
      env: f.env,
      ctx: { storage: { put: vi.fn(async () => undefined) } },
      assertRecoveryAuthority: vi.fn(async () => undefined),
      advanceToStep: vi.fn(async () => undefined),
      updateD1ExecutionStep: vi.fn(async () => undefined),
    } as unknown as TaskRunnerContext;
    await handleWorkspaceCreation(state, rc);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_dispatch');
    expect(f.sqlite.prepare(`SELECT node_id, provider_instance_type, vcpu_count,
      provider_instance_price_display, provider_instance_price_currency,
      provider_instance_price_monthly_cents, provider_instance_price_hourly_micros
      FROM compute_usage WHERE workspace_id = ?`).get(state.stepResults.workspaceId)).toEqual({
      node_id: 'host', provider_instance_type: snapshot.providerInstanceType,
      vcpu_count: snapshot.providerInstanceVcpuCount,
      provider_instance_price_display: prices[0], provider_instance_price_currency: prices[1],
      provider_instance_price_monthly_cents: prices[2], provider_instance_price_hourly_micros: prices[3],
    });
    expect(f.sqlite.prepare('SELECT workspace_id, status FROM tasks WHERE id = ?').get(start.taskId))
      .toEqual({ workspace_id: state.stepResults.workspaceId, status: 'delegated' });
  });
});
