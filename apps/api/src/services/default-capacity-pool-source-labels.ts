/**
 * Display names for the accounts behind a pool's capacity sources, so the editor can say
 * "Hetzner · Personal" instead of "Hetzner · Infrastructure settings (2)".
 *
 * Read-only and display-only: called for editor responses, never on placement reads. Ids come
 * from source rows already scoped to the pool's owner, so a name cannot cross tenants.
 */
import { inArray } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import type { CapacityPoolSummary } from './default-capacity-pool-types';

type Db = ReturnType<typeof drizzle>;

const COMPOSABLE_CREDENTIAL_PREFIX = 'cc_credentials:';

/** Fills `label` on every source that has a named connection or platform credential. */
export async function attachCapacitySourceLabels(
  db: Db,
  summaries: ReadonlyArray<CapacityPoolSummary | null>
): Promise<void> {
  const sources = summaries.flatMap((summary) => summary?.sources ?? []);
  const composableIds = new Set<string>();
  const platformIds = new Set<string>();
  for (const source of sources) {
    const ref = source.credentialReference;
    if (ref?.startsWith(COMPOSABLE_CREDENTIAL_PREFIX)) {
      composableIds.add(ref.slice(COMPOSABLE_CREDENTIAL_PREFIX.length));
    } else if (source.platformCredentialId) {
      platformIds.add(source.platformCredentialId);
    }
  }

  const [composableNames, platformNames] = await Promise.all([
    readNames([...composableIds], async (ids) =>
      db
        .select({ id: schema.ccCredentials.id, name: schema.ccCredentials.name })
        .from(schema.ccCredentials)
        .where(inArray(schema.ccCredentials.id, ids))
    ),
    readNames([...platformIds], async (ids) =>
      db
        .select({ id: schema.platformCredentials.id, name: schema.platformCredentials.label })
        .from(schema.platformCredentials)
        .where(inArray(schema.platformCredentials.id, ids))
    ),
  ]);

  for (const source of sources) {
    const ref = source.credentialReference;
    const name = ref?.startsWith(COMPOSABLE_CREDENTIAL_PREFIX)
      ? composableNames.get(ref.slice(COMPOSABLE_CREDENTIAL_PREFIX.length))
      : source.platformCredentialId
        ? platformNames.get(source.platformCredentialId)
        : undefined;
    source.label = name?.trim() ? name.trim() : null;
  }
}

async function readNames(
  ids: string[],
  query: (ids: string[]) => Promise<Array<{ id: string; name: string }>>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += D1_MAX_BOUND_PARAMETERS) {
    for (const row of await query(ids.slice(offset, offset + D1_MAX_BOUND_PARAMETERS))) {
      names.set(row.id, row.name);
    }
  }
  return names;
}
