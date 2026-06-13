/**
 * Builds a CompositionSnapshot from the cc_* tables for the pure resolver.
 *
 * The snapshot is the queryable boundary between D1 and the pure resolver.
 * It materializes all rows for a user into the shape the resolver expects.
 */

import type {
  CCAttachment,
  CCCompositionSnapshot,
  CCConfiguration,
  CCConfigurationSettings,
  CCConsumerRef,
  CCCredential,
  CCCredentialKind,
  CCCredentialSecret,
  CCPlatformDefault,
} from '@simple-agent-manager/shared';
import { consumerKey, mapKind } from '@simple-agent-manager/shared';
import { and, eq, isNull,or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import {
  ccAttachments,
  ccConfigurations,
  ccCredentials,
  platformCredentials,
} from '../../db/schema';
import { decrypt } from '../encryption';

/**
 * Parse the decrypted token into a typed CredentialSecret based on the kind.
 */
function parseSecret(kind: CCCredentialKind, decryptedToken: string): CCCredentialSecret {
  switch (kind) {
    case 'api-key':
      return { kind: 'api-key', apiKey: decryptedToken };
    case 'oauth-token':
      return { kind: 'oauth-token', token: decryptedToken };
    case 'openai-compatible': {
      const parsed = JSON.parse(decryptedToken);
      return { kind: 'openai-compatible', apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
    }
    case 'cloud-provider': {
      const parsed = JSON.parse(decryptedToken);
      return { kind: 'cloud-provider', provider: parsed.provider, token: parsed.token ?? decryptedToken };
    }
    case 'auth-json':
      return { kind: 'auth-json', authJson: decryptedToken };
  }
}

function rowToConsumer(row: { consumerKind: string; consumerTarget: string }): CCConsumerRef {
  return row.consumerKind === 'agent'
    ? { kind: 'agent', agentType: row.consumerTarget }
    : { kind: 'compute', provider: row.consumerTarget };
}

/**
 * Build a CompositionSnapshot for a user, optionally scoped to a project.
 * Decrypts all credential secrets.
 */
export async function buildSnapshot(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  projectId?: string | null,
): Promise<CCCompositionSnapshot> {
  // Query all three tables for this user
  const [credRows, configRows, attachRows] = await Promise.all([
    db.select().from(ccCredentials).where(eq(ccCredentials.ownerId, userId)),
    db.select().from(ccConfigurations).where(eq(ccConfigurations.ownerId, userId)),
    db.select().from(ccAttachments).where(
      projectId
        ? and(
            eq(ccAttachments.userId, userId),
            or(isNull(ccAttachments.projectId), eq(ccAttachments.projectId, projectId)),
          )
        : eq(ccAttachments.userId, userId),
    ),
  ]);

  // Decrypt credentials
  const credentials: CCCredential[] = await Promise.all(
    credRows.map(async (row) => {
      const decrypted = await decrypt(row.encryptedToken, row.iv, encryptionKey);
      return {
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        kind: row.kind as CCCredentialKind,
        secret: parseSecret(row.kind as CCCredentialKind, decrypted),
        isActive: row.isActive,
      };
    }),
  );

  // Map configurations
  const configurations: CCConfiguration[] = configRows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    consumer: rowToConsumer(row),
    credentialId: row.credentialId,
    settings: row.settingsJson ? (JSON.parse(row.settingsJson) as CCConfigurationSettings) : {},
    isActive: row.isActive,
  }));

  // Map attachments
  const attachments: CCAttachment[] = attachRows.map((row) => ({
    id: row.id,
    configurationId: row.configurationId,
    consumer: rowToConsumer(row),
    target: row.projectId
      ? { scope: 'project' as const, userId: row.userId, projectId: row.projectId }
      : { scope: 'user' as const, userId: row.userId },
    isActive: row.isActive,
  }));

  // Query platform defaults from the old platform_credentials table
  const platform = await buildPlatformDefaults(db, encryptionKey);

  return { credentials, configurations, attachments, platform };
}

/**
 * Build platform defaults from the platform_credentials table.
 * These are the lowest-precedence fallback for each consumer.
 */
async function buildPlatformDefaults(
  db: ReturnType<typeof drizzle>,
  encryptionKey: string,
): Promise<Record<string, CCPlatformDefault>> {
  const platRows = await db
    .select()
    .from(platformCredentials)
    .where(eq(platformCredentials.isEnabled, true));

  const defaults: Record<string, CCPlatformDefault> = {};

  for (const row of platRows) {
    const consumer: CCConsumerRef | null =
      row.credentialType === 'cloud-provider' && row.provider
        ? { kind: 'compute', provider: row.provider }
        : row.credentialType === 'agent-api-key' && row.agentType
          ? { kind: 'agent', agentType: row.agentType }
          : null;
    if (!consumer) continue;

    const decrypted = await decrypt(row.encryptedToken, row.iv, encryptionKey);
    const kind = mapKind(
      row.credentialType as 'agent-api-key' | 'cloud-provider',
      (row.credentialKind ?? 'api-key') as 'api-key' | 'oauth-token',
    );

    defaults[consumerKey(consumer)] = {
      mode: 'credential',
      credential: {
        id: row.id,
        ownerId: '__platform__',
        name: `platform ${consumerKey(consumer)}`,
        kind,
        secret: parseSecret(kind, decrypted),
        isActive: true,
      },
    };
  }

  return defaults;
}
