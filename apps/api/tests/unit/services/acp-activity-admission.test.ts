import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpActivityBinding,
  AcpActivityCallbackReport,
  AcpActivityFlushHandler,
} from '../../../src/services/acp-activity-admission';
import {
  cacheAcpActivityBinding,
  coalesceAcpActivityAfterProjectDataTransient,
  getAcpActivityAdmissionConfig,
  getAcpActivityAdmissionSnapshotForTests,
  getCachedAcpActivityBinding,
  recordAcpActivityAdmissionSuccess,
  resetAcpActivityAdmissionForTests,
} from '../../../src/services/acp-activity-admission';
import { recordAcpActivityCallbackMetric } from '../../../src/services/telemetry';

vi.mock('../../../src/services/telemetry', () => ({
  recordAcpActivityCallbackMetric: vi.fn(),
}));

const env = {
  ACP_ACTIVITY_COALESCE_WINDOW_MS: '1000',
  ACP_ACTIVITY_COALESCE_TTL_MS: '3000',
  ACP_ACTIVITY_COALESCE_MAX_PENDING: '2',
  ACP_ACTIVITY_BINDING_CACHE_TTL_MS: '1000',
  ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES: '2',
} as never;

function binding(sessionId: string): AcpActivityBinding {
  return {
    sessionId,
    chatSessionId: `chat-${sessionId}`,
    workspaceId: `workspace-${sessionId}`,
    nodeId: `node-${sessionId}`,
    acpSdkSessionId: null,
    status: 'running',
    agentType: 'openai-codex',
  };
}

function report(overrides: Partial<AcpActivityCallbackReport> = {}): AcpActivityCallbackReport {
  return {
    activity: 'prompting',
    nodeId: 'node-session-1',
    promptStartedAt: 100,
    agentType: 'openai-codex',
    ...overrides,
  };
}

const waitUntil = vi.fn((promise: Promise<unknown>) => {
  void promise.catch(() => undefined);
});

const flush: AcpActivityFlushHandler = vi.fn(async () => ({ action: 'flushed' }));

describe('ACP activity admission controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAcpActivityAdmissionForTests();
  });

  it('parses configuration with finite defaults and disables only explicit false-like values', () => {
    expect(getAcpActivityAdmissionConfig({}).enabled).toBe(true);
    expect(
      getAcpActivityAdmissionConfig({
        ACP_ACTIVITY_ADMISSION_ENABLED: 'false',
        ACP_ACTIVITY_COALESCE_WINDOW_MS: '5000',
        ACP_ACTIVITY_COALESCE_TTL_MS: '1000',
      })
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        coalesceWindowMs: 5000,
        coalesceTtlMs: 5000,
      })
    );
  });

  it('bounds pending coalesced callbacks and emits observable eviction instead of silently dropping', () => {
    const config = getAcpActivityAdmissionConfig(env);
    for (const sessionId of ['session-1', 'session-2', 'session-3']) {
      coalesceAcpActivityAfterProjectDataTransient({
        env,
        config,
        projectId: 'project-1',
        sessionId,
        binding: binding(sessionId),
        report: report({ nodeId: `node-${sessionId}` }),
        waitUntil,
        flush,
        now: 100,
      });
    }

    expect(getAcpActivityAdmissionSnapshotForTests().pending).toBe(2);
    expect(recordAcpActivityCallbackMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'rejected',
        reason: 'pending_capacity_evicted',
        pendingCount: 1,
      }),
      env
    );
  });

  it('expires pending reports and leaves convergence to the reconciliation probe after the TTL', () => {
    const config = getAcpActivityAdmissionConfig(env);
    coalesceAcpActivityAfterProjectDataTransient({
      env,
      config,
      projectId: 'project-1',
      sessionId: 'session-1',
      binding: binding('session-1'),
      report: report({ nodeId: 'node-session-1', restartCount: 1 }),
      waitUntil,
      flush,
      now: 100,
    });

    expect(getAcpActivityAdmissionSnapshotForTests().pending).toBe(1);

    coalesceAcpActivityAfterProjectDataTransient({
      env,
      config,
      projectId: 'project-1',
      sessionId: 'session-2',
      binding: binding('session-2'),
      report: report({ nodeId: 'node-session-2' }),
      waitUntil,
      flush,
      now: 3200,
    });

    expect(getAcpActivityAdmissionSnapshotForTests().pending).toBe(1);
    expect(recordAcpActivityCallbackMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'rejected',
        reason: 'pending_ttl_expired',
        sessionId: 'session-1',
      }),
      env
    );
  });

  it('bounds and expires the authorized binding cache', () => {
    const config = getAcpActivityAdmissionConfig(env);

    cacheAcpActivityBinding(config, 'project-1', binding('session-1'), 0);
    cacheAcpActivityBinding(config, 'project-1', binding('session-2'), 1);
    cacheAcpActivityBinding(config, 'project-1', binding('session-3'), 2);

    expect(getAcpActivityAdmissionSnapshotForTests().cachedBindings).toBe(2);
    expect(getCachedAcpActivityBinding(config, 'project-1', 'session-1', 500)).toBeNull();
    expect(getCachedAcpActivityBinding(config, 'project-1', 'session-2', 500)).not.toBeNull();
    expect(getCachedAcpActivityBinding(config, 'project-1', 'session-2', 1002)).toBeNull();
  });

  it('bounds recent admitted activity state with the configured session cache cap', () => {
    const sessions = [
      ['session-1', 0],
      ['session-2', 1],
      ['session-3', 2],
    ] as const;
    for (const [sessionId, now] of sessions) {
      recordAcpActivityAdmissionSuccess({
        env,
        projectId: 'project-1',
        sessionId,
        binding: binding(sessionId),
        report: report({ nodeId: `node-${sessionId}` }),
        reason: 'first_report',
        now,
      });
    }

    expect(getAcpActivityAdmissionSnapshotForTests().recent).toBe(2);
  });
});
