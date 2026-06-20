/**
 * Unit tests for the trial event bridge helpers.
 *
 * Covers:
 *   - bridgeAcpSessionTransition: emits trial.ready on 'running' transition,
 *     trial.error on 'failed', no-op on non-trial projects or other states.
 *   - bridgeKnowledgeAdded / bridgeIdeaCreated: no-op on non-trial projects,
 *     emit the correct event shape when a trial record is found.
 *   - All bridges swallow errors from the emitter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { readTrialByProjectMock, emitTrialEventForProjectMock } = vi.hoisted(() => ({
  readTrialByProjectMock: vi.fn(),
  emitTrialEventForProjectMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrialByProject: readTrialByProjectMock,
}));
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEventForProject: emitTrialEventForProjectMock,
}));

const bridge = await import('../../../src/services/trial/bridge');

function makeEnv(options: {
  readyUpdateChanges?: number;
  currentTrial?: { status: string; expires_at: number; claimed_by_user_id: string | null } | null;
} = {}): Env {
  const prepare = vi.fn(() => ({
    bind: vi.fn(() => ({
      run: vi.fn(async () => ({ meta: { changes: options.readyUpdateChanges ?? 1 } })),
      first: vi.fn(async () => options.currentTrial ?? null),
    })),
  }));
  return { BASE_DOMAIN: 'example.com', DATABASE: { prepare } } as unknown as Env;
}

describe('bridgeAcpSessionTransition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops on non-trial projects (readTrialByProject returns null)', async () => {
    readTrialByProjectMock.mockResolvedValueOnce(null);
    await bridge.bridgeAcpSessionTransition(makeEnv(), 'proj_nope', 'running');
    expect(emitTrialEventForProjectMock).not.toHaveBeenCalled();
  });

  it('emits trial.ready with workspaceUrl on running transition', async () => {
    const env = makeEnv();
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_1',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
    });
    await bridge.bridgeAcpSessionTransition(env, 'proj_1', 'running');
    expect(emitTrialEventForProjectMock).toHaveBeenCalledTimes(1);
    const [, , event] = emitTrialEventForProjectMock.mock.calls[0];
    expect(event.type).toBe('trial.ready');
    expect(event.workspaceUrl).toBe('https://ws-ws_1.example.com');
    expect(event.trialId).toBe('trial_1');
    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ready'")
    );
    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      expect.stringContaining('claimed_by_user_id IS NULL')
    );
    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      expect.stringContaining('expires_at > ?')
    );
  });

  it('does not emit trial.ready when D1 refused the transition and the trial is expired', async () => {
    const env = makeEnv({
      readyUpdateChanges: 0,
      currentTrial: { status: 'expired', expires_at: Date.now() - 1, claimed_by_user_id: null },
    });
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_expired',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
    });

    await bridge.bridgeAcpSessionTransition(env, 'proj_1', 'running');

    expect(emitTrialEventForProjectMock).not.toHaveBeenCalled();
  });

  it('emits trial.ready idempotently when D1 reports the trial is already ready and unexpired', async () => {
    const env = makeEnv({
      readyUpdateChanges: 0,
      currentTrial: { status: 'ready', expires_at: Date.now() + 60_000, claimed_by_user_id: null },
    });
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_ready',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
    });

    await bridge.bridgeAcpSessionTransition(env, 'proj_1', 'running');

    expect(emitTrialEventForProjectMock).toHaveBeenCalledTimes(1);
  });

  it('does not emit trial.ready idempotently after the trial has been claimed', async () => {
    const env = makeEnv({
      readyUpdateChanges: 0,
      currentTrial: { status: 'ready', expires_at: Date.now() + 60_000, claimed_by_user_id: 'user_1' },
    });
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_claimed',
      projectId: 'proj_1',
      workspaceId: 'ws_1',
    });

    await bridge.bridgeAcpSessionTransition(env, 'proj_1', 'running');

    expect(emitTrialEventForProjectMock).not.toHaveBeenCalled();
  });

  it('emits trial.error on failed transition', async () => {
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_fail',
      projectId: 'proj_fail',
      workspaceId: null,
    });
    await bridge.bridgeAcpSessionTransition(makeEnv(), 'proj_fail', 'failed', {
      errorMessage: 'agent crashed',
    });
    expect(emitTrialEventForProjectMock).toHaveBeenCalledTimes(1);
    const [, , event] = emitTrialEventForProjectMock.mock.calls[0];
    expect(event.type).toBe('trial.error');
    expect(event.message).toBe('agent crashed');
  });

  it('no-ops on unrelated transitions (e.g. pending → assigned)', async () => {
    readTrialByProjectMock.mockResolvedValueOnce({
      trialId: 'trial_x',
      projectId: 'proj_x',
      workspaceId: null,
    });
    await bridge.bridgeAcpSessionTransition(makeEnv(), 'proj_x', 'assigned');
    expect(emitTrialEventForProjectMock).not.toHaveBeenCalled();
  });

  it('swallows errors from the emitter', async () => {
    readTrialByProjectMock.mockRejectedValueOnce(new Error('KV down'));
    await expect(
      bridge.bridgeAcpSessionTransition(makeEnv(), 'proj_1', 'running')
    ).resolves.toBeUndefined();
  });
});

describe('bridgeKnowledgeAdded / bridgeIdeaCreated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops on non-trial projects', async () => {
    readTrialByProjectMock.mockResolvedValue(null);
    await bridge.bridgeKnowledgeAdded(makeEnv(), 'proj_nope', 'repo', 'obs');
    await bridge.bridgeIdeaCreated(makeEnv(), 'proj_nope', 'idea_1', 't', 's');
    expect(emitTrialEventForProjectMock).not.toHaveBeenCalled();
  });

  it('emits trial.knowledge when a trial record exists', async () => {
    readTrialByProjectMock.mockResolvedValue({
      trialId: 'trial_k',
      projectId: 'proj_k',
      workspaceId: null,
    });
    await bridge.bridgeKnowledgeAdded(
      makeEnv(),
      'proj_k',
      'repository',
      'uses TypeScript'
    );
    const [, , event] = emitTrialEventForProjectMock.mock.calls[0];
    expect(event.type).toBe('trial.knowledge');
    expect(event.entity).toBe('repository');
    expect(event.observation).toBe('uses TypeScript');
  });

  it('emits trial.idea when a trial record exists', async () => {
    readTrialByProjectMock.mockResolvedValue({
      trialId: 'trial_i',
      projectId: 'proj_i',
      workspaceId: null,
    });
    await bridge.bridgeIdeaCreated(
      makeEnv(),
      'proj_i',
      'idea_42',
      'Add CLI',
      'Short summary'
    );
    const [, , event] = emitTrialEventForProjectMock.mock.calls[0];
    expect(event.type).toBe('trial.idea');
    expect(event.ideaId).toBe('idea_42');
    expect(event.title).toBe('Add CLI');
    expect(event.summary).toBe('Short summary');
  });

  it('swallows errors from the emitter', async () => {
    readTrialByProjectMock.mockRejectedValue(new Error('KV blew up'));
    await expect(
      bridge.bridgeKnowledgeAdded(makeEnv(), 'proj_e', 'e', 'o')
    ).resolves.toBeUndefined();
    await expect(
      bridge.bridgeIdeaCreated(makeEnv(), 'proj_e', 'i', 't', 's')
    ).resolves.toBeUndefined();
  });
});
