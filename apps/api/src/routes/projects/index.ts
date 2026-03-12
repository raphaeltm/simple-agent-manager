import { Hono } from 'hono';
import type { Env } from '../../index';
import { requireAuth, requireApproved } from '../../middleware/auth';
import { crudRoutes } from './crud';
import { acpSessionRoutes } from './acp-sessions';

const projectsRoutes = new Hono<{ Bindings: Env }>();
projectsRoutes.use('/*', requireAuth(), requireApproved());
projectsRoutes.route('/', crudRoutes);
projectsRoutes.route('/', acpSessionRoutes);

export { projectsRoutes };
