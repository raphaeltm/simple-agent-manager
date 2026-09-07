/**
 * Lazy backfill — auto-populates cc_* tables on first resolution when a user
 * has legacy credentials but no cc_* data yet.
 *
 * This ensures upgrading SAM "just works" without requiring manual migration.
 */

import type { CredentialProvider } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import { ccAttachments, ccConfigurations, ccCredentials, credentials } from '../../db/schema';
import { runBackfill } from './backfill-service';

/**
 * Check whether a user already has any cc_credentials rows.
 * A single COUNT query — cheap enough to call on every resolution.
 */
export async function hasUserCCData(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ccCredentials.id })
    .from(ccCredentials)
    .where(eq(ccCredentials.ownerId, userId))
    .limit(1);
  return row !== undefined;
}

/**
 * If the user has no cc_* data, run the backfill from legacy tables.
 * Returns true if backfill was performed, false if data already existed.
 *
 * TOCTOU note: concurrent requests for the same user can both see an empty cc
 * table and both invoke runBackfill. This is safe because runBackfill uses
 * onConflictDoNothing on all inserts — the second call is a no-op at the DB
 * level and produces identical results.
 */
export async function lazyBackfillIfNeeded(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<boolean> {
  const hasCCData = await hasUserCCData(db, userId);
  if (hasCCData) {
    const reconciled = await reconcileMissingCloudProviderMirrors(db, userId);
    return reconciled > 0;
  }

  await runBackfill(db, { userId });
  return true;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as CredentialProvider] ?? provider;
}

/**
 * Reconcile legacy cloud-provider rows that were saved after a user already had
 * composable-credentials data. Full backfill intentionally runs only once, but
 * these legacy writers remained active during the migration and resolution reads
 * cc_* first. Mirroring only missing compute attachments avoids creating
 * duplicate migrated agent attachments for users who already use the newer
 * Connections flow.
 */
export async function reconcileMissingCloudProviderMirrors(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({
      id: credentials.id,
      projectId: credentials.projectId,
      provider: credentials.provider,
      encryptedToken: credentials.encryptedToken,
      iv: credentials.iv,
      isActive: credentials.isActive,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, userId),
        eq(credentials.credentialType, 'cloud-provider'),
      ),
    );

  let inserted = 0;
  for (const row of rows) {
    const attachmentConditions = [
      eq(ccAttachments.userId, userId),
      eq(ccAttachments.consumerKind, 'compute'),
      eq(ccAttachments.consumerTarget, row.provider),
      row.projectId === null
        ? isNull(ccAttachments.projectId)
        : eq(ccAttachments.projectId, row.projectId),
    ];
    const [existing] = await db
      .select({ id: ccAttachments.id })
      .from(ccAttachments)
      .where(and(...attachmentConditions))
      .limit(1);
    if (existing) continue;

    const credentialId = `cc-legacy-cloud-cred-${row.id}`;
    const configurationId = `cc-legacy-cloud-cfg-${row.id}`;
    const attachmentId = `cc-legacy-cloud-att-${row.id}`;
    const label = providerLabel(row.provider);
    const scopeLabel = row.projectId ? 'project override' : 'default';

    await db.insert(ccCredentials).values({
      id: credentialId,
      ownerId: userId,
      name: `${label} cloud credential (migrated)`,
      kind: 'cloud-provider',
      encryptedToken: row.encryptedToken,
      iv: row.iv,
      isActive: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).onConflictDoNothing();

    await db.insert(ccConfigurations).values({
      id: configurationId,
      ownerId: userId,
      name: `${label} ${scopeLabel} (migrated)`,
      consumerKind: 'compute',
      consumerTarget: row.provider,
      credentialId,
      settingsJson: null,
      isActive: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).onConflictDoNothing();

    await db.insert(ccAttachments).values({
      id: attachmentId,
      configurationId,
      consumerKind: 'compute',
      consumerTarget: row.provider,
      userId,
      projectId: row.projectId,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).onConflictDoNothing();
    inserted += 1;
  }

  return inserted;
}
