/**
 * Backfill service — populates cc_* tables from the legacy credentials + platform_credentials tables.
 *
 * This is the API-side bridge to the shared backfill function. It reads raw rows,
 * computes fingerprints for dedup, invokes the pure backfill mapper, and inserts results.
 *
 * The shared backfill produces Credential/Configuration/Attachment objects with placeholder
 * secrets (it never touches ciphertext). This service maps the credential IDs back to the
 * real (encryptedToken, iv) pairs from the source rows for DB insertion.
 */

import {
  backfill,
  type CCSourceCredentialRow,
  type CCSourcePlatformRow,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import {
  ccAttachments,
  ccConfigurations,
  ccCredentials,
  credentials,
  platformCredentials,
} from '../../db/schema';

/**
 * Fingerprint for ciphertext dedup — uses (encryptedToken, iv) pair as identity.
 */
function fingerprintSecret(encryptedToken: string, iv: string): string {
  return `${encryptedToken}:${iv}`;
}

export interface BackfillOptions {
  dryRun?: boolean;
  userId?: string | null;
}

export interface BackfillReport {
  credentialsInserted: number;
  configurationsInserted: number;
  attachmentsInserted: number;
  dryRun: boolean;
}

/**
 * Run the backfill for a user (or all users).
 */
export async function runBackfill(
  db: ReturnType<typeof drizzle>,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const { dryRun = false, userId } = options;

  // 1. Read source rows
  const credConditions = userId ? eq(credentials.userId, userId) : undefined;
  const credRows = await db.select().from(credentials).where(credConditions);
  const platRows = await db.select().from(platformCredentials);

  // 2. Build fingerprint → (encryptedToken, iv) lookup for secret dedup
  // The shared backfill uses secretFingerprint for dedup and produces credential IDs
  // in the form `cred-{ownerId}-{fingerprint}`. We need the real ciphertext for insertion.
  const secretByCiphertext = new Map<string, { encryptedToken: string; iv: string }>();
  for (const row of credRows) {
    const fp = fingerprintSecret(row.encryptedToken, row.iv);
    secretByCiphertext.set(fp, { encryptedToken: row.encryptedToken, iv: row.iv });
  }
  for (const row of platRows) {
    const fp = fingerprintSecret(row.encryptedToken, row.iv);
    secretByCiphertext.set(fp, { encryptedToken: row.encryptedToken, iv: row.iv });
  }

  // 3. Map to shared backfill source format
  const sourceCredentials: CCSourceCredentialRow[] = credRows.map((row) => ({
    id: row.id,
    userId: row.userId,
    projectId: row.projectId ?? null,
    credentialType: row.credentialType as 'agent-api-key' | 'cloud-provider',
    credentialKind: row.credentialKind as 'api-key' | 'oauth-token',
    agentType: row.agentType ?? null,
    provider: row.provider,
    isActive: row.isActive ?? true,
    secretFingerprint: fingerprintSecret(row.encryptedToken, row.iv),
  }));

  const sourcePlatform: CCSourcePlatformRow[] = platRows.map((row) => ({
    id: row.id,
    credentialType: row.credentialType as 'agent-api-key' | 'cloud-provider',
    credentialKind: row.credentialKind as 'api-key' | 'oauth-token',
    agentType: row.agentType ?? null,
    provider: row.provider ?? null,
    isEnabled: row.isEnabled ?? true,
    secretFingerprint: fingerprintSecret(row.encryptedToken, row.iv),
  }));

  // 4. Run pure backfill mapper
  const result = backfill(sourceCredentials, sourcePlatform);
  const { credentials: ccCreds, configurations: ccConfigs, attachments: ccAtts } = result.snapshot;

  // Platform credentials (ownerId '__platform__') can't be inserted into cc_credentials
  // because owner_id has a FK to users.id. They remain in platform_credentials table.
  const userCredsCount = ccCreds.filter((c) => c.ownerId !== '__platform__').length;

  if (dryRun) {
    return {
      credentialsInserted: userCredsCount,
      configurationsInserted: ccConfigs.length,
      attachmentsInserted: ccAtts.length,
      dryRun: true,
    };
  }

  // 5. Insert into cc_* tables
  // For credentials, we need to recover the actual (encryptedToken, iv) from the fingerprint
  // embedded in the credential ID: `cred-{ownerId}-{fingerprint}` or `plat-cred-{fingerprint}`
  //
  // Platform credentials (ownerId '__platform__') are excluded — cc_credentials.owner_id has a
  // FK to users.id and '__platform__' is not a real user. Platform defaults are resolved
  // directly from the platform_credentials table, not through cc_*.
  const userCreds = ccCreds.filter((c) => c.ownerId !== '__platform__');
  if (userCreds.length > 0) {
    await db.insert(ccCredentials).values(
      userCreds.map((c) => {
        // Extract fingerprint from the credential ID
        const fp = c.id.slice(`cred-${c.ownerId}-`.length);
        const secret = secretByCiphertext.get(fp);
        if (!secret) throw new Error(`No ciphertext found for credential ${c.id}`);
        return {
          id: c.id,
          ownerId: c.ownerId,
          name: c.name,
          kind: c.kind,
          encryptedToken: secret.encryptedToken,
          iv: secret.iv,
          isActive: c.isActive,
        };
      }),
    ).onConflictDoNothing();
  }

  if (ccConfigs.length > 0) {
    await db.insert(ccConfigurations).values(
      ccConfigs.map((cfg) => ({
        id: cfg.id,
        ownerId: cfg.ownerId,
        name: cfg.name,
        consumerKind: cfg.consumer.kind,
        consumerTarget: cfg.consumer.kind === 'agent' ? cfg.consumer.agentType : cfg.consumer.provider,
        credentialId: cfg.credentialId,
        settingsJson: cfg.settings && Object.keys(cfg.settings).length > 0
          ? JSON.stringify(cfg.settings) : null,
        isActive: cfg.isActive,
      })),
    ).onConflictDoNothing();
  }

  if (ccAtts.length > 0) {
    await db.insert(ccAttachments).values(
      ccAtts.map((att) => ({
        id: att.id,
        configurationId: att.configurationId,
        consumerKind: att.consumer.kind,
        consumerTarget: att.consumer.kind === 'agent' ? att.consumer.agentType : att.consumer.provider,
        userId: att.target.userId,
        projectId: att.target.scope === 'project' ? att.target.projectId : null,
        isActive: att.isActive,
      })),
    ).onConflictDoNothing();
  }

  return {
    credentialsInserted: userCreds.length,
    configurationsInserted: ccConfigs.length,
    attachmentsInserted: ccAtts.length,
    dryRun: false,
  };
}
