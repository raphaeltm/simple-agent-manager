import { drizzle } from 'drizzle-orm/d1';
import { and, eq, isNotNull } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { ensureDefaultCapacityPoolsForExistingCredentials } from './default-capacity-pools';

const MAX_PROJECT_SCOPES_PER_CREDENTIAL_MUTATION = 25;

export async function reconcileCapacityPoolsForCredentialMutation(
  env: Env,
  input:
    | { scope: 'user'; userId: string; projectIds?: string[] }
    | { scope: 'project'; userId: string; projectId: string }
    | { scope: 'installation' }
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  try {
    if (input.scope === 'installation') {
      await ensureDefaultCapacityPoolsForExistingCredentials(db, {
        includeInstallation: true,
        env,
      });
      return;
    }
    if (input.scope === 'project') {
      await ensureDefaultCapacityPoolsForExistingCredentials(db, {
        userId: input.userId,
        projectId: input.projectId,
        includeInstallation: false,
        env,
      });
      return;
    }
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      includeInstallation: false,
      env,
    });
    const projectIds = new Set([
      ...(input.projectIds ?? []),
      ...(await listUserComputeAttachmentProjectIds(db, input.userId)),
    ]);
    for (const projectId of projectIds) {
      await ensureDefaultCapacityPoolsForExistingCredentials(db, {
        userId: input.userId,
        projectId,
        includeInstallation: false,
        env,
      });
    }
  } catch (error) {
    log.warn('capacity_pools.credential_lifecycle_reconcile_failed', {
      scope: input.scope,
      ...serializeError(error),
    });
  }
}

async function listUserComputeAttachmentProjectIds(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ projectId: schema.ccAttachments.projectId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.userId, userId),
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNotNull(schema.ccAttachments.projectId)
      )
    )
    .limit(MAX_PROJECT_SCOPES_PER_CREDENTIAL_MUTATION);
  return [...new Set(rows.flatMap((row) => (row.projectId ? [row.projectId] : [])))];
}
