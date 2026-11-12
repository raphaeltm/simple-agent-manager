/**
 * Agent-requested runtime secrets. An agent asks for a named secret with `request_secret`; a
 * human with `secret:write` on the project types the value into a card in the conversation, and
 * the API stores it encrypted as a project runtime secret. The value never reaches the agent's
 * context, the chat transcript or these records: the agent uses it through `exec_with_secrets`.
 */

export const RUNTIME_SECRET_REQUEST_STATUSES = [
  'pending',
  'fulfilled',
  'declined',
  'expired',
] as const;
export type RuntimeSecretRequestStatus = (typeof RUNTIME_SECRET_REQUEST_STATUSES)[number];

/** The tool an agent calls; the chat renders its result as the request card. */
export const REQUEST_SECRET_TOOL = 'request_secret';

/**
 * Longest reason an agent may give, in characters. A fixed input bound shared by the tool schema,
 * the API and the card, like the other agent-text bounds in this package, not a deployment policy.
 */
export const RUNTIME_SECRET_REQUEST_REASON_MAX_LENGTH = 1_000;

/** Metadata about one request. Never carries the secret value. */
export interface RuntimeSecretRequest {
  id: string;
  projectId: string;
  /** Environment variable name the value is stored under. */
  envKey: string;
  /** Why the agent says it needs the value (agent-written, untrusted text). */
  reason: string;
  /** Requested lifetime of the stored value in seconds; null = no expiry. */
  ttlSeconds: number | null;
  /** Effective status: a pending request past `expiresAt` reads as `expired`. */
  status: RuntimeSecretRequestStatus;
  requestingTaskId: string;
  requestingChatSessionId: string;
  /** When a pending request stops accepting a value (ISO). */
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  /** Display name of the person who supplied or declined it. */
  resolvedByName: string | null;
  /** When the stored value expires (ISO), set once supplied with a TTL. */
  secretExpiresAt: string | null;
  /** True when the supplied value replaced an existing project variable. */
  replacedExisting: boolean;
}

/** An existing project variable with the requested name, shown so a replace is deliberate. */
export interface RuntimeSecretRequestExistingValue {
  isSecret: boolean;
  /** True when the current value came from an earlier request. */
  collected: boolean;
  /** ISO expiry of the current value, or null. */
  expiresAt: string | null;
  expired: boolean;
  updatedAt: string;
  /**
   * Opaque identity of this exact stored value (write time plus the value's random IV), echoed
   * back as `expectedExistingVersion` so a replace confirms this value and no later one.
   */
  version: string;
}

export interface RuntimeSecretRequestResponse {
  request: RuntimeSecretRequest;
  existing: RuntimeSecretRequestExistingValue | null;
  /** True when this user may supply or decline the request now. */
  canResolve: boolean;
}

export interface FulfillRuntimeSecretRequestBody {
  value: string;
  /** Required when a project variable with this name already exists. */
  replaceExisting?: boolean;
  /**
   * `version` of the existing value the person confirmed replacing. If the value has changed
   * since, the save is refused and the card asks again.
   */
  expectedExistingVersion?: string;
}

export interface RuntimeSecretRequestResolution {
  request: RuntimeSecretRequest;
  /** Whether the requesting agent's wake prompt was queued. */
  agentNotified: boolean;
}

/** Where a managed runtime value was defined. Later scopes override earlier ones. */
export const RUNTIME_ENV_SCOPES = ['project', 'profile', 'skill'] as const;
export type RuntimeEnvScope = (typeof RUNTIME_ENV_SCOPES)[number];

/** Provenance of a value collected through a request. */
export interface RuntimeEnvCollectedProvenance {
  requestId: string;
  reason: string;
  requestingTaskId: string;
  requestingChatSessionId: string;
  suppliedByName: string | null;
  suppliedAt: string | null;
}

/**
 * One effective runtime env name for an agent session, as `list_runtime_env` reports it. Values
 * are never included; secrets are used through `exec_with_secrets`.
 */
export interface EffectiveRuntimeEnvEntry {
  name: string;
  scope: RuntimeEnvScope;
  isSecret: boolean;
  /** Lower-precedence scopes that define the same name and are hidden by this one. */
  overrides: RuntimeEnvScope[];
  expiresAt: string | null;
  collected: RuntimeEnvCollectedProvenance | null;
}

/** Project runtime env provenance shown in project settings. */
export interface ProjectRuntimeEnvVarProvenance {
  expiresAt: string | null;
  expired: boolean;
  collected: RuntimeEnvCollectedProvenance | null;
}
