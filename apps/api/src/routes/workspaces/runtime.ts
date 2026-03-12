import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { ulid } from '../../lib/ulid';
import type { Env } from '../../index';
import { requireAuth, requireApproved } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import * as schema from '../../db/schema';
import type { BootLogEntry, BootstrapTokenData } from '@simple-agent-manager/shared';
import { getDecryptedAgentKey } from '../credentials';
import { getInstallationToken } from '../../services/github-app';
import { appendBootLog } from '../../services/boot-log';
import { decrypt, encrypt } from '../../services/encryption';
import * as projectDataService from '../../services/project-data';
import { persistError } from '../../services/observability';
import {
  verifyWorkspaceCallbackAuth,
  getWorkspaceRuntimeAssets,
  safeParseJson,
} from './_helpers';

const runtimeRoutes = new Hono<{ Bindings: Env }>();

runtimeRoutes.post('/:id/agent-key', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = await c.req.json<{ agentType: string }>();

  if (!body.agentType) {
    throw errors.badRequest('agentType is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const credentialData = await getDecryptedAgentKey(
    db,
    workspace.userId,
    body.agentType,
    c.env.ENCRYPTION_KEY
  );

  if (!credentialData) {
    throw errors.notFound('Agent credential');
  }

  return c.json({
    apiKey: credentialData.credential,
    credentialKind: credentialData.credentialKind,
  });
});

/**
 * POST /:id/agent-credential-sync — VM agent callback to sync refreshed credentials.
 * Called after a session ends when the agent used file-based credential injection
 * (e.g. codex-acp auth.json) and the credential may have been refreshed during the session.
 * The VM agent reads the updated auth file from the container and sends it here.
 * Uses workspace callback auth.
 */
runtimeRoutes.post('/:id/agent-credential-sync', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  // Payload size check (64KB — auth.json files are typically a few KB).
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  const maxPayloadBytes = 64 * 1024;
  if (contentLength > maxPayloadBytes) {
    throw errors.badRequest(`Payload exceeds ${maxPayloadBytes} byte limit`);
  }

  const body = await c.req.json<{
    agentType: string;
    credentialKind: string;
    credential: string;
  }>().catch(() => null);

  if (!body) {
    throw errors.badRequest('Request body must be valid JSON');
  }

  if (!body.agentType || !body.credentialKind || !body.credential) {
    throw errors.badRequest('agentType, credentialKind, and credential are required');
  }

  // Validate against known values.
  const validAgentTypes = new Set(['claude-code', 'openai-codex', 'google-gemini']);
  const validCredentialKinds = new Set(['api-key', 'oauth-token']);
  if (!validAgentTypes.has(body.agentType)) {
    throw errors.badRequest('Invalid agentType');
  }
  if (!validCredentialKinds.has(body.credentialKind)) {
    throw errors.badRequest('Invalid credentialKind');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  // Look up the workspace to get the user ID.
  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  // Find the existing active credential to update.
  const existingCreds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, workspace.userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, body.agentType),
        eq(schema.credentials.credentialKind, body.credentialKind),
        eq(schema.credentials.isActive, true)
      )
    )
    .limit(1);

  const existing = existingCreds[0];
  if (!existing) {
    // No credential found — the user may have deleted it while the session was active.
    return c.json({ success: false, reason: 'credential_not_found' });
  }

  // Decrypt the current credential to compare.
  const currentCredential = await decrypt(
    existing.encryptedToken,
    existing.iv,
    c.env.ENCRYPTION_KEY
  );

  // Only update if the credential has actually changed.
  if (currentCredential === body.credential) {
    return c.json({ success: true, updated: false });
  }

  // Re-encrypt with a fresh IV and update.
  const { ciphertext, iv } = await encrypt(body.credential, c.env.ENCRYPTION_KEY);
  await db
    .update(schema.credentials)
    .set({
      encryptedToken: ciphertext,
      iv,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.credentials.id, existing.id));

  console.log('agent-credential-sync: credential updated', {
    workspaceId,
    agentType: body.agentType,
    credentialKind: body.credentialKind,
    credentialId: existing.id,
  });

  return c.json({ success: true, updated: true });
});

