import {
  createProvider,
  GcpProvider,
  getProviderCatalogOfferings,
  type Provider as CloudProvider,
  type ProviderConfig,
  type ProviderLogContext,
  type ProviderLogger,
} from '@simple-agent-manager/providers';
import type {
  CredentialProvider,
  ProviderCatalog,
  ProviderCatalogRefreshStatus,
  ProviderInstanceOffering,
  SizeInfo,
  VMSize,
} from '@simple-agent-manager/shared';
import { getLocationsForProvider } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveAdminSetting } from './admin-settings-resolution';
import { decrypt } from './encryption';
import { withDeadline } from './fetch-timeout';
import {
  type Db,
  DEFAULT_PROVIDER_CATALOG_TIMEOUT_MS,
  type ProviderCatalogCredentialSeed,
  type ProviderCatalogListResult,
  type ProviderCatalogOfferingResolution,
} from './provider-catalogs-common';
import {
  listAuthenticatedProviderCatalogSeeds,
  listInstallationProviderCatalogSeeds,
  listProjectProviderCatalogSeeds,
  listUserProviderCatalogSeeds,
} from './provider-catalogs-seeds';
import {
  buildProviderConfig,
  extractCloudProviderToken,
  parseGcpCredential,
} from './provider-credential-codecs';

export async function listProviderCatalogOfferings(
  providerName: CredentialProvider,
  provider: CloudProvider,
  timeoutMs = DEFAULT_PROVIDER_CATALOG_TIMEOUT_MS
): Promise<ProviderCatalogOfferingResolution> {
  try {
    const offerings = await withDeadline(
      (signal) =>
        provider.listInstanceOfferings(
          {
            preferApi: true,
            allowStaticFallback: false,
          },
          { signal }
        ),
      timeoutMs
    );
    return {
      offerings,
      refreshStatus: refreshStatusForOfferings(offerings, {
        // The transport succeeded: `allowStaticFallback: false` means an API-backed provider
        // either enumerated its inventory or threw. Completeness is therefore carried from
        // the call, not inferred from whether the array happens to have members.
        transportSucceeded: true,
        apiBacked: provider.instanceOfferingApiBacked === true,
      }),
    };
  } catch (error) {
    log.warn('catalog.live_offerings_failed', {
      provider: providerName,
      ...serializeError(error),
    });
    // A transient live-enumeration failure must not delete the whole provider
    // from the catalog: rethrowing here drops the credential's catalog in
    // buildCatalogsFromCredentialRows, which empties the UI picker and starves
    // default-pool candidate materialisation. Fall back to the provider's own
    // static offerings, which are the same shape and are what preferApi:false
    // returns. Only a failure of BOTH is fatal.
    try {
      return {
        offerings: await withDeadline(
          (signal) => provider.listInstanceOfferings({ preferApi: false }, { signal }),
          timeoutMs
        ),
        refreshStatus: { succeeded: false, origin: 'static', complete: false },
      };
    } catch (staticError) {
      log.warn('catalog.static_offerings_failed', {
        provider: providerName,
        ...serializeError(staticError),
      });
      throw error;
    }
  }
}

