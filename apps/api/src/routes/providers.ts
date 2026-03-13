import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createProvider } from '@simple-agent-manager/providers';
import type { CredentialProvider, ProviderCatalog, ProviderCatalogResponse } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import * as schema from '../db/schema';
import { decrypt } from '../services/encryption';
import { buildProviderConfig } from '../services/provider-credentials';

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
      const decryptedToken = await decrypt(cred.encryptedToken, cred.iv, c.env.ENCRYPTION_KEY);
      const config = buildProviderConfig(providerName, decryptedToken);
      const provider = createProvider(config);

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
        sizes: { ...provider.sizes },
        defaultLocation: provider.defaultLocation,
      } satisfies ProviderCatalog;
    }),
  );

  const catalogs: ProviderCatalog[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      catalogs.push(result.value);
    } else {
      // Skip providers with invalid/expired credentials
      console.warn('Failed to build provider catalog entry:', result.reason);
    }
  }

  const response: ProviderCatalogResponse = { catalogs };
  return c.json(response);
});

export { providersRoutes };
