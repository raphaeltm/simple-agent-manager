import { describe, expect, it } from 'vitest';

import { isNodeAgentReadyForWorkspaceDispatch } from '../../../src/durable-objects/task-runner/readiness';

describe('isNodeAgentReadyForWorkspaceDispatch', () => {
  it('accepts a fresh heartbeat even when /ready happened before the poll window', () => {
    const waitStartedAt = Date.parse('2026-05-21T10:00:00.000Z');

    const ready = isNodeAgentReadyForWorkspaceDispatch(
      {
        status: 'running',
        health_status: 'healthy',
        // /ready is sent once during VM agent startup and may predate the
        // task-runner poll window if provisioning bookkeeping takes time.
        agent_ready_at: '2026-05-21T09:58:10.000Z',
        // Heartbeat is fresh relative to this task's wait start.
        last_heartbeat_at: '2026-05-21T10:00:05.000Z',
      },
      waitStartedAt,
    );

    expect(ready).toBe(true);
  });

  it('rejects when heartbeat is stale even if /ready exists', () => {
    const waitStartedAt = Date.parse('2026-05-21T10:00:00.000Z');

    const ready = isNodeAgentReadyForWorkspaceDispatch(
      {
        status: 'running',
        health_status: 'healthy',
        agent_ready_at: '2026-05-21T09:50:00.000Z',
        last_heartbeat_at: '2026-05-21T09:58:00.000Z',
      },
      waitStartedAt,
    );

    expect(ready).toBe(false);
  });

  it('rejects when /ready timestamp is ahead of heartbeat by more than skew budget', () => {
    const waitStartedAt = Date.parse('2026-05-21T10:00:00.000Z');

    const ready = isNodeAgentReadyForWorkspaceDispatch(
      {
        status: 'running',
        health_status: 'healthy',
        // Impossible ordering suggests mixed/stale timestamps from different cycles.
        agent_ready_at: '2026-05-21T10:01:00.000Z',
        last_heartbeat_at: '2026-05-21T10:00:05.000Z',
      },
      waitStartedAt,
    );

    expect(ready).toBe(false);
  });
});
