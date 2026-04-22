/**
 * Unit tests for trial-runner.
 *
 * Covers:
 *   - resolveTrialRunnerConfig — mode resolution (staging/production),
 *     agentType default per mode, provider override, model override
 *   - startDiscoveryAgent — creates chat + ACP session with discovery prompt
 *   - Anthropic provider requires platform credential (admin-configured)
 *   - emitTrialEvent — appends to TrialEventBus DO stub, no-ops on error
 *   - emitTrialEventForProject — looks up trial by project then appends
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock project-data service functions used by startDiscoveryAgent
const { createSessionMock, createAcpSessionMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  createAcpSessionMock: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  createSession: createSessionMock,
  createAcpSession: createAcpSessionMock,
}));

// Mock trial-store's readTrialByProject used by emitTrialEventForProject
const { readTrialByProjectMock, readTrialMock } = vi.hoisted(() => ({
  readTrialByProjectMock: vi.fn(),
  readTrialMock: vi.fn(),
}));
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrialByProject: readTrialByProjectMock,
  readTrial: readTrialMock,
}));

// Mock platform-credentials + secrets used by startDiscoveryAgent for Anthropic key
const { getPlatformAgentCredentialMock } = vi.hoisted(() => ({
  getPlatformAgentCredentialMock: vi.fn(),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: getPlatformAgentCredentialMock,
}));
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-encryption-key',
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

// Silence logs
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Env } from '../../../src/env';
import {
  emitTrialEvent,
  emitTrialEventForProject,
  resolveTrialRunnerConfig,
  startDiscoveryAgent,
} from '../../../src/services/trial/trial-runner';

function envBase(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: undefined,
    ...overrides,
  } as unknown as Env;
}

describe('trial-runner — resolveTrialRunnerConfig', () => {
  it('defaults to staging mode when ENVIRONMENT is unset', () => {
    const cfg = resolveTrialRunnerConfig(envBase());
    expect(cfg.mode).toBe('staging');
    expect(cfg.agentType).toBe('opencode');
    expect(cfg.provider).toBe('workers-ai');
  });

  it('detects production mode from ENVIRONMENT=production', () => {
    const cfg = resolveTrialRunnerConfig(envBase({ ENVIRONMENT: 'production' } as Partial<Env>));
    expect(cfg.mode).toBe('production');
    expect(cfg.agentType).toBe('claude-code');
    expect(cfg.provider).toBe('anthropic');
  });

  it('detects production mode from ENVIRONMENT=prod', () => {
    const cfg = resolveTrialRunnerConfig(envBase({ ENVIRONMENT: 'prod' } as Partial<Env>));
    expect(cfg.mode).toBe('production');
  });

  it('honours TRIAL_AGENT_TYPE_STAGING override', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({ TRIAL_AGENT_TYPE_STAGING: 'codex' } as Partial<Env>)
    );
    expect(cfg.agentType).toBe('codex');
  });

  it('honours TRIAL_AGENT_TYPE_PRODUCTION override', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({
        ENVIRONMENT: 'production',
        TRIAL_AGENT_TYPE_PRODUCTION: 'gemini',
      } as Partial<Env>)
    );
    expect(cfg.agentType).toBe('gemini');
  });

  it('honours TRIAL_LLM_PROVIDER override', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({ TRIAL_LLM_PROVIDER: 'anthropic' } as Partial<Env>)
    );
    expect(cfg.provider).toBe('anthropic');
  });

  it('honours TRIAL_MODEL override', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({
        ENVIRONMENT: 'production',
        TRIAL_MODEL: 'claude-opus-4-6',
      } as Partial<Env>)
    );
    expect(cfg.model).toBe('claude-opus-4-6');
  });

  it('falls back to workers-ai model default when provider=workers-ai', () => {
    const cfg = resolveTrialRunnerConfig(envBase());
    expect(cfg.model).toContain('llama');
  });

  it('falls back to anthropic model default when provider=anthropic', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({ ENVIRONMENT: 'production' } as Partial<Env>)
    );
    expect(cfg.model).toContain('claude');
  });

  it('ignores invalid provider override and uses mode default', () => {
    const cfg = resolveTrialRunnerConfig(
      envBase({ TRIAL_LLM_PROVIDER: 'garbage-provider' } as Partial<Env>)
    );
    expect(cfg.provider).toBe('workers-ai');
  });
});

describe('trial-runner — startDiscoveryAgent', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    createAcpSessionMock.mockReset();
    createSessionMock.mockResolvedValue('chat_session_1');
    createAcpSessionMock.mockResolvedValue({ id: 'acp_session_1' });
  });

  it('creates chat + ACP session with discovery prompt and returns resolved config', async () => {
    const env = envBase();
    const result = await startDiscoveryAgent(env, {
      projectId: 'proj_1',
      workspaceId: 'ws_1',
      sessionTopic: 'acme/repo',
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      env,
      'proj_1',
      'ws_1',
      'acme/repo',
      null
    );
    expect(createAcpSessionMock).toHaveBeenCalledTimes(1);
    const [, projectId, chatSessionId, prompt, agentType] = createAcpSessionMock.mock.calls[0];
    expect(projectId).toBe('proj_1');
    expect(chatSessionId).toBe('chat_session_1');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(agentType).toBe('opencode'); // staging default

    expect(result.chatSessionId).toBe('chat_session_1');
    expect(result.acpSessionId).toBe('acp_session_1');
    expect(result.agentType).toBe('opencode');
    expect(result.provider).toBe('workers-ai');
    expect(result.promptVersion).toBeTruthy();
  });

  it('defaults sessionTopic to "Exploring repository" when not provided', async () => {
    await startDiscoveryAgent(envBase(), {
      projectId: 'p',
      workspaceId: 'w',
    });
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      'p',
      'w',
      'Exploring repository',
      null
    );
  });

  it('throws when anthropic provider but no platform credential configured', async () => {
    getPlatformAgentCredentialMock.mockResolvedValue(null);
    const env = envBase({ ENVIRONMENT: 'production' } as Partial<Env>);
    await expect(
      startDiscoveryAgent(env, { projectId: 'p', workspaceId: 'w' })
    ).rejects.toThrow(/No Anthropic API key configured/);
  });

  it('succeeds when anthropic provider + platform credential is configured', async () => {
    getPlatformAgentCredentialMock.mockResolvedValue({
      credential: 'sk-ant-test',
      credentialKind: 'api-key',
    });
    const env = envBase({ ENVIRONMENT: 'production' } as Partial<Env>);
    const result = await startDiscoveryAgent(env, {
      projectId: 'p',
      workspaceId: 'w',
    });
    expect(result.agentType).toBe('claude-code');
    expect(result.provider).toBe('anthropic');
  });
});

describe('trial-runner — emitTrialEvent', () => {
  it('appends to TrialEventBus DO via /append', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ cursor: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const stub = { fetch: fetchStub };
    const env = {
      TRIAL_EVENT_BUS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => stub),
      },
    } as unknown as Env;

    await emitTrialEvent(env, 'trial_abc', {
      type: 'trial.progress',
      message: 'cloning',
      at: Date.now(),
    } as never);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(String(url)).toContain('/append');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('silently swallows append errors (best-effort)', async () => {
    const stub = {
      fetch: vi.fn(async () => {
        throw new Error('network');
      }),
    };
    const env = {
      TRIAL_EVENT_BUS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => stub),
      },
    } as unknown as Env;

    await expect(
      emitTrialEvent(env, 'trial_abc', { type: 'trial.progress', message: 'x', at: 0 } as never)
    ).resolves.toBeUndefined();
  });

  it('ignores 409 closed responses from DO', async () => {
    const fetchStub = vi.fn(async () => new Response('closed', { status: 409 }));
    const env = {
      TRIAL_EVENT_BUS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => ({ fetch: fetchStub })),
      },
    } as unknown as Env;

    await expect(
      emitTrialEvent(env, 'trial_abc', { type: 'trial.ready', at: 0 } as never)
    ).resolves.toBeUndefined();
  });
});

describe('trial-runner — emitTrialEventForProject', () => {
  beforeEach(() => {
    readTrialByProjectMock.mockReset();
  });

  it('no-ops when no trial record exists for the project', async () => {
    readTrialByProjectMock.mockResolvedValue(null);
    const env = {} as Env;
    await emitTrialEventForProject(env, 'proj_nope', {
      type: 'trial.progress',
      message: 'x',
      at: 0,
    } as never);
    // Nothing to assert — should just not throw.
  });

  it('emits to trialId when a record exists for the project', async () => {
    readTrialByProjectMock.mockResolvedValue({
      trialId: 'trial_abc',
      projectId: 'proj_1',
    });
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ cursor: 1 }), { status: 200 })
    );
    const env = {
      TRIAL_EVENT_BUS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => ({ fetch: fetchStub })),
      },
    } as unknown as Env;

    await emitTrialEventForProject(env, 'proj_1', {
      type: 'trial.progress',
      message: 'x',
      at: 0,
    } as never);

    expect(readTrialByProjectMock).toHaveBeenCalledWith(env, 'proj_1');
    expect(fetchStub).toHaveBeenCalled();
  });
});
