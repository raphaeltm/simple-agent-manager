import { Hono } from 'hono';

import type { Env } from '../../env';
import { requireApproved,requireAuth } from '../../middleware/auth';
import { acpSessionRoutes } from './acp-sessions';
import { browserProxyRoutes } from './browser';
import { crudRoutes } from './crud';
import { fileProxyRoutes } from './files';

const projectsRoutes = new Hono<{ Bindings: Env }>();
projectsRoutes.use('/*', requireAuth(), requireApproved());
projectsRoutes.route('/', crudRoutes);
projectsRoutes.route('/', acpSessionRoutes);
projectsRoutes.route('/', fileProxyRoutes);
projectsRoutes.route('/', browserProxyRoutes);

export { projectsRoutes };
