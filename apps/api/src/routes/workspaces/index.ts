import { Hono } from 'hono';
import type { Env } from '../../index';
import { crudRoutes } from './crud';
import { lifecycleRoutes } from './lifecycle';
import { agentSessionRoutes } from './agent-sessions';
import { runtimeRoutes } from './runtime';

const workspacesRoutes = new Hono<{ Bindings: Env }>();
workspacesRoutes.route('/', crudRoutes);
workspacesRoutes.route('/', lifecycleRoutes);
workspacesRoutes.route('/', agentSessionRoutes);
workspacesRoutes.route('/', runtimeRoutes);

export { workspacesRoutes };
