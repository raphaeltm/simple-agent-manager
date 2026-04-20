/**
 * Trial onboarding — shared types and validation schemas.
 *
 * Consumed by:
 *   - apps/api/src/routes/trial/*      (server-side validation + response types)
 *   - apps/web/src/pages/Try*.tsx      (client-side request/response shape)
 *   - apps/api/src/services/trial/*    (cookie + kill-switch helpers)
 */
import * as v from 'valibot';

// ---------------------------------------------------------------------------
// Constants (cookie names, sentinel user id, versions)
// ---------------------------------------------------------------------------

/** Name of the signed anonymous-fingerprint cookie (7d). */
export const TRIAL_COOKIE_FINGERPRINT_NAME = 'sam_trial_fingerprint';

/** Name of the signed claim-token cookie (48h). */
export const TRIAL_COOKIE_CLAIM_NAME = 'sam_trial_claim';

/**
 * Sentinel user id that owns anonymous trial projects until claim.
 * Seeded into `users` by migration 0043 with email
 * `anonymous-trials@simple-agent-manager.internal`.
 */
export const TRIAL_ANONYMOUS_USER_ID = 'system_anonymous_trials';

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type TrialErrorCode =
  | 'invalid_url'
  | 'repo_not_found'
  | 'repo_private'
  | 'repo_too_large'
  | 'trials_disabled'
  | 'cap_exceeded'
  | 'existing_trial';

// ---------------------------------------------------------------------------
// Valibot schemas
// ---------------------------------------------------------------------------

/**
 * GitHub public-repo URL pattern:
 *   https://github.com/<owner>/<repo>
 * - Owner: 1–39 chars, alphanumeric + hyphen, cannot start/end with hyphen
 * - Repo: 1–100 chars, alphanumeric + '-', '_', '.'
 * - Optional trailing slash, `.git` suffix, or `/tree/...` segment is stripped upstream.
 */
const GITHUB_REPO_URL_REGEX =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}(?:\.git)?\/?$/;

export const TrialCreateRequestSchema = v.object({
  repoUrl: v.pipe(
    v.string(),
    v.trim(),
    v.regex(GITHUB_REPO_URL_REGEX, 'Must be a public GitHub repository URL'),
  ),
});

export const TrialWaitlistRequestSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email()),
});

// ---------------------------------------------------------------------------
// Request/response types
// ---------------------------------------------------------------------------

export type TrialCreateRequest = v.InferOutput<typeof TrialCreateRequestSchema>;

export interface TrialCreateResponse {
  trialId: string;
  projectId: string;
  eventsUrl: string;
  expiresAt: number; // epoch ms
}

export interface TrialCreateError {
  error: TrialErrorCode;
  message: string;
  /** Populated when error === 'cap_exceeded' (YYYY-MM-01 ISO date). */
  waitlistResetsAt?: string;
}

export interface TrialStatusResponse {
  enabled: boolean;
  /** Remaining slots in the current monthly window (0 when cap hit). */
  remaining: number;
  /** ISO date of next cap reset (first of next month, UTC). */
  resetsAt: string;
}

export type TrialWaitlistRequest = v.InferOutput<typeof TrialWaitlistRequestSchema>;

export interface TrialWaitlistResponse {
  queued: boolean;
  resetsAt: string;
}

export interface TrialClaimResponse {
  projectId: string;
  claimedAt: number;
}

// ---------------------------------------------------------------------------
// SSE event stream (discriminated union)
// ---------------------------------------------------------------------------

export interface TrialStartedEvent {
  type: 'trial.started';
  trialId: string;
  projectId: string;
  repoUrl: string;
  startedAt: number;
}

export interface TrialProgressEvent {
  type: 'trial.progress';
  /** Short human-facing status ("Cloning repo…", "Analyzing structure…"). */
  stage: string;
  /** 0..1 progress hint. Undefined when the stage has no numeric progress. */
  progress?: number;
  at: number;
}

export interface TrialKnowledgeEvent {
  type: 'trial.knowledge';
  entity: string;
  observation: string;
  at: number;
}

export interface TrialIdeaEvent {
  type: 'trial.idea';
  ideaId: string;
  title: string;
  summary: string;
  at: number;
}

export interface TrialReadyEvent {
  type: 'trial.ready';
  trialId: string;
  projectId: string;
  workspaceUrl: string;
  at: number;
}

/** Agent activity — tool calls, assistant text, or thinking snippets. */
export interface TrialAgentActivityEvent {
  type: 'trial.agent_activity';
  /** Which kind of agent output this represents. */
  role: 'assistant' | 'tool' | 'thinking';
  /** Short displayable text — truncated for SSE efficiency. */
  text: string;
  /** MCP tool name when role === 'tool'. */
  toolName?: string;
  at: number;
}

export interface TrialErrorEvent {
  type: 'trial.error';
  error: TrialErrorCode;
  message: string;
  at: number;
}

export type TrialEvent =
  | TrialStartedEvent
  | TrialProgressEvent
  | TrialKnowledgeEvent
  | TrialIdeaEvent
  | TrialReadyEvent
  | TrialAgentActivityEvent
  | TrialErrorEvent;

// ---------------------------------------------------------------------------
// UI-facing idea shape (derived from TrialIdeaEvent)
// ---------------------------------------------------------------------------

/**
 * A discovery-phase idea surfaced to the trial visitor as a suggestion chip.
 * Built by the `/try/:trialId` page from `trial.idea` SSE events.
 *
 * The `prompt` is the text pre-filled into the chat textarea when the chip is
 * clicked — typically the same as `summary`, but callers may override (e.g.
 * to prepend template scaffolding or merge idea metadata).
 */
export interface TrialIdea {
  id: string;
  title: string;
  summary: string;
  /** Text inserted into the chat textarea when this chip is clicked. */
  prompt: string;
}
