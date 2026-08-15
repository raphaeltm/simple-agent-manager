/**
 * GitHub Trigger Filter Engine
 *
 * Pure deterministic functions for matching GitHub webhook events against
 * trigger filter configurations. No side effects, no DB access — just filtering.
 *
 * All filters are AND-combined: every configured filter must pass for the event to match.
 * Empty/undefined filter fields mean "match all" for that dimension.
 */
import type { GitHubTriggerFilters } from '@simple-agent-manager/shared';
import * as v from 'valibot';

/** Parsed GitHub webhook event payload (the fields we care about for filtering). */
export interface GitHubWebhookEvent {
  event: string; // X-GitHub-Event header value
  action?: string; // payload.action
  sender?: { login: string; type?: string };
  repository?: { full_name: string; default_branch?: string };
  issue?: {
    number: number;
    title: string;
    body?: string;
    labels?: Array<{ name: string }>;
    draft?: boolean;
  };
  pull_request?: {
    number: number;
    title: string;
    body?: string;
    labels?: Array<{ name: string }>;
    draft?: boolean;
    head?: { ref: string };
    base?: { ref: string };
  };
  comment?: { body?: string };
  ref?: string; // for push events: 'refs/heads/main'
  head_commit?: { id: string; message?: string };
}

export interface FilterResult {
  matched: boolean;
  reason?: string;
}

/**
 * Evaluate all configured filters against a webhook event.
 * Returns { matched: true } if the event passes ALL filters,
 * or { matched: false, reason: '...' } with the first failing filter.
 */
export function evaluateFilters(
  event: GitHubWebhookEvent,
  filters: GitHubTriggerFilters
): FilterResult {
  // Action filter
  if (filters.actions && filters.actions.length > 0) {
    if (!event.action || !filters.actions.includes(event.action)) {
      return {
        matched: false,
        reason: `action '${event.action ?? ''}' not in [${filters.actions.join(', ')}]`,
      };
    }
  }

  // Label filter — event must have ALL required labels
  if (filters.labels && filters.labels.length > 0) {
    const eventLabels = getEventLabels(event);
    const eventLabelSet = new Set(eventLabels.map((l) => l.toLowerCase()));
    for (const required of filters.labels) {
      if (!eventLabelSet.has(required.toLowerCase())) {
        return { matched: false, reason: `missing required label '${required}'` };
      }
    }
  }

  // Actor ignore filter
  if (filters.ignoreActors && filters.ignoreActors.length > 0) {
    const senderLogin = event.sender?.login;
    if (senderLogin) {
      const ignoredSet = new Set(filters.ignoreActors.map((a: string) => a.toLowerCase()));
      if (ignoredSet.has(senderLogin.toLowerCase())) {
        return { matched: false, reason: `actor '${senderLogin}' is in ignore list` };
      }
    }
  }

  // Command prefix filter (for issue_comment events)
  if (filters.commandPrefix) {
    const commentBody = event.comment?.body?.trim() ?? '';
    if (!commentBody.startsWith(filters.commandPrefix)) {
      return { matched: false, reason: `comment does not start with '${filters.commandPrefix}'` };
    }
  }

  // Body/title/comment contains filter (case-insensitive)
  if (filters.bodyContains) {
    const needle = filters.bodyContains.toLowerCase();
    const searchTexts = [
      event.issue?.title,
      event.issue?.body,
      event.pull_request?.title,
      event.pull_request?.body,
      event.comment?.body,
    ];
    const found = searchTexts.some((text) => text?.toLowerCase().includes(needle));
    if (!found) {
      return { matched: false, reason: `no title/body/comment contains '${filters.bodyContains}'` };
    }
  }

  // Branch filter (for push and PR events)
  if (filters.branches && filters.branches.length > 0) {
    const branch = getEventBranch(event);
    if (!branch) {
      return { matched: false, reason: 'no branch found in event' };
    }
    const branchSet = new Set(filters.branches.map((b: string) => b.toLowerCase()));
    if (!branchSet.has(branch.toLowerCase())) {
      return {
        matched: false,
        reason: `branch '${branch}' not in [${filters.branches.join(', ')}]`,
      };
    }
  }

  // Draft filter (for PR events, default: ignore drafts)
  if (event.event === 'pull_request' && (filters.ignoreDrafts ?? true)) {
    if (event.pull_request?.draft) {
      return { matched: false, reason: 'pull request is a draft' };
    }
  }

  return { matched: true };
}

/** Extract label names from an event (issues or PRs). */
function getEventLabels(event: GitHubWebhookEvent): string[] {
  const labels = event.issue?.labels ?? event.pull_request?.labels ?? [];
  return labels.map((l) => l.name);
}

