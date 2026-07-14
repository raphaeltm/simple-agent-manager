import { Hono } from 'hono';

import type { Env } from '../../env';
import { requireApproved, requireAuth } from '../../middleware/auth';
import { actionRoutes } from './actions';
import { crudRoutes } from './crud';
import { executionRoutes } from './executions';
import { webhookRoutes } from './webhooks';

const triggersRoutes = new Hono<{ Bindings: Env }>();
triggersRoutes.use('/*', requireAuth(), requireApproved());
triggersRoutes.route('/', crudRoutes);
triggersRoutes.route('/', actionRoutes);
triggersRoutes.route('/', executionRoutes);
triggersRoutes.route('/', webhookRoutes);

export { triggersRoutes };