export function getStaticProviderCatalogOfferings(
  provider: CredentialProvider
): ProviderInstanceOffering[] {
  const locations = getLocationsForProvider(provider);
  const locationMetadata = Object.fromEntries(
    locations.map((location) => [location.id, { name: location.name, country: location.country }])
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
  const providerToken = extractCloudProviderToken(providerName, decryptedToken);
  const provider = createCatalogProvider(providerName, providerToken, input.env);
  const timeoutMs = Number(
    await resolveAdminSetting(input.env, 'performance.providerCatalogTimeoutMs')
  );
  const resolved = await listProviderCatalogOfferings(providerName, provider, timeoutMs);
  return buildProviderCatalog({
    seed: input.seed,
    providerName,
    provider,
    offerings: resolved.offerings,
    refreshStatus: resolved.refreshStatus,
  });
}

export async function listAuthenticatedProviderCatalogs(
  db: Db,
  input: { userId: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const seeds = await listAuthenticatedProviderCatalogSeeds(db, {
    userId: input.userId,
    activeOnly: true,
  });
  return buildCatalogsFromCredentialRows(seeds, input.env);
}

export async function listUserProviderCatalogs(
  db: Db,
  input: { userId: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const seeds = await listUserProviderCatalogSeeds(db, {
    userId: input.userId,
    activeOnly: true,
  });
  return buildCatalogsFromCredentialRows(seeds, input.env);
}

export async function listProjectProviderCatalogs(
  db: Db,
  input: { projectId: string; userId?: string; env: Env }
): Promise<ProviderCatalogListResult> {
  const seeds = await listProjectProviderCatalogSeeds(db, {
    projectId: input.projectId,
    userId: input.userId,
    activeOnly: true,
  });
  return buildCatalogsFromCredentialRows(seeds, input.env);
}

export async function listInstallationProviderCatalogs(
  db: Db,
  input: { env: Env }
): Promise<ProviderCatalogListResult> {
  const seeds = await listInstallationProviderCatalogSeeds(db, { activeOnly: true });
  return buildCatalogsFromCredentialRows(seeds, input.env);
}

export function createCatalogProvider(
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
  return createProvider(withCatalogProviderLogger(config, providerName));
}

export function withCatalogProviderLogger(
  config: ProviderConfig,
  providerName: CredentialProvider
): ProviderConfig {
  if (config.provider === 'gcp' || config.provider === 'scaleway') return config;
  return {
    ...config,
    logger: catalogProviderLogger(providerName),
  };
}

export function catalogProviderLogger(providerName: CredentialProvider): ProviderLogger {
  return {
    warn: (message: string, context?: ProviderLogContext) =>
      log.warn('catalog.provider_warning', {
        provider: providerName,
        message,
        ...sanitizeProviderLogContext(context),
      }),
    info: (message: string, context?: ProviderLogContext) =>
      log.info('catalog.provider_info', {
        provider: providerName,
        message,
        ...sanitizeProviderLogContext(context),
      }),
  };
}

export function sanitizeProviderLogContext(context?: ProviderLogContext): ProviderLogContext {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      key.toLowerCase().includes('error') ? '[REDACTED_ERROR_MESSAGE]' : value,
    ])
  );
}

export function buildProviderCatalog(input: {
  seed: ProviderCatalogCredentialSeed;
  providerName: CredentialProvider;
  provider: CloudProvider;
  offerings: ProviderInstanceOffering[];
  refreshStatus: ProviderCatalogRefreshStatus;
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
    externalSourceRef: input.seed.externalSourceRef,
    credentialReference: input.seed.credentialReference,
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
    refreshStatus: input.refreshStatus,
    defaultLocation: input.provider.defaultLocation,
  };
}

export async function buildCatalogsFromCredentialRows(
  seeds: ProviderCatalogCredentialSeed[],
  env: Env
): Promise<ProviderCatalogListResult> {
  const results = await Promise.allSettled(
    seeds.map((seed) => buildProviderCatalogForCredential({ env, seed }))
  );

  const catalogs: ProviderCatalog[] = [];
  const refreshFailures: ProviderCatalogListResult['refreshFailures'] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      catalogs.push(result.value);
    } else {
      log.warn('catalog.build_failed', serializeError(result.reason));
      const seed = seeds[index];
      if (seed) {
        refreshFailures.push({
          provider: seed.provider,
          credentialSource: seed.credentialSource,
          reason: 'provider-unavailable',
        });
      }
    }
  }

  return { catalogs, credentialCount: seeds.length, refreshFailures };
}

/**
 * Explicit provenance/completeness for a catalog refresh.
 *
 * Deriving this from array members alone misclassified a SUCCESSFUL, COMPLETE, EMPTY API
 * inventory (Hetzner `server_types: []`) as an incomplete static catalog, which made
 * candidate reconciliation skip marking the pool's prior offerings unavailable — forever.
 * The empty case is only authoritative when the provider actually has an API-backed catalog;
 * an empty STATIC list stays incomplete so a provider without a live catalog can never
 * wipe last-known-good availability.
 */
export function refreshStatusForOfferings(
  offerings: ProviderInstanceOffering[],
  transport: { transportSucceeded: boolean; apiBacked: boolean }
): ProviderCatalogRefreshStatus {
  const hasApiOfferings = offerings.some((offering) => offering.catalogSource === 'api');
  const hasStaticOfferings = offerings.some((offering) => offering.catalogSource === 'static');
  if (hasApiOfferings && !hasStaticOfferings) {
    return { succeeded: true, origin: 'api', complete: true };
  }
  if (offerings.length === 0 && transport.transportSucceeded && transport.apiBacked) {
    return { succeeded: true, origin: 'api', complete: true };
  }
  return {
    succeeded: true,
    origin: hasApiOfferings ? 'api' : 'static',
    complete: false,
    reason: 'static-catalog',
  };
}
