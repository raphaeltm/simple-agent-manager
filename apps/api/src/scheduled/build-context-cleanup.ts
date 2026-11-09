import type { Env } from '../env';
import { resolveAdminSetting } from '../services/admin-settings';
import { BUILD_CONTEXT_PREFIX } from '../services/build-context-defaults';
import { PUBLISH_JOB_TERMINAL_STATUSES } from '../services/deployment-publish-jobs';

const BUILD_CONTEXT_CLEANUP_CURSOR_KEY = 'cleanup:compose-build-contexts:cursor';
/** Invoked by the existing daily compose-artifact cron. A retained cursor bounds
 * list traffic without starving old bundles behind active/young objects. */
export async function runBuildContextCleanup(env: Env, now: Date = new Date()) {
  const retentionHours = Number(
    await resolveAdminSetting(env, 'deployments.buildContextRetentionHours')
  );
  const deadline =
    Date.now() + Number(await resolveAdminSetting(env, 'deployments.buildContextCleanupBudgetMs'));
  const terminal = [...PUBLISH_JOB_TERMINAL_STATUSES];
  const active = await env.DATABASE.prepare(
    `SELECT context_r2_key FROM deployment_publish_jobs WHERE executor = 'cloudflare' AND context_r2_key IS NOT NULL AND status NOT IN (${terminal.map(() => '?').join(',')})`
  )
    .bind(...terminal)
    .all<{ context_r2_key: string }>();
  const protectedKeys = new Set(active.results.map((row) => row.context_r2_key));
  let cursor = (await env.KV.get(BUILD_CONTEXT_CLEANUP_CURSOR_KEY)) ?? undefined;
  let scanned = 0,
    deleted = 0,
    bytes = 0;
  do {
    const page = await env.R2.list({
      prefix: BUILD_CONTEXT_PREFIX,
      cursor,
      limit: Number(await resolveAdminSetting(env, 'deployments.buildContextCleanupPageSize')),
    });
    for (const object of page.objects) {
      // Keep the current page cursor on budget exhaustion. Re-listing that
      // page next time is safe: deleted objects vanish, retained ones stay.
      if (Date.now() >= deadline) return { scanned, deleted, bytes };
      scanned++;
      if (
        !protectedKeys.has(object.key) &&
        object.uploaded.getTime() <= now.getTime() - retentionHours * 3600000
      ) {
        await env.R2.delete(object.key);
        deleted++;
        bytes += object.size;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor) await env.KV.put(BUILD_CONTEXT_CLEANUP_CURSOR_KEY, cursor);
    else await env.KV.delete(BUILD_CONTEXT_CLEANUP_CURSOR_KEY);
  } while (cursor && Date.now() < deadline);
  return { scanned, deleted, bytes };
}
