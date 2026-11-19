import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { errors } from './error';

/** Phase 1 changes require an active superadmin even when signup approval exempts admins. */
export function requireActiveSettingsSuperadmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get('auth')?.user;
    if (!user) throw errors.unauthorized('Authentication required');
    if (user.role !== 'superadmin' || user.status !== 'active') {
      throw errors.forbidden('Active superadmin access required');
    }
    await next();
  };
}
