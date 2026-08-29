import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log, serializeError } from '../lib/logger';
import {
  CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
  externalCapacitySourceCredentialId,
} from './default-capacity-pool-helpers';
import type { CredentialCapacitySeed, DefaultCapacityPoolsBackfillOptions } from './default-capacity-pools';
import {
  buildProviderCatalogForCredential,
  getStaticProviderCatalogOfferings,
} from './provider-catalogs';

type Db = ReturnType<typeof drizzle>;

export async function materializeCapacitySourceCredential(
  db: Db,
  seed: CredentialCapacitySeed
): Promise<CredentialCapacitySeed> {
  if (seed.credentialId || seed.platformCredentialId || !seed.externalSourceRef) return seed;

  const ownerUserId = seed.createdBy ?? seed.ownerUserId;
  if (!ownerUserId) {
    throw new Error(`External capacity source seed ${seed.id} has no owning user`);
  }

  const credentialId = externalCapacitySourceCredentialId(seed.externalSourceRef);
  const now = new Date().toISOString();
  await db
    .insert(schema.credentials)
    .values({
      id: credentialId,
      userId: ownerUserId,
      projectId: seed.scope === 'project' ? seed.ownerProjectId : null,
      provider: seed.provider,
      credentialType: CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
      credentialKind: 'api-key',
      isActive: seed.active,
      encryptedToken: seed.encryptedToken,
      iv: seed.iv,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.credentials.id,
      set: {
        userId: ownerUserId,
        projectId: seed.scope === 'project' ? seed.ownerProjectId : null,
        provider: seed.provider,
        credentialType: CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE,
        credentialKind: 'api-key',
        isActive: seed.active,
        encryptedToken: seed.encryptedToken,
        iv: seed.iv,
        updatedAt: now,
      },
    });

  return { ...seed, credentialId };
}

export async function resolveOfferingsForSeed(
  seed: CredentialCapacitySeed,
  options: DefaultCapacityPoolsBackfillOptions
) {
  if (options.offeringResolver) {
    return options.offeringResolver(seed);
  }

  if (options.env) {
    try {
      const catalog = await buildProviderCatalogForCredential({
        env: options.env,
        seed: {
          id: seed.id,
          provider: seed.provider,
          encryptedToken: seed.encryptedToken,
          iv: seed.iv,
          credentialSource: seed.credentialSource,
          credentialId: seed.catalogCredentialId,
          platformCredentialId: seed.platformCredentialId,
          capacitySourceCredentialId: seed.credentialId,
          credentialReference: seed.credentialReference,
          credentialVersion: seed.credentialVersion,
          externalSourceRef: seed.externalSourceRef,
          active: seed.active,
          createdBy: seed.createdBy,
        },
      });
      return catalog.offerings ?? [];
    } catch (error) {
      log.warn('default_capacity_pools.catalog_build_failed', {
        provider: seed.provider,
        scope: seed.scope,
        credentialSource: seed.credentialSource,
        ...serializeError(error),
      });
    }
  }

  return getStaticProviderCatalogOfferings(seed.provider);
}
