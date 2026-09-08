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
  body: string;
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
  if (!token || !repo) return null;

  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';

  try {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sam-pr-evidence-check',
      },
    });
    if (!response.ok) return null;

    const parsed = v.safeParse(apiPullRequestSchema, await response.json());
    if (!parsed.success) return null;

    return {
      body: parsed.output.body ?? '',
      labels: parsed.output.labels ?? [],
      ...(parsed.output.html_url ? { htmlUrl: parsed.output.html_url } : {}),
    };
  } catch {
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

  return { ...live, source: 'api' };
}
