/**
 * Fast-path GitHub knowledge probe.
 *
 * Before the discovery agent even boots, we hit a handful of unauthenticated
 * GitHub REST endpoints to surface quick wins (description, languages, topics,
 * stars, README first paragraph) as `trial.knowledge` events. These arrive on
 * the SSE stream within ~3s of POST /api/trial/create returning, giving the
 * user immediate feedback while the VM provisions in the background.
 *
 * Design notes:
 *   - Fire-and-forget: every call is wrapped in try/catch; errors never bubble.
 *   - Per-request timeout via AbortController; total events capped via env.
 *   - No auth header: the ~60 req/hour unauthenticated rate limit is acceptable
 *     for trial onboarding (one probe per trial, five GH calls per probe).
 *   - All knobs are env-configurable (Constitution Principle XI).
 */
import {
  DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS,
  DEFAULT_TRIAL_KNOWLEDGE_MAX_EVENTS,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { emitTrialEvent } from './trial-runner';

function resolveTimeoutMs(env: Env): number {
  const raw = env.TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS;
  if (!raw) return DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS;
}

function resolveMaxEvents(env: Env): number {
  const raw = env.TRIAL_KNOWLEDGE_MAX_EVENTS;
  if (!raw) return DEFAULT_TRIAL_KNOWLEDGE_MAX_EVENTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRIAL_KNOWLEDGE_MAX_EVENTS;
}

/** Standard headers for unauthenticated GitHub REST calls from the Worker. */
const GH_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'user-agent': 'sam-trial-onboarding',
};

async function fetchJson(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch
): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { headers: GH_HEADERS, signal: ac.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      headers: { ...GH_HEADERS, accept: 'application/vnd.github.raw' },
      signal: ac.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe GitHub for quick-win observations and emit them as `trial.knowledge`
 * events. Completes within ~timeoutMs × N-calls (worst case) even if the
 * endpoints hang, because every request is AbortController-bounded.
 *
 * Errors never bubble — callers should kick this off via `waitUntil` and
 * return their response immediately.
 */
export async function emitGithubKnowledgeEvents(
  env: Env,
  trialId: string,
  repo: { owner: string; name: string },
  opts: { fetchFn?: typeof fetch } = {}
): Promise<void> {
  const timeoutMs = resolveTimeoutMs(env);
  const maxEvents = resolveMaxEvents(env);
  const fetchFn = opts.fetchFn ?? fetch;
  let emitted = 0;

  const emit = async (entity: string, observation: string): Promise<void> => {
    if (emitted >= maxEvents) return;
    emitted++;
    try {
      await emitTrialEvent(env, trialId, {
        type: 'trial.knowledge',
        entity,
        observation,
        at: Date.now(),
      });
    } catch (err) {
      log.warn('trial.github_knowledge.emit_failed', {
        trialId,
        entity,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    // Run the three independent probes in parallel. Each is independently
    // bounded by timeoutMs — a hanging readme fetch won't block repo metadata.
    const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
    const [repoMeta, languages, readme] = await Promise.all([
      fetchJson(base, timeoutMs, fetchFn) as Promise<
        | {
            description?: string | null;
            language?: string | null;
            stargazers_count?: number;
            topics?: string[];
            license?: { spdx_id?: string | null } | null;
            default_branch?: string;
          }
        | null
      >,
      fetchJson(`${base}/languages`, timeoutMs, fetchFn) as Promise<
        Record<string, number> | null
      >,
      fetchText(`${base}/readme`, timeoutMs, fetchFn),
    ]);

    if (repoMeta) {
      if (typeof repoMeta.description === 'string' && repoMeta.description.trim()) {
        await emit('repository', `Description: ${repoMeta.description.trim()}`);
      }
      if (typeof repoMeta.language === 'string' && repoMeta.language) {
        await emit('repository', `Primary language: ${repoMeta.language}`);
      }
      if (
        typeof repoMeta.stargazers_count === 'number' &&
        repoMeta.stargazers_count > 0
      ) {
        await emit('repository', `Stars: ${repoMeta.stargazers_count}`);
      }
      if (Array.isArray(repoMeta.topics) && repoMeta.topics.length > 0) {
        await emit('repository', `Topics: ${repoMeta.topics.slice(0, 8).join(', ')}`);
      }
      if (repoMeta.license && typeof repoMeta.license.spdx_id === 'string') {
        await emit('repository', `License: ${repoMeta.license.spdx_id}`);
      }
    }

    if (languages && typeof languages === 'object') {
      const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
      if (entries.length > 0) {
        const top = entries
          .slice(0, 5)
          .map(([lang]) => lang)
          .join(', ');
        await emit('repository', `Languages (by bytes): ${top}`);
      }
    }

    if (readme && readme.length > 0) {
      // First non-empty paragraph, stripped of markdown heading markers.
      const paragraphs = readme
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const firstParagraph = paragraphs.find(
        (p) => !/^#{1,6}\s/.test(p) && !/^!\[/.test(p) && p.length > 20
      );
      if (firstParagraph) {
        const snippet =
          firstParagraph.length > 280
            ? `${firstParagraph.slice(0, 280)}…`
            : firstParagraph;
        await emit('repository', `README: ${snippet}`);
      }
    }
  } catch (err) {
    // Belt-and-suspenders — individual probes already swallow, but any
    // unforeseen throw in the aggregation layer must not escape.
    log.warn('trial.github_knowledge.unexpected_error', {
      trialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
