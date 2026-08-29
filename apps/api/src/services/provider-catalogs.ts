import {
  createProvider,
  GcpProvider,
  getProviderCatalogOfferings,
  type Provider as CloudProvider,
} from '@simple-agent-manager/providers';
import type {
  CredentialProvider,
  ProviderCatalog,
  ProviderInstanceOffering,
  SizeInfo,
  VMSize,
} from '@simple-agent-manager/shared';
import { getLocationsForProvider, isValidProvider } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt } from './encryption';
import { buildProviderConfig, parseGcpCredential } from './provider-credentials';

type Db = ReturnType<typeof drizzle>;

export type ProviderCatalogCredentialSource = 'user' | 'project' | 'platform';

export interface ProviderCatalogCredentialSeed {
  id: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  credentialSource: ProviderCatalogCredentialSource;
  credentialId: string | null;
  platformCredentialId: string | null;
}

export interface ProviderCatalogListResult {
  catalogs: ProviderCatalog[];
  credentialCount: number;
}

export async function listProviderCatalogOfferings(
  providerName: CredentialProvider,
  provider: CloudProvider
): Promise<ProviderInstanceOffering[]> {
  try {
    return await provider.listInstanceOfferings({ preferApi: true });
  } catch (error) {
    log.warn('catalog.live_offerings_failed', {
      provider: providerName,
      error: error instanceof Error ? error.message : String(error),
    });
    return provider.listInstanceOfferings({ preferApi: false });
  }
}

export function getStaticProviderCatalogOfferings(
  provider: CredentialProvider
): ProviderInstanceOffering[] {
  const locations = getLocationsForProvider(provider);
  const locationMetadata = Object.fromEntries(
    locations.map((location) => [
      location.id,
      { name: location.name, country: location.country },
    ])
  );
  return getProviderCatalogOfferings(
    provider,
    locations.map((location) => location.id),
    locationMetadata
  );
}

export async function buildProviderCatalogForCredential(input: {
  env: Env;
  seed: ProviderCatalogCredentialSeed;
}): Promise<ProviderCatalog> {
  const providerName = input.seed.provider;
  const decryptedToken = await decrypt(
    input.seed.encryptedToken,
    input.seed.iv,
    getCredentialEncryptionKey(input.env)
  );
  const provider = createCatalogProvider(providerName, decryptedToken, input.env);
  const offerings = await listProviderCatalogOfferings(providerName, provider);
  return buildProviderCatalog({
    seed: input.seed,
    providerName,
    provider,
    offerings,
  });
}

export async function listAuthenticatedProviderCatalogs(
  db: Db,
  input: { userId: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      projectId: schema.credentials.projectId,
      provider: schema.credentials.provider,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, input.userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        eq(schema.credentials.isActive, true)
      )
    );

  return buildCatalogsFromCredentialRows(
    rows.flatMap((row) => {
      if (!isValidProvider(row.provider)) return [];
      return [
        {
          id: row.id,
          provider: row.provider,
          encryptedToken: row.encryptedToken,
          iv: row.iv,
          credentialSource: row.projectId ? 'project' : 'user',
          credentialId: row.id,
          platformCredentialId: null,
        } satisfies ProviderCatalogCredentialSeed,
      ];
    }),
    input.env
  );
}

export async function listUserProviderCatalogs(
  db: Db,
  input: { userId: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      provider: schema.credentials.provider,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, input.userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        eq(schema.credentials.isActive, true),
        isNull(schema.credentials.projectId)
      )
    );

  return buildCatalogsFromCredentialRows(
    rows.flatMap((row) => {
      if (!isValidProvider(row.provider)) return [];
      return [
        {
          id: row.id,
          provider: row.provider,
          encryptedToken: row.encryptedToken,
          iv: row.iv,
          credentialSource: 'user',
          credentialId: row.id,
          platformCredentialId: null,
        } satisfies ProviderCatalogCredentialSeed,
      ];
    }),
    input.env
  );
}

