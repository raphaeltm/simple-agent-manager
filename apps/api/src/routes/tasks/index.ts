import { Hono } from 'hono';

import type { Env } from '../../index';
import { crudRoutes } from './crud';
import { runRoutes } from './run';
import { submitRoutes } from './submit';
import { uploadRoutes } from './upload';

const tasksRoutes = new Hono<{ Bindings: Env }>();
tasksRoutes.route('/', crudRoutes);
tasksRoutes.route('/', runRoutes);
tasksRoutes.route('/', submitRoutes);
tasksRoutes.route('/', uploadRoutes);

export { tasksRoutes };