/**
 * POST /:id/agent-settings — VM agent callback to fetch user's agent settings.
 * Uses workspace callback auth (same as agent-key).
 */
runtimeRoutes.post('/:id/agent-settings', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = await c.req.json<{ agentType: string }>();

  if (!body.agentType) {
    throw errors.badRequest('agentType is required');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

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

  const row = settingsRows[0];
  if (!row) {
    return c.json({
      model: null,
      permissionMode: null,
    });
  }

  return c.json({
    model: row.model,
    permissionMode: row.permissionMode,
  });
});
runtimeRoutes.get('/:id/runtime', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({
      id: schema.workspaces.id,
      repository: schema.workspaces.repository,
      branch: schema.workspaces.branch,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  return c.json({
    workspaceId: workspace.id,
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
  const assets = await getWorkspaceRuntimeAssets(db, workspaceId, c.env.ENCRYPTION_KEY);
  return c.json(assets);
});

runtimeRoutes.post('/:id/git-token', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ installationId: schema.workspaces.installationId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace || !workspace.installationId) {
    throw errors.notFound('Workspace');
  }

  const installations = await db
    .select({ installationId: schema.githubInstallations.installationId })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspace.installationId))
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    throw errors.notFound('GitHub installation');
  }

  const token = await getInstallationToken(installation.installationId, c.env);
  return c.json({ token: token.token, expiresAt: token.expiresAt });
});

runtimeRoutes.post('/:id/boot-log', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await c.req.json<BootLogEntry>();
  if (!body.step || !body.status || !body.message) {
    throw errors.badRequest('step, status, and message are required');
  }

  const entry: BootLogEntry = {
    step: body.step,
    status: body.status,
    message: body.message,
    detail: body.detail,
    timestamp: body.timestamp || new Date().toISOString(),
  };

  await appendBootLog(c.env.KV, workspaceId, entry, c.env);
  return c.json({ success: true });
});

/**
 * POST /:id/messages — VM agent batch message persistence.
 * Uses workspace callback auth. Accepts 1-100 messages per batch.
 * All messages must target the same sessionId.
 */
