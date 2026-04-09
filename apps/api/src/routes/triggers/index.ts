import { Hono } from 'hono';

import type { Env } from '../../index';
import { requireApproved, requireAuth } from '../../middleware/auth';
import { crudRoutes } from './crud';
import { executionRoutes } from './executions';

const triggersRoutes = new Hono<{ Bindings: Env }>();
triggersRoutes.use('/*', requireAuth(), requireApproved());
triggersRoutes.route('/', crudRoutes);
triggersRoutes.route('/', executionRoutes);

export { triggersRoutes };
