/**
 * Typed client for native guided-login setup sessions. Wraps the REST contract at
 * `${VITE_API_URL}/api/agent-credential-setup-sessions`.
 *
 * All calls go through the shared authenticated request client. Provider login
 * process details remain server-side; this client receives semantic status,
 * verification URL, and optional one-time code fields only.
 */
import { ApiClientError, request } from './client';

/** Base path for the guided setup session routes. */
const BASE_PATH = '/api/agent-credential-setup-sessions';

export const CODEX_SETUP_AGENT_TYPE = 'openai-codex';
export const CLAUDE_CODE_SETUP_AGENT_TYPE = 'claude-code';
export const GUIDED_SETUP_AGENT_TYPES = [
  CODEX_SETUP_AGENT_TYPE,
  CLAUDE_CODE_SETUP_AGENT_TYPE,
] as const;
export type GuidedSetupAgentType = (typeof GUIDED_SETUP_AGENT_TYPES)[number];

export function isGuidedSetupAgentType(value: string): value is GuidedSetupAgentType {
  return GUIDED_SETUP_AGENT_TYPES.includes(value as GuidedSetupAgentType);
}

/**
 * Lifecycle status of a setup session. The first six are "active" (still
 * working); the last four are terminal. `completed` = credential captured +
 * saved (success).
 */
export type AgentCredentialSetupStatus =
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

export type CodexSetupStatus = AgentCredentialSetupStatus;

/** Terminal (non-recoverable) statuses. */
const TERMINAL_STATUSES: ReadonlySet<AgentCredentialSetupStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** True when the session has reached a terminal status. */
export function isTerminalAgentCredentialSetupStatus(status: AgentCredentialSetupStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const isTerminalCodexSetupStatus = isTerminalAgentCredentialSetupStatus;

/** Whether the guided flow is available from the deployed runtime bindings. */
export interface AgentCredentialSetupConfig {
  enabled: boolean;
  /** Back-compat: the default guided setup agent. */
  agentType: string;
  /** All guided setup agents supported by this deployment. Absent on older API versions. */
  agentTypes?: string[];
}

export type CodexSetupConfig = AgentCredentialSetupConfig;

/** A guided setup session as returned by create/poll. */
export interface AgentCredentialSetupSession {
  id: string;
  status: AgentCredentialSetupStatus;
  agentType: string;
  expiresAt: string;
  verificationUrl?: string | null;
  userCode?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export type CodexSetupSession = AgentCredentialSetupSession;

/**
 * Outcome of attempting to create a session. `POST /` can return 201 (created),
 * 202 (no capacity — retryable) or 409 (an active session already exists).
 */
export type CreateAgentCredentialSetupResult =
  | { kind: 'created'; session: AgentCredentialSetupSession }
  | { kind: 'no_capacity'; message: string }
  | { kind: 'active_exists'; message: string };

export type CreateCodexSetupResult = CreateAgentCredentialSetupResult;

/** Raw shape of the create response body (union across 201/202). */
interface CreateSessionResponseBody {
  id?: string;
  status?: string;
  agentType?: string;
  expiresAt?: string;
  verificationUrl?: string | null;
  userCode?: string | null;
  message?: string;
}

export function setupConfigSupportsAgent(
  config: AgentCredentialSetupConfig,
  agentType: GuidedSetupAgentType
): boolean {
  if (!config.enabled) return false;
  if (Array.isArray(config.agentTypes)) return config.agentTypes.includes(agentType);
  return config.agentType === agentType;
}

/** GET /config — whether the guided flow is available. */
export async function getAgentCredentialSetupConfig(): Promise<AgentCredentialSetupConfig> {
  return request<AgentCredentialSetupConfig>(`${BASE_PATH}/config`);
}

export const getCodexSetupConfig = getAgentCredentialSetupConfig;

/**
 * POST / — create a setup session (leases a sandbox slot). Normalizes the
 * 201/202/409 responses into a discriminated result the modal can branch on.
 */
export async function createAgentCredentialSetupSession(
  agentType: GuidedSetupAgentType
): Promise<CreateAgentCredentialSetupResult> {
  try {
    const body = await request<CreateSessionResponseBody>(BASE_PATH, {
      method: 'POST',
      body: JSON.stringify({ agentType }),
    });
    // 202: all slots busy — body is { status: 'no_capacity', message }.
    if (body.status === 'no_capacity') {
      return {
        kind: 'no_capacity',
        message: body.message ?? 'All guided setup slots are in use. Please try again in a minute.',
      };
    }
    // 201: created — body is a full session row.
    return { kind: 'created', session: body as AgentCredentialSetupSession };
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

export function createCodexSetupSession(): Promise<CreateCodexSetupResult> {
  return createAgentCredentialSetupSession(CODEX_SETUP_AGENT_TYPE);
}

/** GET /:id — poll lifecycle status. */
export async function getAgentCredentialSetupSession(
  id: string
): Promise<AgentCredentialSetupSession> {
  return request<AgentCredentialSetupSession>(`${BASE_PATH}/${encodeURIComponent(id)}`);
}

export const getCodexSetupSession = getAgentCredentialSetupSession;

/** POST /:id/cancel — cancel + tear down (best-effort). */
export async function cancelAgentCredentialSetupSession(
  id: string
): Promise<{ id: string; status: AgentCredentialSetupStatus }> {
  return request<{ id: string; status: AgentCredentialSetupStatus }>(
    `${BASE_PATH}/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' }
  );
}

export const cancelCodexSetupSession = cancelAgentCredentialSetupSession;

/** POST /:id/credential — complete Claude Code setup with the browser-returned token. */
export async function submitAgentCredentialSetupCredential(
  id: string,
  credential: string
): Promise<AgentCredentialSetupSession> {
  return request<AgentCredentialSetupSession>(`${BASE_PATH}/${encodeURIComponent(id)}/credential`, {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
}