export async function listProjectProviderCatalogs(
  db: Db,
  input: { projectId: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const rows = await db
    .select({
      id: schema.credentials.id,
      provider: schema.credentials.provider,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.projectId, input.projectId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        eq(schema.credentials.isActive, true)
      )
    );

  return buildCatalogsFromCredentialRows(
    rows.flatMap((row) => {
      if (!isValidProvider(row.provider)) return [];
      return [
        {
          id: row.id,
          provider: row.provider,
          encryptedToken: row.encryptedToken,
          iv: row.iv,
          credentialSource: 'project',
          credentialId: row.id,
          platformCredentialId: null,
        } satisfies ProviderCatalogCredentialSeed,
      ];
    }),
    input.env
  );
}

export async function listInstallationProviderCatalogs(
  db: Db,
  input: { env: Env }
): Promise<ProviderCatalogListResult> {
  const rows = await db
    .select({
      id: schema.platformCredentials.id,
      provider: schema.platformCredentials.provider,
      encryptedToken: schema.platformCredentials.encryptedToken,
      iv: schema.platformCredentials.iv,
    })
    .from(schema.platformCredentials)
    .where(
      and(
        eq(schema.platformCredentials.credentialType, 'cloud-provider'),
        eq(schema.platformCredentials.isEnabled, true)
      )
    );

  return buildCatalogsFromCredentialRows(
    rows.flatMap((row) => {
      if (!row.provider || !isValidProvider(row.provider)) return [];
      return [
        {
          id: row.id,
          provider: row.provider,
          encryptedToken: row.encryptedToken,
          iv: row.iv,
          credentialSource: 'platform',
          credentialId: null,
          platformCredentialId: row.id,
        } satisfies ProviderCatalogCredentialSeed,
      ];
    }),
    input.env
  );
}

function createCatalogProvider(
  providerName: CredentialProvider,
  decryptedToken: string,
  env: Env
): CloudProvider {
  if (providerName === 'gcp') {
    const gcpCred = parseGcpCredential(decryptedToken);
    return new GcpProvider(
      gcpCred.gcpProjectId,
      async () => {
        throw new Error('Token provider not available for catalog');
      },
      gcpCred.defaultZone
    );
  }

  const config = buildProviderConfig(providerName, decryptedToken, env);
  return createProvider(config);
}

function buildProviderCatalog(input: {
  seed: ProviderCatalogCredentialSeed;
  providerName: CredentialProvider;
  provider: CloudProvider;
  offerings: ProviderInstanceOffering[];
}): ProviderCatalog {
  const locationIds = [
    ...input.provider.locations,
    ...input.offerings.flatMap((offering) =>
      input.provider.locations.includes(offering.location) ? [] : [offering.location]
    ),
  ];

  return {
    provider: input.providerName,
    credentialSource: input.seed.credentialSource,
    credentialId: input.seed.credentialId,
    platformCredentialId: input.seed.platformCredentialId,
    locations: [...new Set(locationIds)].map((id) => {
      const meta = input.provider.locationMetadata[id];
      return {
        id,
        name: meta?.name ?? id,
        country: meta?.country ?? '',
      };
    }),
    sizes: Object.fromEntries(
      Object.entries(input.provider.sizes).map(([k, v]) => [
        k,
        { type: v.type, price: v.price, vcpu: v.vcpu, ramGb: v.ramGb, storageGb: v.storageGb },
      ])
    ) as Record<VMSize, SizeInfo>,
    offerings: input.offerings,
    defaultLocation: input.provider.defaultLocation,
  };
}

async function buildCatalogsFromCredentialRows(
  seeds: ProviderCatalogCredentialSeed[],
  env: Env
): Promise<ProviderCatalogListResult> {
  const results = await Promise.allSettled(
    seeds.map((seed) => buildProviderCatalogForCredential({ env, seed }))
  );

  const catalogs: ProviderCatalog[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      catalogs.push(result.value);
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : 'unknown';
      log.warn('catalog.build_failed', { error: errMsg });
    }
  }

  return { catalogs, credentialCount: seeds.length };
}
