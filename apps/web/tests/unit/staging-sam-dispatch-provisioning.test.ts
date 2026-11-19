import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureOwnedProvisioning,
  DISPATCH_WORK_MS,
  dispatchObservationBudget,
  observationReserveMs,
  PRIVATE_TURN_MS,
  privateTurnReserveMs,
  type ProvisioningInput,
  provisioningSummary,
  verifyNoWorkspaceAfterStop,
} from '../playwright/staging-sam-dispatch-provisioning';

afterEach(() => vi.unstubAllGlobals());
const fixture = (): ProvisioningInput => ({
  account: 'account',
  token: 'test-only-credential',
  timeout: 1000,
  userId: 'user',
  projectId: 'project',
  profileName: 'profile-run',
  marker: 'run-marker',
  baselineNodes: new Set(),
  stagingApi: 'https://api.example.test',
  ledger: {
    taskId: 'task',
    sessionId: 'session',
    profileId: 'profile',
    cleanupTargetVerified: true,
  },
  get: vi.fn().mockResolvedValue({ events: [] }),
  save: vi.fn().mockResolvedValue(undefined),
});
function database(rows: unknown[]) {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ success: true, result: [{ results: rows }] }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('bounded dispatch provisioning evidence', () => {
  it('reserves follow-up, optional recovery and confirmation inside the fixed work budget', () => {
    expect(DISPATCH_WORK_MS).toBe(1_500_000);
    expect(DISPATCH_WORK_MS - observationReserveMs(false, false)).toBe(900_000);
    expect(observationReserveMs(false, true)).toBe(240_000);
    expect(observationReserveMs(false, true, true)).toBe(390_000);
    expect(observationReserveMs(true, false)).toBe(210_000);
    expect(PRIVATE_TURN_MS + privateTurnReserveMs('followup')).toBe(540_000);
    expect(PRIVATE_TURN_MS + privateTurnReserveMs('followup-recovery')).toBe(390_000);
    expect(PRIVATE_TURN_MS + privateTurnReserveMs('stop')).toBe(240_000);
  });
  it('labels a shortened initial window as test budget, not platform readiness failure', () => {
    const budget = dispatchObservationBudget(
      DISPATCH_WORK_MS,
      120_000,
      180_000,
      false,
      false,
      false
    );
    expect(budget).toMatchObject({
      endsAt: 900_000,
      platformReadinessEndsAt: 1_020_000,
      limitedBy: 'test-work-reserve',
    });
    expect(DISPATCH_WORK_MS - budget.endsAt).toBe(600_000);
  });
  it('uses the full 900s from accepted dispatch when downstream reservations fit', () => {
    expect(
      dispatchObservationBudget(DISPATCH_WORK_MS, 120_000, 180_000, true, false, false)
    ).toMatchObject({ endsAt: 1_020_000, limitedBy: 'readiness' });
  });
  it('keeps an optional recovery and stop reserve after a late follow-up observation', () => {
    const budget = dispatchObservationBudget(
      DISPATCH_WORK_MS,
      120_000,
      1_100_000,
      false,
      true,
      true
    );
    expect(budget).toMatchObject({ phase: 'followup-answer', endsAt: 1_110_000 });
    expect(DISPATCH_WORK_MS - budget.endsAt).toBe(
      PRIVATE_TURN_MS + privateTurnReserveMs('followup-recovery')
    );
  });
  it('retains only fixed provisioning phases, statuses, timestamps and durations', () => {
    const result = provisioningSummary({
      nextCursor: 'private-cursor',
      events: [
        {
          type: 'provision.docker',
          createdAt: '2026-10-20T00:00:00Z',
          message: 'PRIVATE_SECRET',
          detail: { status: 'completed', durationMs: 12, command: 'PRIVATE_SECRET' },
        },
        {
          type: 'provision.unknown',
          createdAt: '2026-10-20T00:00:00Z',
          detail: { status: 'failed' },
        },
        { type: 'provision.packages', createdAt: 'invalid', detail: { status: 'started' } },
      ],
    });
    expect(result).toEqual({
      paginationPresent: true,
      events: [
        {
          phase: 'docker',
          status: 'completed',
          durationMs: 12,
          createdAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('records an owned node before a workspace exists using every exact task constraint', async () => {
    const input = fixture();
    const fetch = database([
      { nodeId: 'node', ownedNodeId: 'node', taskStatus: 'queued', readyAt: null },
    ]);
    await captureOwnedProvisioning(input, true);
    const query = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(query.params).toEqual([
      'task',
      'project',
      'user',
      'session',
      'profile',
      'profile-run',
      'run-marker',
    ]);
    expect(query.sql).toContain('n.user_id=t.user_id');
    expect(query.sql).toContain('instr(t.description,?)>0');
    expect(input.ledger.nodeId).toBe('node');
    expect(input.ledger.provisioningNodeVerified).toBe(true);
    expect(input.get).toHaveBeenCalledWith(
      'https://api.example.test/api/nodes/node/events?limit=100'
    );
    expect(JSON.stringify(input.ledger)).not.toContain(input.token);
    expect(input.save).toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    { rows: [{ nodeId: 'node', ownedNodeId: null }] },
    { rows: [{ nodeId: 'node', ownedNodeId: 'other' }] },
  ])('never adopts a node without exact ownership evidence: %j', async ({ rows }) => {
    const input = fixture();
    database(rows);
    await captureOwnedProvisioning(input, true);
    expect(input.ledger.nodeId).toBeUndefined();
    expect(input.ledger.provisioningDiagnosticStatus).toBe('unavailable');
    expect(input.get).not.toHaveBeenCalled();
  });
  it('keeps proved identity if optional diagnostics fail and exposes no error body', async () => {
    const input = fixture();
    database([{ nodeId: 'node', ownedNodeId: 'node' }]);
    input.get = vi.fn().mockRejectedValue(new Error('PRIVATE_SECRET'));
    await captureOwnedProvisioning(input, true);
    expect(input.ledger.nodeId).toBe('node');
    expect(input.ledger.provisioningDiagnosticStatus).toBe('unavailable');
    expect(JSON.stringify(input.ledger)).not.toContain('PRIVATE_SECRET');
  });
  it('requires terminal scoped work and no linked workspace before no-workspace cleanup', async () => {
    const input = fixture();
    input.ledger.cleanup = { stopOwnedWork: 'confirmed' };
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: 'task', status: 'cancelled', workspaceId: null })
      .mockResolvedValueOnce({ session: { id: 'session', status: 'stopped' } })
      .mockResolvedValueOnce([]);
    expect(await verifyNoWorkspaceAfterStop(input.ledger, 'project', 'api', get)).toBe(true);
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce({ id: 'task', status: 'cancelled', workspaceId: null })
      .mockResolvedValueOnce({ session: { id: 'session', status: 'stopped' } })
      .mockResolvedValueOnce([{ chatSessionId: 'session' }]);
    expect(await verifyNoWorkspaceAfterStop(input.ledger, 'project', 'api', unsafe)).toBe(false);
  });
});
