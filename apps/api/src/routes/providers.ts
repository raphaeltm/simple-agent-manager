import type { ProviderCatalogResponse } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { type Context,Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import {
  listAuthenticatedProviderCatalogs,
  listInstallationProviderCatalogs,
  listProjectProviderCatalogs,
  listUserProviderCatalogs,
  type ProviderCatalogListResult,
} from '../services/provider-catalogs';

const providersRoutes = new Hono<{ Bindings: Env }>();
const CLOUD_PROVIDER_CREDENTIAL_SETUP_MESSAGE =
  'Configure a cloud-provider credential before creating compute pools.';
type Db = ReturnType<typeof drizzle<typeof schema>>;

providersRoutes.use('*', requireAuth(), requireApproved());

/**
 * GET /api/providers/catalog
 *
 * Returns provider-native offerings, locations, and legacy size presets for each
 * cloud provider the user has active credentials configured for.
 */
providersRoutes.get('/catalog', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const result = await readProviderCatalogsForRequest(c, db, userId);

  const response: ProviderCatalogResponse =
    result.credentialCount === 0
      ? {
          catalogs: result.catalogs,
          credentialSetupRequired: true,
          credentialSetupMessage: CLOUD_PROVIDER_CREDENTIAL_SETUP_MESSAGE,
        }
      : { catalogs: result.catalogs, credentialSetupRequired: false };
  c.header('Cache-Control', 'private, no-store');
  return c.json(response);
});

async function readProviderCatalogsForRequest(
  c: Context<{ Bindings: Env }>,
  db: Db,
  userId: string
): Promise<ProviderCatalogListResult> {
  const scope = c.req.query('scope');

  if (!scope) {
    return listAuthenticatedProviderCatalogs(db, { userId, env: c.env });
  }

  if (scope === 'user') {
    return listUserProviderCatalogs(db, { userId, env: c.env });
  }

  if (scope === 'project') {
    const projectId = c.req.query('projectId')?.trim();
    if (!projectId) throw errors.badRequest('projectId is required for project provider catalogs');
    await requireProjectCapability(db, projectId, userId, 'secret:read');
    return listProjectProviderCatalogs(db, { projectId, env: c.env });
  }

  if (scope === 'installation') {
    if (getAuth(c).user.role !== 'superadmin') {
      throw errors.forbidden('Superadmin access required');
    }
    return listInstallationProviderCatalogs(db, { env: c.env });
  }

  throw errors.badRequest('scope must be user, project, or installation');
}

export { providersRoutes };