runtimeRoutes.post('/:id/messages', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  // Payload size check (256KB limit)
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  const maxPayloadBytes = 256 * 1024;
  if (contentLength > maxPayloadBytes) {
    throw errors.badRequest(`Payload exceeds ${maxPayloadBytes} byte limit`);
  }

  const body = await c.req.json<{
    messages: Array<{
      messageId: string;
      sessionId: string;
      role: string;
      content: string;
      toolMetadata?: string | null;
      timestamp: string;
      sequence?: number;
    }>;
  }>();

  if (!body.messages || !Array.isArray(body.messages)) {
    throw errors.badRequest('messages array is required');
  }
  if (body.messages.length === 0) {
    throw errors.badRequest('messages array must not be empty');
  }
  if (body.messages.length > 100) {
    throw errors.badRequest('Maximum 100 messages per batch');
  }

  const validRoles = new Set(['user', 'assistant', 'system', 'tool', 'thinking', 'plan']);
  const maxMessageBytes = c.env.MESSAGE_SIZE_THRESHOLD
    ? parseInt(c.env.MESSAGE_SIZE_THRESHOLD, 10) : 102400; // 100KB default

  // Validate each message and extract sessionId
  let sessionId: string | null = null;
  for (const msg of body.messages) {
    if (!msg.messageId || typeof msg.messageId !== 'string') {
      throw errors.badRequest('Each message must have a messageId string');
    }
    if (!msg.sessionId || typeof msg.sessionId !== 'string') {
      throw errors.badRequest('Each message must have a sessionId string');
    }
    if (!msg.role || !validRoles.has(msg.role)) {
      throw errors.badRequest(`Invalid role "${msg.role}". Must be one of: user, assistant, system, tool, thinking, plan`);
    }
    if (!msg.content || typeof msg.content !== 'string') {
      throw errors.badRequest('Each message must have non-empty content');
    }
    if (msg.content.length > maxMessageBytes) {
      throw errors.badRequest(`Individual message content exceeds ${maxMessageBytes} byte limit`);
    }
    if (!msg.timestamp || typeof msg.timestamp !== 'string') {
      throw errors.badRequest('Each message must have a timestamp string');
    }

    if (sessionId === null) {
      sessionId = msg.sessionId;
    } else if (msg.sessionId !== sessionId) {
      throw errors.badRequest('All messages in a batch must target the same sessionId');
    }
  }

  // Resolve workspace to project and validate session linkage (Principle XIII: Fail-Fast)
  const db = drizzle(c.env.DATABASE, { schema });
  const workspaceRows = await db
    .select({
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }
  if (!workspace.projectId) {
    throw errors.badRequest('Workspace is not linked to a project');
  }

  // Validate session ID matches workspace's linked session.
  // If the workspace has a chatSessionId, messages MUST target that session.
  // Messages targeting a different session are rejected to prevent misrouting.
  if (workspace.chatSessionId && workspace.chatSessionId !== sessionId) {
    const context = {
      workspaceId,
      projectId: workspace.projectId,
      expectedSessionId: workspace.chatSessionId,
      receivedSessionId: sessionId,
      messageCount: body.messages.length,
      action: 'rejected_batch',
    };
    console.error('Message routing mismatch: workspace linked to different session', context);
    c.executionCtx.waitUntil(
      persistError(c.env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Message routing mismatch: workspace ${workspaceId} linked to session ${workspace.chatSessionId}, but messages target ${sessionId}`,
        context,
        workspaceId,
      })
    );
    throw errors.badRequest(
      `Session mismatch: workspace is linked to session ${workspace.chatSessionId}, ` +
      `but messages target session ${sessionId}`
    );
  }

  // Reject messages when workspace has no linked chatSessionId.
  // This prevents misrouting during the session linking window where
  // chatSessionId is NULL between workspace creation and ensureSessionLinked().
  if (!workspace.chatSessionId) {
    const context = {
      workspaceId,
      projectId: workspace.projectId,
      providedSessionId: sessionId,
      messageCount: body.messages.length,
      action: 'rejected_no_session_link',
    };
    console.warn('Rejecting messages: workspace has no linked chatSessionId', context);
    c.executionCtx.waitUntil(
      persistError(c.env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: `Rejecting messages for workspace ${workspaceId}: no chatSessionId linked yet`,
        context,
        workspaceId,
      })
    );
    // Use 409 Conflict (not 400) so the VM agent's outbox retries the batch.
    // This is a transient condition: chatSessionId will be set once ensureSessionLinked() completes.
    throw errors.conflict(
      'Workspace has no linked chat session yet — messages cannot be routed safely'
    );
  }

  // Delegate to ProjectData DO
  const result = await projectDataService.persistMessageBatch(
    c.env,
    workspace.projectId,
    sessionId!,
    body.messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      toolMetadata: m.toolMetadata ? safeParseJson(m.toolMetadata) : null,
      timestamp: m.timestamp,
      sequence: m.sequence,
    }))
  );

  return c.json({
    persisted: result.persisted,
    duplicates: result.duplicates,
  });
});

// Legacy compatibility endpoint for node-side bootstrap exchange.
// This route requires BOTH user session auth AND callback token auth
// (it was not in the original auth skip list in workspaces.ts).
runtimeRoutes.post('/:id/bootstrap-token', requireAuth(), requireApproved(), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const bootstrapToken = ulid();
  const now = new Date().toISOString();
  const data: BootstrapTokenData = {
    workspaceId,
    encryptedHetznerToken: '',
    hetznerTokenIv: '',
    callbackToken: '',
    encryptedGithubToken: null,
    githubTokenIv: null,
    gitUserName: null,
    gitUserEmail: null,
    createdAt: now,
  };

  await c.env.KV.put(`bootstrap:${bootstrapToken}`, JSON.stringify(data), {
    expirationTtl: 60,
  });

  return c.json({ token: bootstrapToken });
});

export { runtimeRoutes };
