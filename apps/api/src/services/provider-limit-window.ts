import * as v from 'valibot';

import type { Env } from '../env';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import { parseProviderLimitWait, PROVIDER_LIMIT_POLICY } from './provider-limit-policy';

const WindowSchema = v.object({
  status: v.string(),
  resets_at: v.nullable(v.number()),
  observed_at: v.number(),
  window_type: v.string(),
});
export interface RejectedProviderWindow {
  credentialKey: string;
  resetsAt: number | null;
  observedAt: number;
}
/** The newest observation per credential/window wins across projects. Keys are
 * resolved internally from authorized selection/session attribution, never user input. */
export async function rejectedProviderWindow(
  env: Env,
  reference: string | null,
  now = Date.now()
): Promise<RejectedProviderWindow | null> {
  const key = reference ? await credentialLimitReferenceKey(reference) : null;
  if (!key) return null;
  const rows = await env.DATABASE.prepare(
    `SELECT status, resets_at, observed_at, window_type FROM (
        SELECT status, resets_at, observed_at, window_type,
          ROW_NUMBER() OVER (PARTITION BY window_type ORDER BY observed_at DESC, updated_at DESC, project_id) AS newest
        FROM credential_limit_windows WHERE credential_reference = ? AND observed_at <= ?
      ) WHERE newest = 1 ORDER BY observed_at DESC LIMIT ?`
  )
    .bind(key, now, PROVIDER_LIMIT_POLICY.maxWindows)
    .all();
  // Task wait is the durable rejection intent. It closes a crash/capacity gap
  // before the observation producer commits its credential-wide window.
  const intents = await env.DATABASE.prepare(
    `SELECT provider_limit_wait_json FROM (
    SELECT provider_limit_wait_json,
      json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.origin') AS origin,
      json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.phase') AS phase,
      json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.observedAt') AS observed_at,
      json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.resetsAt') AS resets_at
    FROM tasks
    WHERE json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END, '$.credentialKey') = ?
      AND status IN ('queued','delegated','in_progress','sleeping')
      AND admission_state IN ('provider_limit_waiting','provider_limit_blocked')
      AND json_valid(provider_limit_wait_json)
    ) WHERE origin = 'callback' AND phase IN ('waiting','blocked')
      AND observed_at <= ?
      AND (resets_at > ? OR (resets_at IS NULL AND observed_at >= ?))
    ORDER BY observed_at DESC LIMIT ?`
  )
    .bind(
      key,
      now,
      now,
      now - PROVIDER_LIMIT_POLICY.recentRejectionMs,
      PROVIDER_LIMIT_POLICY.maxWindows
    )
    .all<{ provider_limit_wait_json: string }>();
  const generic = rows.results.find((raw) => raw.window_type === 'provider.prompt_rejection');
  const seen = new Set<string>();
  let reset: number | null = null;
  let observedAt = 0;
  let rejected = false;
  for (const raw of rows.results) {
    const parsed = v.safeParse(WindowSchema, raw);
    if (!parsed.success) continue;
    const row = parsed.output;
    if (seen.has(row.window_type)) continue;
    seen.add(row.window_type);
    if (row.status !== 'rejected' || row.observed_at > now) continue;
    // Known windows stop rejecting at reset. Unknown observations have a short
    // freshness bound; no stale rejected row can hold admission indefinitely.
    if (
      row.resets_at != null
        ? row.resets_at <= now
        : now - row.observed_at > PROVIDER_LIMIT_POLICY.recentRejectionMs
    )
      continue;
    rejected = true;
    observedAt = Math.max(observedAt, row.observed_at);
    if (row.resets_at != null) reset = Math.max(reset ?? 0, row.resets_at);
  }
  for (const intent of intents.results) {
    const wait = parseProviderLimitWait(intent.provider_limit_wait_json);
    if (
      !wait ||
      wait.origin !== 'callback' ||
      wait.phase === 'released' ||
      wait.observedAt > now ||
      (wait.resetsAt !== null
        ? wait.resetsAt <= now
        : now - wait.observedAt > PROVIDER_LIMIT_POLICY.recentRejectionMs)
    )
      continue;
    // A newer generic observation (including success) owns this intent's result.
    if (
      generic &&
      typeof generic.observed_at === 'number' &&
      generic.observed_at >= wait.observedAt
    )
      continue;
    rejected = true;
    observedAt = Math.max(observedAt, wait.observedAt);
    if (wait.resetsAt !== null) reset = Math.max(reset ?? 0, wait.resetsAt);
  }
  return rejected ? { credentialKey: key, resetsAt: reset, observedAt } : null;
}
