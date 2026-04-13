import { Hono } from 'hono';

import type { Env } from '../../env';
import { agentSessionRoutes } from './agent-sessions';
import { browserRoutes } from './browser';
import { crudRoutes } from './crud';
import { lifecycleRoutes } from './lifecycle';
import { runtimeRoutes } from './runtime';

const workspacesRoutes = new Hono<{ Bindings: Env }>();
workspacesRoutes.route('/', crudRoutes);
workspacesRoutes.route('/', lifecycleRoutes);
workspacesRoutes.route('/', agentSessionRoutes);
workspacesRoutes.route('/', runtimeRoutes);
workspacesRoutes.route('/', browserRoutes);

export { workspacesRoutes };
