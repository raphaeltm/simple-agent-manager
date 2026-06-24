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

/** Safely parse JSON settings, returning empty object on malformed data. */
function safeParseJson(json: string, contextId: string): CCConfigurationSettings {
  try {
    return JSON.parse(json) as CCConfigurationSettings;
  } catch {
    // eslint-disable-next-line no-console -- structured error log for malformed settings JSON
    console.error('snapshot.settings_parse_error', { configId: contextId });
    return {};
  }
}

/** Attempt to parse a decrypted token as a JSON object; returns null if it is not JSON. */
function tryParseJsonObject(decryptedToken: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decryptedToken);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the decrypted token into a typed CredentialSecret based on the kind.
 *
 * cloud-provider and openai-compatible secrets may be stored either as a JSON
 * object (gcp/scaleway: { provider, token }) or as a raw token string
 * (hetzner tokens, and anything copied verbatim by the legacy backfill). We
 * tolerate both so a raw token never throws and crashes the whole snapshot.
 */
function parseSecret(kind: CCCredentialKind, decryptedToken: string): CCCredentialSecret {
  switch (kind) {
    case 'api-key':
      return { kind: 'api-key', apiKey: decryptedToken };
    case 'oauth-token':
      return { kind: 'oauth-token', token: decryptedToken };
    case 'openai-compatible': {
      const parsed = tryParseJsonObject(decryptedToken);
      return {
        kind: 'openai-compatible',
        apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : decryptedToken,
        baseUrl: typeof parsed?.baseUrl === 'string' ? parsed.baseUrl : '',
      };
    }
    case 'cloud-provider': {
      const parsed = tryParseJsonObject(decryptedToken);
      return {
        kind: 'cloud-provider',
        provider: typeof parsed?.provider === 'string' ? parsed.provider : '',
        token: typeof parsed?.token === 'string' ? parsed.token : decryptedToken,
      };
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

function buildCloudProviderHints(configurations: CCConfiguration[]): Map<string, string> {
  const providersByCredential = new Map<string, Set<string>>();

  for (const configuration of configurations) {
    if (configuration.consumer.kind !== 'compute' || !configuration.credentialId) continue;

    const providers = providersByCredential.get(configuration.credentialId) ?? new Set<string>();
    providers.add(configuration.consumer.provider);
    providersByCredential.set(configuration.credentialId, providers);
  }

  const hints = new Map<string, string>();
  for (const [credentialId, providers] of providersByCredential) {
    if (providers.size === 1) {
      const [provider] = providers;
      if (provider) hints.set(credentialId, provider);
    }
  }

  return hints;
}

/**
 * Raw migrated Hetzner credentials carry no embedded provider in the encrypted
 * token body. The provider identity lives on the compute configuration produced
 * by legacy backfill, so recover it there when it is unambiguous.
 */
export function hydrateMissingCloudProviderSecretProviders(
  credentials: CCCredential[],
  configurations: CCConfiguration[],
): CCCredential[] {
  const providerHints = buildCloudProviderHints(configurations);

  return credentials.map((credential) => {
    const secret = credential.secret;
    if (secret.kind !== 'cloud-provider' || secret.provider) {
      return credential;
    }

    const provider = providerHints.get(credential.id);
    if (!provider) return credential;

    return {
      ...credential,
      secret: { ...secret, provider },
    };
  });
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

  // Decrypt credentials. A single unparseable/undecryptable credential must
  // never crash the whole snapshot — skip it and log, so resolution for all
  // other consumers (other agents, platform defaults) still succeeds.
  const credentialResults = await Promise.all(
    credRows.map(async (row): Promise<CCCredential | null> => {
      try {
        const decrypted = await decrypt(row.encryptedToken, row.iv, encryptionKey);
        return {
          id: row.id,
          ownerId: row.ownerId,
          name: row.name,
          kind: row.kind as CCCredentialKind,
          secret: parseSecret(row.kind as CCCredentialKind, decrypted),
          isActive: row.isActive,
        };
      } catch (err) {
        // eslint-disable-next-line no-console -- structured error log for unreadable credential
        console.error('snapshot.credential_parse_error', {
          credentialId: row.id,
          kind: row.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );
  const parsedCredentials: CCCredential[] = credentialResults.filter(
    (c): c is CCCredential => c !== null,
  );

  // Map configurations
  const configurations: CCConfiguration[] = configRows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    consumer: rowToConsumer(row),
    credentialId: row.credentialId,
    settings: row.settingsJson ? safeParseJson(row.settingsJson, row.id) : {},
    isActive: row.isActive,
  }));

  const credentials = hydrateMissingCloudProviderSecretProviders(
    parsedCredentials,
    configurations,
  );

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

    // A single unreadable platform credential must not crash the snapshot —
    // skip it and log. Otherwise one bad platform row (e.g. a raw cloud-provider
    // token) takes down agent resolution for every user and every consumer.
    try {
      const decrypted = await decrypt(row.encryptedToken, row.iv, encryptionKey);
      const kind = mapKind(
        row.credentialType as 'agent-api-key' | 'cloud-provider',
        (row.credentialKind ?? 'api-key') as 'api-key' | 'oauth-token',
      );

      const secret = parseSecret(kind, decrypted);
      // For platform cloud-provider rows the authoritative provider name is the
      // row.provider column, not the (possibly raw, non-JSON) token body. Raw
      // hetzner tokens carry no embedded provider, so parseSecret returns an
      // empty provider — backfill it from the row here so an empty provider
      // never propagates into the compute assembler (which throws on '').
      if (secret.kind === 'cloud-provider' && !secret.provider && row.provider) {
        secret.provider = row.provider;
      }

      defaults[consumerKey(consumer)] = {
        mode: 'credential',
        credential: {
          id: row.id,
          ownerId: '__platform__',
          name: `platform ${consumerKey(consumer)}`,
          kind,
          secret,
          isActive: true,
        },
      };
    } catch (err) {
      // eslint-disable-next-line no-console -- structured error log for unreadable platform credential
      console.error('snapshot.platform_credential_parse_error', {
        credentialId: row.id,
        credentialType: row.credentialType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return defaults;
}
