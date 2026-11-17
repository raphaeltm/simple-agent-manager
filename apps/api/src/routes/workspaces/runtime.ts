import {
  type BootstrapTokenData,
  DEFAULT_AGENT_PERMISSION_MODE,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { requireApproved, requireAuth } from '../../middleware/auth';
import { AgentTypeBodySchema, BootLogEntrySchema, jsonValidator } from '../../schemas';
import { appendBootLog } from '../../services/boot-log';
import { registerBootstrapTokenConsume } from '../../services/bootstrap';
import { resolveProjectAgentDefault } from '../../services/project-agent-defaults';
import { getWorkspaceRuntimeAssets } from '../../services/workspace-runtime-assets';
import {
  assertWorkspaceAcceptsCallback,
  assertWorkspaceCallbackIdentityCurrent,
  assertWorkspaceCallbackResourceById,
  verifyWorkspaceCallbackAuth,
  workspaceCallbackIdentityFields,
} from './_helpers';
import { agentKeyRoutes } from './runtime-agent-key';
import { callbackJsonWithJit } from './runtime-callback-response';
import { gitTokenRoutes } from './runtime-git-token';
import { messageRoutes } from './runtime-messages';
export { resolveMaxMessageBytes } from './runtime-message-helpers';
const runtimeRoutes = new Hono<{ Bindings: Env }>();
runtimeRoutes.route('/', agentKeyRoutes);
runtimeRoutes.route('/', gitTokenRoutes);
runtimeRoutes.route('/', messageRoutes);
runtimeRoutes.post('/:id/agent-settings', jsonValidator(AgentTypeBodySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = c.req.valid('json');

  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await assertWorkspaceCallbackResourceById(c.env, workspaceId, 'agent_settings');

  // Fetch user-level agent settings (existing behaviour).
  const settingsRows = await db
    .select()
    .from(schema.agentSettings)
    .where(
      and(
        eq(schema.agentSettings.userId, workspace.userId),
        eq(schema.agentSettings.agentType, body.agentType)
      )
    )
    .limit(1);
  const userRow = settingsRows[0];

  // Fetch project-level agent defaults for this agent type (multi-level config override).
  let projectDefaults = { model: null as string | null, permissionMode: null as string | null };
  if (workspace.projectId) {
    const projectRows = await db
      .select({ agentDefaults: schema.projects.agentDefaults })
      .from(schema.projects)
      .where(eq(schema.projects.id, workspace.projectId))
      .limit(1);
    if (projectRows[0]) {
      projectDefaults = resolveProjectAgentDefault(projectRows[0].agentDefaults, body.agentType);
    }
  }

  // Resolution: project.agentDefaults[agentType] > user agent_settings > platform default
  // (permission mode only; model stays null so the agent picks its own). An agent profile's
  // permission mode is applied on top of this by the VM agent (PermissionModeOverride).
  // OpenCode-specific provider/baseUrl stay user-scoped (phase 1 does not include them).
  return callbackJsonWithJit(c, workspace, 'agent_settings', {
    model: projectDefaults.model ?? userRow?.model ?? null,
    permissionMode:
      projectDefaults.permissionMode ?? userRow?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
    opencodeProvider: userRow?.opencodeProvider ?? null,
    opencodeBaseUrl: userRow?.opencodeBaseUrl ?? null,
  });
});
runtimeRoutes.get('/:id/runtime', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({
      ...workspaceCallbackIdentityFields,
      repository: schema.workspaces.repository,
      branch: schema.workspaces.branch,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = await assertWorkspaceAcceptsCallback(
    c.env,
    workspaceRows[0],
    workspaceId,
    'runtime'
  );

  await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'runtime');
  return c.json({
    workspaceId: workspace.workspaceId,
    repository: workspace.repository,
    branch: workspace.branch,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
    status: workspace.status,
    nodeId: workspace.nodeId,
  });
});

runtimeRoutes.get('/:id/runtime-assets', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const db = drizzle(c.env.DATABASE, { schema });
  const agentSessionId = c.req.query('agentSessionId')?.trim() || null;
  const workspace = await assertWorkspaceCallbackResourceById(c.env, workspaceId, 'runtime_assets');
  const assets = await getWorkspaceRuntimeAssets(
    db,
    { workspaceId, agentSessionId },
    getCredentialEncryptionKey(c.env)
  );
  await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'runtime_assets');
  return c.json(assets);
});

runtimeRoutes.post('/:id/boot-log', jsonValidator(BootLogEntrySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = c.req.valid('json');
  const workspace = await assertWorkspaceCallbackResourceById(c.env, workspaceId, 'boot_log');

  const entry = {
    step: body.step,
    status: body.status,
    message: body.message,
    detail: body.detail,
    timestamp: body.timestamp || new Date().toISOString(),
  };

  await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'boot_log');
  await appendBootLog(c.env.KV, workspaceId, entry, c.env);
  return callbackJsonWithJit(c, workspace, 'boot_log', { success: true });
});

/**
 * POST /:id/messages — VM agent batch message persistence.
 * Uses workspace callback auth. Accepts 1-100 messages per batch.
 * All messages must target the same sessionId.
 */
runtimeRoutes.post('/:id/bootstrap-token', requireAuth(), requireApproved(), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const workspace = await assertWorkspaceCallbackResourceById(
    c.env,
    workspaceId,
    'bootstrap_token'
  );

  const bootstrapToken = ulid();
  const now = new Date().toISOString();
  const data: BootstrapTokenData = {
    workspaceId,
    encryptedHetznerToken: '',
    hetznerTokenIv: '',
    encryptedCallbackToken: '',
    callbackTokenIv: '',
    encryptedGithubToken: null,
    githubTokenIv: null,
    gitUserName: null,
    gitUserEmail: null,
    createdAt: now,
  };

  await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'bootstrap_token');
  await registerBootstrapTokenConsume(
    c.env.DATABASE,
    bootstrapToken,
    new Date(Date.now() + 60 * 1000).toISOString()
  );

  await c.env.KV.put(`bootstrap:${bootstrapToken}`, JSON.stringify(data), {
    expirationTtl: 60,
  });

  return callbackJsonWithJit(c, workspace, 'bootstrap_token', { token: bootstrapToken });
});

export { runtimeRoutes };
