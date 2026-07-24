/**
 * Typed client for the guided agent-credential setup sessions (Codex "Connect
 * with Codex" terminal flow). Wraps the REST contract at
 * `${VITE_API_URL}/api/agent-credential-setup-sessions`.
 *
 * All REST calls go through the shared authed `request<T>()` client (session
 * cookie via `credentials:'include'`). The terminal WebSocket is NOT fetched
 * here — the xterm `SandboxAddon` opens it directly using the URL built by
 * `buildCodexSetupWsUrl()`.
 */
import { API_URL, ApiClientError, request } from './client';

/** Base path for the guided setup session routes. */
const BASE_PATH = '/api/agent-credential-setup-sessions';

/** The single agent type guided setup supports in v1. */
export const CODEX_SETUP_AGENT_TYPE = 'openai-codex';

/**
 * Lifecycle status of a setup session. The first six are "active" (still
 * working); the last four are terminal. `completed` = credential captured +
 * saved (success).
 */
export type CodexSetupStatus =
  | 'creating'
  | 'admitting'
  | 'provisioning'
  | 'waiting_for_user'
  | 'capturing'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** Terminal (non-recoverable) statuses. */
const TERMINAL_STATUSES: ReadonlySet<CodexSetupStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** True when the session has reached a terminal status. */
export function isTerminalCodexSetupStatus(status: CodexSetupStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Whether the guided flow is available (default-OFF platform gate). */
export interface CodexSetupConfig {
  enabled: boolean;
  agentType: string;
}

/** A guided setup session as returned by create/poll. */
export interface CodexSetupSession {
  id: string;
  status: CodexSetupStatus;
  agentType: string;
  expiresAt: string;
  loginCommand: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Outcome of attempting to create a session. `POST /` can return 201 (created),
 * 202 (no capacity — retryable) or 409 (an active session already exists).
 */
export type CreateCodexSetupResult =
  | { kind: 'created'; session: CodexSetupSession }
  | { kind: 'no_capacity'; message: string }
  | { kind: 'active_exists'; message: string };

/** Raw shape of the create response body (union across 201/202). */
interface CreateSessionResponseBody {
  id?: string;
  status?: string;
  agentType?: string;
  expiresAt?: string;
  loginCommand?: string;
  message?: string;
}

/**
 * GET /config — whether the guided flow is available. Used to decide whether to
 * render the "Connect with Codex" button at all.
 */
export async function getCodexSetupConfig(): Promise<CodexSetupConfig> {
  return request<CodexSetupConfig>(`${BASE_PATH}/config`);
}

/**
 * POST / — create a setup session (leases a sandbox slot). Normalizes the
 * 201/202/409 responses into a discriminated result the modal can branch on.
 */
export async function createCodexSetupSession(): Promise<CreateCodexSetupResult> {
  try {
    const body = await request<CreateSessionResponseBody>(BASE_PATH, {
      method: 'POST',
      body: JSON.stringify({ agentType: CODEX_SETUP_AGENT_TYPE }),
    });
    // 202: all slots busy — body is { status: 'no_capacity', message }.
    if (body.status === 'no_capacity') {
      return {
        kind: 'no_capacity',
        message: body.message ?? 'All guided setup slots are in use. Please try again in a minute.',
      };
    }
    // 201: created — body is a full session row.
    return { kind: 'created', session: body as CodexSetupSession };
  } catch (err) {
    // 409: an active session already exists for this user + agent.
    if (
      err instanceof ApiClientError &&
      (err.status === 409 || err.code === 'active_session_exists')
    ) {
      return {
        kind: 'active_exists',
        message: err.message || 'A setup session is already in progress',
      };
    }
    throw err;
  }
}

/** GET /:id — poll lifecycle status. */
export async function getCodexSetupSession(id: string): Promise<CodexSetupSession> {
  return request<CodexSetupSession>(`${BASE_PATH}/${encodeURIComponent(id)}`);
}

/** POST /:id/cancel — cancel + tear down (best-effort). */
export async function cancelCodexSetupSession(
  id: string,
): Promise<{ id: string; status: CodexSetupStatus }> {
  return request<{ id: string; status: CodexSetupStatus }>(
    `${BASE_PATH}/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
}

/** GET /:id/terminal-token — mint a short-lived WS token (TTL ~5 min). */
export async function getCodexSetupTerminalToken(id: string): Promise<{ token: string }> {
  return request<{ token: string }>(`${BASE_PATH}/${encodeURIComponent(id)}/terminal-token`);
}

/**
 * Build the terminal WebSocket URL for the xterm `SandboxAddon`. Derives the
 * `ws(s)://` origin from `VITE_API_URL` (http -> ws, https -> wss) so it always
 * targets the same API the REST calls use.
 */
export function buildCodexSetupWsUrl(
  id: string,
  token: string,
  cols: number,
  rows: number,
): string {
  const wsBase = API_URL.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    token,
    cols: String(cols),
    rows: String(rows),
  });
  return `${wsBase}${BASE_PATH}/${encodeURIComponent(id)}/terminal/ws?${params.toString()}`;
}
