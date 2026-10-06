/**
 * Resolves the PR body and labels that the evidence checks validate.
 *
 * Why this exists: both evidence checks used to read `GITHUB_EVENT_PATH` only.
 * That file is the event payload captured when the run was TRIGGERED, so it is a
 * snapshot, not current state. Two consequences bit us repeatedly:
 *
 *   1. Editing a PR body to add missing evidence changed nothing, because
 *      `.github/workflows/ci.yml` declares `pull_request:` with no `types:` and
 *      therefore defaults to [opened, synchronize, reopened] — `edited` and
 *      `labeled` never fire it.
 *   2. `gh run rerun`, the obvious operator response to a failed evidence check,
 *      replays the SAME stale payload and fails identically on a body that was
 *      already fixed.
 *
 * The result was that fixing evidence required pushing a throwaway empty commit.
 *
 * Adding `types: [... edited, labeled ...]` to ci.yml would be worse: the CI
 * concurrency group is `ci-${{ github.ref }}` with
 * `cancel-in-progress: github.event_name == 'pull_request'`, so applying the
 * routine `coderabbit-review` label would cancel and restart the whole in-flight
 * suite. So the fix belongs here, at the source of truth, not in the trigger.
 *
 * Live state is also the semantically correct input: these gates assert "does this
 * PR carry its evidence now", and body/labels are mutable PR metadata rather than
 * properties of a commit.
 *
 * Fetching is best-effort. A transient API failure falls back to the event payload,
 * which is exactly the previous behaviour — so this is strictly an improvement and
 * can never make the check less available than it was.
 */
import { readFileSync } from 'node:fs';

import * as v from 'valibot';

/**
 * Bound the live-state fetch. Without this a GitHub API hang would stall the
 * merge gate for the job's full `timeout-minutes: 15`, which would make the
 * check LESS available than the local-disk read it replaces.
 */
const DEFAULT_PR_EVIDENCE_API_TIMEOUT_MS = 10_000;

const eventPayloadSchema = v.object({
  pull_request: v.object({
    number: v.optional(v.number()),
    body: v.optional(v.nullable(v.string())),
    html_url: v.optional(v.string()),
    labels: v.optional(v.array(v.object({ name: v.string() }))),
  }),
});

const apiPullRequestSchema = v.object({
  body: v.optional(v.nullable(v.string())),
  html_url: v.optional(v.string()),
  labels: v.optional(v.array(v.object({ name: v.string() }))),
});

export interface PullRequestEvidenceState {
  /** Current body from the API when available; the frozen payload otherwise. */
  body: string;
  /**
   * UNION of the frozen payload's labels and the live labels.
   *
   * Body and labels are deliberately asymmetric. The body is EVIDENCE, so the
   * current value is the right input — that is this module's whole purpose.
   * A blocking label is a STOP SIGNAL, and a stop signal must not be clearable
   * during the run it is meant to stop.
   *
   * Live-only labels would open a TOCTOU window the frozen payload structurally
   * could not: the fetch runs after checkout + `pnpm install`, so someone could
   * push a commit carrying `needs-human-review`, wait for the run to start,
   * remove the label during the install window, and collect a green check
   * attributed to a commit that never passed. Taking the union keeps the
   * legitimate flow intact (remove the label, push — the next run sees it in
   * neither source) while closing the race.
   */
  labels: Array<{ name: string }>;
  htmlUrl?: string;
  /** Which source supplied the values, for diagnostics. */
  source: 'api' | 'event-payload';
}

export interface ResolveOptions {
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to reading GITHUB_EVENT_PATH. */
  readEventPayload?: () => string;
  env?: NodeJS.ProcessEnv;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * A silent fallback is indistinguishable from "we are not configured for live
 * state" (see the CI token wiring). Always say why.
 */
function warnFallback(reason: string): void {
  console.warn(`Falling back to the event payload for PR evidence: ${reason}`);
}

/** Union by name, preserving first-seen order. See PullRequestEvidenceState.labels. */
function unionLabels(
  frozen: Array<{ name: string }>,
  live: Array<{ name: string }>
): Array<{ name: string }> {
  const seen = new Set<string>();
  const merged: Array<{ name: string }> = [];
  for (const label of [...frozen, ...live]) {
    if (seen.has(label.name)) continue;
    seen.add(label.name);
    merged.push(label);
  }
  return merged;
}

function readPayloadFromDisk(env: NodeJS.ProcessEnv): string {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is missing.');
  }
  return readFileSync(eventPath, 'utf8');
}

/**
 * Fetch the PR's current body/labels. Returns null on ANY failure so the caller
 * degrades to the event payload rather than blocking the PR on an API hiccup.
 */
async function fetchLiveState(
  prNumber: number,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<Omit<PullRequestEvidenceState, 'source'> | null> {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    warnFallback(
      `missing ${!token ? 'GITHUB_TOKEN' : 'GITHUB_REPOSITORY'} — the CI job must set it (see ci.yml)`
    );
    return null;
  }

  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const timeoutMs = parsePositiveInt(
    env.PR_EVIDENCE_API_TIMEOUT_MS,
    DEFAULT_PR_EVIDENCE_API_TIMEOUT_MS
  );

  try {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sam-pr-evidence-check',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      warnFallback(`GitHub API returned HTTP ${response.status}`);
      return null;
    }

    // `.json()` can throw on a non-JSON 200 (proxy/interstitial HTML); it is
    // inside this try deliberately.
    const parsed = v.safeParse(apiPullRequestSchema, await response.json());
    if (!parsed.success) {
      warnFallback('GitHub API response did not match the expected shape');
      return null;
    }

    return {
      body: parsed.output.body ?? '',
      labels: parsed.output.labels ?? [],
      ...(parsed.output.html_url ? { htmlUrl: parsed.output.html_url } : {}),
    };
  } catch (error) {
    warnFallback(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Resolve the PR state to validate: current state from the API when reachable,
 * otherwise the triggering event payload.
 */
export async function resolvePullRequestEvidenceState(
  options: ResolveOptions = {}
): Promise<PullRequestEvidenceState> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const read = options.readEventPayload ?? (() => readPayloadFromDisk(env));

  const raw: unknown = JSON.parse(read());
  const parsed = v.safeParse(eventPayloadSchema, raw);
  if (!parsed.success) {
    throw new Error(
      'GitHub event payload must include pull_request with a string body/html_url when present.'
    );
  }

  const pullRequest = parsed.output.pull_request;
  const fallback: PullRequestEvidenceState = {
    body: pullRequest.body ?? '',
    labels: pullRequest.labels ?? [],
    ...(pullRequest.html_url ? { htmlUrl: pullRequest.html_url } : {}),
    source: 'event-payload',
  };

  if (pullRequest.number === undefined) return fallback;

  const live = await fetchLiveState(pullRequest.number, env, fetchImpl);
  if (!live) return fallback;

  return { ...live, labels: unionLabels(fallback.labels, live.labels), source: 'api' };
}
