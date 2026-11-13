import { BUILD_CONTEXT_PREFIX } from '../build-context-defaults';
import { PUBLISH_JOB_TERMINAL_STATUSES } from '../deployment-publish-jobs';
import type { AppDeploymentEnv as Env } from '../env';
import type { DeploymentSettingsPort } from '../ports';

const BUILD_CONTEXT_CLEANUP_CURSOR_KEY = 'cleanup:compose-build-contexts:cursor';
type Checkpoint = { cursor?: string; startAfter?: string };
function readCheckpoint(value: string | null): Checkpoint {
  if (!value) return {};
  // Existing installations stored the opaque R2 page cursor directly.
  if (!value.startsWith('{')) return { cursor: value };
  try {
    const parsed = JSON.parse(value) as Checkpoint | null;
    if (typeof parsed?.startAfter === 'string') return { startAfter: parsed.startAfter };
    if (typeof parsed?.cursor === 'string') return { cursor: parsed.cursor };
  } catch {
    // Legacy page cursors are opaque, including JSON-shaped strings.
  }
  return { cursor: value };
}
/** Invoked by the existing daily compose-artifact cron. A retained cursor bounds
 * list traffic without starving old bundles behind active/young objects. */
export async function runBuildContextCleanup(
  env: Env,
  settings: DeploymentSettingsPort,
  now: Date = new Date()
) {
  const retentionHours = Number(
    await settings.resolveSetting('deployments.buildContextRetentionHours')
  );
  const deadline =
    Date.now() + Number(await settings.resolveSetting('deployments.buildContextCleanupBudgetMs'));
  const terminal = [...PUBLISH_JOB_TERMINAL_STATUSES];
  const active = await env.DATABASE.prepare(
    `SELECT context_r2_key FROM deployment_publish_jobs WHERE executor = 'cloudflare' AND context_r2_key IS NOT NULL AND status NOT IN (${terminal.map(() => '?').join(',')})`
  )
    .bind(...terminal)
    .all<{ context_r2_key: string }>();
  const protectedKeys = new Set(active.results.map((row) => row.context_r2_key));
  let checkpoint = readCheckpoint(await env.KV.get(BUILD_CONTEXT_CLEANUP_CURSOR_KEY));
  let cursor = checkpoint.cursor;
  let startAfter = checkpoint.startAfter;
  const limit = Number(await settings.resolveSetting('deployments.buildContextCleanupPageSize'));
  let scanned = 0,
    deleted = 0,
    bytes = 0,
    errors = 0;
  try {
    do {
      const page = await env.R2.list({
        prefix: BUILD_CONTEXT_PREFIX,
        cursor,
        ...(startAfter ? { startAfter } : {}),
        limit,
      });
      for (const object of page.objects) {
        if (Date.now() >= deadline) return { scanned, deleted, bytes, errors };
        scanned++;
        if (
          !protectedKeys.has(object.key) &&
          object.uploaded.getTime() <= now.getTime() - retentionHours * 3600000
        ) {
          try {
            await env.R2.delete(object.key);
            deleted++;
            bytes += object.size;
          } catch {
            // One failed object must not starve later objects or pages. The next
            // full sweep retries it; scheduled totals expose the partial failure.
            errors++;
          }
        }
        // Even a failed delete advances this sweep. On interruption R2 resumes
        // after this key, so slow failures cannot pin the front of a page.
        // Failed objects remain in R2 and are retried on the next full sweep.
        checkpoint = { startAfter: object.key };
      }
      cursor = page.truncated ? page.cursor : undefined;
      startAfter = undefined;
      checkpoint = cursor ? { cursor } : {};
    } while (cursor && Date.now() < deadline);
  } finally {
    // KV permits only one write per second to a key. Checkpoint once, including
    // when a later list fails or the budget expires partway through a page.
    if (checkpoint.cursor || checkpoint.startAfter)
      await env.KV.put(BUILD_CONTEXT_CLEANUP_CURSOR_KEY, JSON.stringify(checkpoint));
    else await env.KV.delete(BUILD_CONTEXT_CLEANUP_CURSOR_KEY);
  }
  return { scanned, deleted, bytes, errors };
}
