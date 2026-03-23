import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createProvider, GcpProvider } from '@simple-agent-manager/providers';
import type { CredentialProvider, ProviderCatalog, ProviderCatalogResponse, SizeInfo, VMSize } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import * as schema from '../db/schema';
import { decrypt } from '../services/encryption';
import { buildProviderConfig, parseGcpCredential } from '../services/provider-credentials';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';

const providersRoutes = new Hono<{ Bindings: Env }>();

providersRoutes.use('*', requireAuth(), requireApproved());

/**
 * GET /api/providers/catalog
 *
 * Returns the available instance types, locations, and sizes for each
 * cloud provider the user has credentials configured for.
 */
providersRoutes.get('/catalog', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const creds = await db
    .select({
      provider: schema.credentials.provider,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
      ),
    );

  // Decrypt and build catalogs in parallel for better latency
  const results = await Promise.allSettled(
    creds.map(async (cred) => {
      const providerName = cred.provider as CredentialProvider;
      const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, getCredentialEncryptionKey(c.env));

      // GCP uses OIDC token exchange, not static API tokens — construct its provider differently
      let provider;
      if (providerName === 'gcp') {
        const gcpCred = parseGcpCredential(decryptedToken);
        // For catalog purposes we only need static metadata (locations, sizes, default zone)
        // — no actual API calls, so a no-op token provider is fine
        provider = new GcpProvider(
          gcpCred.gcpProjectId,
          async () => { throw new Error('Token provider not available for catalog'); },
          gcpCred.defaultZone,
        );
      } else {
        const config = buildProviderConfig(providerName, decryptedToken);
        provider = createProvider(config);
      }

      return {
        provider: providerName,
        locations: provider.locations.map((id) => {
          const meta = provider.locationMetadata[id];
          return {
            id,
            name: meta?.name ?? id,
            country: meta?.country ?? '',
          };
        }),
        sizes: Object.fromEntries(
          Object.entries(provider.sizes).map(([k, v]) => [
            k,
            { type: v.type, price: v.price, vcpu: v.vcpu, ramGb: v.ramGb, storageGb: v.storageGb },
          ]),
        ) as Record<VMSize, SizeInfo>,
        defaultLocation: provider.defaultLocation,
      } satisfies ProviderCatalog;
    }),
  );

  const catalogs: ProviderCatalog[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      catalogs.push(result.value);
    } else {
      // Skip providers with invalid/expired credentials — log only message, not raw error
      const errMsg = result.reason instanceof Error ? result.reason.message : 'unknown';
      log.warn('catalog.build_failed', { error: errMsg });
    }
  }

  const response: ProviderCatalogResponse = { catalogs };
  return c.json(response);
});

export { providersRoutes };