/** Extract the relevant branch name from an event. */
function getEventBranch(event: GitHubWebhookEvent): string | undefined {
  if (event.event === 'push' && event.ref) {
    // Push refs look like 'refs/heads/main'
    return event.ref.replace(/^refs\/heads\//, '');
  }
  if (event.event === 'pull_request') {
    return event.pull_request?.head?.ref;
  }
  return undefined;
}

// =============================================================================
// parseWebhookPayload schema
// =============================================================================
//
// Field-level building blocks matching the defensive coercions the schema
// replaces: `String(x ?? '')` becomes "valid string, else fallback to ''";
// `typeof x === 'T' ? x : undefined` becomes "valid T, else fallback to
// undefined". `v.fallback` degrades independently per field (it does not
// reject the enclosing object), so one malformed nested value can never fail
// parsing of its siblings — matching the original per-field ternary coercions,
// which also never threw regardless of payload shape.
const RequiredStringSchema = v.fallback(v.string(), '');
const OptionalStringSchema = v.fallback(v.optional(v.string()), undefined);
const OptionalBooleanSchema = v.fallback(v.optional(v.boolean()), undefined);
const RequiredNumberSchema = v.fallback(v.number(), 0);

const GitHubWebhookLabelSchema = v.object({ name: RequiredStringSchema });
const LabelsFieldSchema = v.fallback(
  v.optional(v.array(v.fallback(GitHubWebhookLabelSchema, { name: '' }))),
  undefined
);

const GitHubWebhookRefSchema = v.object({ ref: RequiredStringSchema });
const RefFieldSchema = v.fallback(v.optional(GitHubWebhookRefSchema), undefined);

const GitHubWebhookSenderSchema = v.object({
  login: RequiredStringSchema,
  type: OptionalStringSchema,
});
const GitHubWebhookRepositorySchema = v.object({
  full_name: RequiredStringSchema,
  default_branch: OptionalStringSchema,
});
const GitHubWebhookIssueSchema = v.object({
  number: RequiredNumberSchema,
  title: RequiredStringSchema,
  body: OptionalStringSchema,
  labels: LabelsFieldSchema,
  draft: OptionalBooleanSchema,
});
const GitHubWebhookPullRequestSchema = v.object({
  number: RequiredNumberSchema,
  title: RequiredStringSchema,
  body: OptionalStringSchema,
  labels: LabelsFieldSchema,
  draft: OptionalBooleanSchema,
  head: RefFieldSchema,
  base: RefFieldSchema,
});
const GitHubWebhookCommentSchema = v.object({ body: OptionalStringSchema });
const GitHubWebhookHeadCommitSchema = v.object({
  id: RequiredStringSchema,
  message: OptionalStringSchema,
});

/**
 * Shape of the parts of a raw GitHub webhook JSON payload that
 * `parseWebhookPayload` consumes. Loose by design — only the fields the
 * filter engine reads are declared, unknown keys (e.g. `installation`) are
 * ignored, and every field falls back to a safe default rather than failing
 * the parse, so this can never throw regardless of payload shape.
 */
const GitHubWebhookPayloadSchema = v.object({
  action: OptionalStringSchema,
  sender: v.fallback(v.optional(GitHubWebhookSenderSchema), undefined),
  repository: v.fallback(v.optional(GitHubWebhookRepositorySchema), undefined),
  issue: v.fallback(v.optional(GitHubWebhookIssueSchema), undefined),
  pull_request: v.fallback(v.optional(GitHubWebhookPullRequestSchema), undefined),
  comment: v.fallback(v.optional(GitHubWebhookCommentSchema), undefined),
  ref: OptionalStringSchema,
  head_commit: v.fallback(v.optional(GitHubWebhookHeadCommitSchema), undefined),
});

/**
 * Parse a raw GitHub webhook payload into our normalized event shape.
 * This extracts only the fields we need for filtering.
 *
 * Never throws: `payload` may be an arbitrary webhook body, and every field
 * (including the top-level shape itself) degrades to a safe default via
 * `safeParse` rather than raising, matching the pre-existing defensive
 * behavior this replaces.
 */
export function parseWebhookPayload(
  eventType: string,
  payload: Record<string, unknown>
): GitHubWebhookEvent {
  const result = v.safeParse(GitHubWebhookPayloadSchema, payload);
  return { event: eventType, ...(result.success ? result.output : {}) };
}

// =============================================================================
// Stored GitHubTriggerFilters (github_trigger_configs.filters_json) parsing
// =============================================================================

/** Validated shape of a stored `filters_json` column value. Every field is
 * optional — an empty object is a valid, safe "match everything" default. */
const GitHubTriggerFiltersSchema = v.object({
  actions: v.optional(v.array(v.string())),
  labels: v.optional(v.array(v.string())),
  ignoreActors: v.optional(v.array(v.string())),
  commandPrefix: v.optional(v.string()),
  bodyContains: v.optional(v.string()),
  branches: v.optional(v.array(v.string())),
  ignoreDrafts: v.optional(v.boolean()),
});

export interface ParsedGitHubTriggerFilters {
  filters: GitHubTriggerFilters;
  /** False when `raw` was not valid JSON, or did not match the filters shape. */
  valid: boolean;
}

/**
 * Parse a stored `github_trigger_configs.filters_json` value.
 *
 * Never throws — malformed JSON or an unexpected shape returns
 * `{ filters: {}, valid: false }` (every filter field is optional, so `{}` is
 * itself a valid, safe "match everything" filter set). This function is pure
 * (no logging) so it stays consistent with the rest of this module; callers
 * decide whether an invalid row should be logged and whether it is safe to
 * proceed with the `{}` fallback (a display/read path) or must be treated as
 * untrusted and skipped (a path that would auto-fire a task).
 */
export function parseGitHubTriggerFiltersJson(raw: string): ParsedGitHubTriggerFilters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filters: {}, valid: false };
  }
  const result = v.safeParse(GitHubTriggerFiltersSchema, parsed);
  return result.success ? { filters: result.output, valid: true } : { filters: {}, valid: false };
}
