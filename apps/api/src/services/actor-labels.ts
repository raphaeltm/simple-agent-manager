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
      labels.set(row.id, formatPersonLabel(row.name, row.email, row.id));
    }
  } catch (error) {
    log.warn('actor_labels.lookup_failed', {
      count: lookup.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const id of lookup) if (!labels.has(id)) labels.set(id, sanitizeLabel(id));
  return labels;
}

/** Longest user-supplied text placed in a label (names and emails come from identity providers). */
const MAX_LABEL_LENGTH = 200;

/**
 * Makes user-controlled text safe to place on one line of a plain-text email or an admin label:
 * control characters (including CR/LF) become spaces, so a crafted display name cannot forge extra
 * lines in a security alert, and the result is length-capped.
 */
export function sanitizeLabel(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const single = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return single.length > MAX_LABEL_LENGTH ? `${single.slice(0, MAX_LABEL_LENGTH)}…` : single;
}

/** "Name <email>", or whichever part exists, else the id. Every part is sanitized. */
export function formatPersonLabel(
  name: string | null | undefined,
  email: string | null | undefined,
  fallbackId: string
): string {
  const cleanName = name ? sanitizeLabel(name) : '';
  const cleanEmail = email ? sanitizeLabel(email) : '';
  if (cleanName && cleanEmail) return `${cleanName} <${cleanEmail}>`;
  return cleanEmail || cleanName || sanitizeLabel(fallbackId);
}
