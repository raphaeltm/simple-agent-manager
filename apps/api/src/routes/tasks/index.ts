import { Hono } from 'hono';

import type { Env } from '../../env';
import { taskCallbackRoute } from './callback';
import { crudRoutes } from './crud';
import { providerLimitResumeRoutes } from './provider-limit-resume';
import { runRoutes } from './run';
import { submitRoutes } from './submit';
import { uploadRoutes } from './upload';

const tasksRoutes = new Hono<{ Bindings: Env }>();
tasksRoutes.route('/', crudRoutes);
tasksRoutes.route('/', runRoutes);
tasksRoutes.route('/', providerLimitResumeRoutes);
tasksRoutes.route('/', submitRoutes);
tasksRoutes.route('/', uploadRoutes);

export { taskCallbackRoute, tasksRoutes };
