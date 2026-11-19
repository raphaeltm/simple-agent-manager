import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator } from '../schemas';
import { readAdminSettings, updateAdminSettings } from '../services/admin-settings';
import { AdminSettingsUnavailableError } from '../services/admin-settings-cache';
import type { AdminSettingName, AdminSettingValue } from '../services/admin-settings-registry';
import { enforceCredentialMutationRateLimit } from '../services/credential-mutation-rate-limit';
import {
  integrationSettingChanges,
  requestWaitUntil,
  scheduleSecurityAlert,
} from '../services/security-alerts';

const routes = new Hono<{ Bindings: Env }>();
routes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);
routes.onError((error) => {
  if (error instanceof AppError) return Response.json(error.toJSON(), { status: error.statusCode });
  return Response.json(
    { error: 'SETTINGS_UNAVAILABLE', message: new AdminSettingsUnavailableError().message },
    { status: 503 }
  );
});
routes.get('/', async (c) => c.json(await readAdminSettings(c.env, { fresh: true })));
const schema = v.strictObject({
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  changes: v.pipe(
    v.array(v.strictObject({ name: v.string(), value: v.unknown() })),
    v.minLength(1),
    v.maxLength(23)
  ),
});
routes.patch('/', jsonValidator(schema), async (c) => {
  const body = c.req.valid('json');
  const actorUserId = getAuth(c).user.id;
  if (body.changes.some((change) => change.name.startsWith('integration.googleInfrastructure.')))
    await enforceCredentialMutationRateLimit(c.env, actorUserId, 'google-infra-oauth');
  const changes = body.changes as { name: AdminSettingName; value: AdminSettingValue }[];
  const result = await updateAdminSettings(c.env, {
    actorUserId,
    validateProviders: true,
    expectedRevision: body.expectedRevision,
    changes,
  });
  scheduleSecurityAlert(c.env, requestWaitUntil(c), {
    kind: 'integration-changed',
    actorUserId,
    changes: integrationSettingChanges(changes),
  });
  return c.json(result);
});
export { routes as adminSettingsRoutes };
