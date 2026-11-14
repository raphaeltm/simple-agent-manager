import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('actor-labels');

/**
 * How the unauthenticated first-run setup actor is named to people. `completeSetupWithConfig`
 * records the migration-seeded system user as the writer, so a value written by whoever held
 * the setup token reads as this, never as an ordinary admin.
 */
export const FIRST_RUN_SETUP_ACTOR_LABEL = 'first-run setup (unauthenticated)';

/**
 * Resolves user ids that wrote settings into readable labels ("Ada <ada@example.com>"), with one
 * D1 read for the whole set. Unknown ids keep the raw id so the label never hides who it was.
 * A failed read degrades to raw ids: these labels decorate admin views and alerts, never gate them.
 */
export async function resolveActorLabels(
  env: Env,
  userIds: Iterable<string | null | undefined>
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const lookup: string[] = [];
  for (const id of new Set(userIds)) {
    if (!id) continue;
    if (id === SYSTEM_USER_ID) labels.set(id, FIRST_RUN_SETUP_ACTOR_LABEL);
    else lookup.push(id);
  }
  if (lookup.length === 0) return labels;
  try {
    const rows = await env.DATABASE.prepare(
      `SELECT id, name, email FROM users WHERE id IN (${lookup.map(() => '?').join(',')})`
    )
      .bind(...lookup)
      .all<{ id: string; name: string | null; email: string | null }>();
    for (const row of rows.results ?? []) {
      const name = row.name?.trim();
      const email = row.email?.trim();
      labels.set(row.id, name && email ? `${name} <${email}>` : (email ?? name ?? row.id));
    }
  } catch (error) {
    log.warn('actor_labels.lookup_failed', {
      count: lookup.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const id of lookup) if (!labels.has(id)) labels.set(id, id);
  return labels;
}
