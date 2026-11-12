/**
 * Mock factories for tests that render `useSessionLifecycle` with the real socket hook.
 *
 * `vi.mock` is hoisted above imports, so use these from an async factory:
 * `vi.mock(path, async () => (await import('../helpers/session-lifecycle-mocks')).authMock())`.
 */
import { vi } from 'vitest';

type ApiModule = typeof import('../../../src/lib/api');

/** The real API module with every network call the lifecycle makes stubbed, plus `overrides`. */
export async function lifecycleApiMock(
  importOriginal: () => Promise<ApiModule>,
  overrides: Partial<Record<keyof ApiModule, unknown>>
) {
  return {
    ...(await importOriginal()),
    getWorkspace: vi.fn(),
    getNode: vi.fn(),
    getTerminalToken: vi.fn(),
    getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
    resetIdleTimer: vi.fn(),
    sendFollowUpPrompt: vi.fn(),
    cancelAgentPrompt: vi.fn(),
    uploadSessionFiles: vi.fn(),
    requestAttachmentUpload: vi.fn(),
    uploadAttachmentToR2: vi.fn(),
    ...overrides,
  };
}

export const authMock = () => ({ useAuth: () => ({ user: { id: 'user-1' } }) });
export const queryScopeMock = () => ({ useQueryScope: () => 'user-1' });
export const tokenRefreshMock = () => ({ useTokenRefresh: () => ({ token: null }) });
export const workspacePortsMock = () => ({ useWorkspacePorts: () => ({ ports: [] }) });

/** Pass stable functions: a new identity per render re-runs the lifecycle's snapshot effect. */
export const activityVerifyTimerMock = (
  startVerifyDecayTimer: () => void,
  stopVerifyDecayTimer: () => void
) => ({
  useActivityVerifyTimer: () => ({ startVerifyDecayTimer, stopVerifyDecayTimer }),
});

export const connectionRecoveryMock = () => ({
  useConnectionRecovery: () => ({
    isResuming: false,
    resumeError: null,
    showConnectionBanner: false,
    idleCountdownMs: null,
    clearResumeError: vi.fn(),
    reportDeliveryError: vi.fn(),
    resumeAndSend: vi.fn(),
  }),
});
