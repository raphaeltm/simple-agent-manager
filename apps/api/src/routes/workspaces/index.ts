import { Hono } from 'hono';

import type { Env } from '../../env';
import { agentCredentialSyncRoutes } from './agent-credential-sync';
import { agentSessionSuspendResumeRoutes } from './agent-session-suspend-resume';
import { agentSessionRoutes } from './agent-sessions';
import { callbackTokenRenewalRoutes } from './callback-token-renewal';
import { crudRoutes } from './crud';
import { lifecycleRoutes } from './lifecycle';
import { lifecycleTimingsRoutes } from './lifecycle-timings';
import { localForwardRoutes } from './local-forward';
import { mcpTokenRotationRoutes } from './mcp-token-rotation';
import { runtimeRoutes } from './runtime';
import { sessionSnapshotRoutes } from './session-snapshots';

const workspacesRoutes = new Hono<{ Bindings: Env }>();
workspacesRoutes.route('/', lifecycleTimingsRoutes);
workspacesRoutes.route('/', crudRoutes);
workspacesRoutes.route('/', localForwardRoutes);
workspacesRoutes.route('/', lifecycleRoutes);
workspacesRoutes.route('/', agentSessionRoutes);
workspacesRoutes.route('/', agentSessionSuspendResumeRoutes);
workspacesRoutes.route('/', runtimeRoutes);
workspacesRoutes.route('/', agentCredentialSyncRoutes);
workspacesRoutes.route('/', sessionSnapshotRoutes);
workspacesRoutes.route('/', callbackTokenRenewalRoutes);
workspacesRoutes.route('/', mcpTokenRotationRoutes);

export { workspacesRoutes };
