import { Hono } from 'hono';
import type { Env } from '../../index';
import { requireAuth, requireApproved } from '../../middleware/auth';
import { crudRoutes } from './crud';
import { acpSessionRoutes } from './acp-sessions';
import { fileProxyRoutes } from './files';

const projectsRoutes = new Hono<{ Bindings: Env }>();
projectsRoutes.use('/*', requireAuth(), requireApproved());
projectsRoutes.route('/', crudRoutes);
projectsRoutes.route('/', acpSessionRoutes);
projectsRoutes.route('/', fileProxyRoutes);

export { projectsRoutes };
