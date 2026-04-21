import { AI_PROXY_DEFAULT_MODEL_KV_KEY, type AIProxyConfig, type BootstrapTokenData, DEFAULT_AI_PROXY_MODEL, getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { AgentCredentialSyncSchema, AgentTypeBodySchema, BootLogEntrySchema, jsonValidator, MessageBatchSchema } from '../../schemas';
import { appendBootLog } from '../../services/boot-log';
import { decrypt, encrypt } from '../../services/encryption';
import { getInstallationToken } from '../../services/github-app';
import { persistError } from '../../services/observability';
import { resolveProjectAgentDefault } from '../../services/project-agent-defaults';
import * as projectDataService from '../../services/project-data';
import { bridgeAgentActivity } from '../../services/trial/bridge';
import { extractScalewaySecretKey } from '../../services/provider-credentials';
import { getDecryptedAgentKey, getDecryptedCredential } from '../credentials';
import {
  getWorkspaceRuntimeAssets,
  safeParseJson,
  verifyWorkspaceCallbackAuth,
} from './_helpers';

const runtimeRoutes = new Hono<{ Bindings: Env }>();

runtimeRoutes.post('/:id/agent-key', jsonValidator(AgentTypeBodySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = c.req.valid('json');

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId, projectId: schema.workspaces.projectId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const encryptionKey = getCredentialEncryptionKey(c.env);
  let credentialData = await getDecryptedAgentKey(
    db,
    workspace.userId,
    body.agentType,
    encryptionKey,
    workspace.projectId
  );

  // Cloud provider credential fallback: if no dedicated agent key, check if the agent
  // definition specifies a cloud provider whose credential can be used instead.
  // Currently applies to OpenCode, which shares SCW_SECRET_KEY with Scaleway cloud.
  const agentDef = isValidAgentType(body.agentType) ? getAgentDefinition(body.agentType) : undefined;
  if (!credentialData && agentDef?.fallbackCloudProvider) {
    const scalewayToken = await getDecryptedCredential(db, workspace.userId, agentDef.fallbackCloudProvider, encryptionKey);
    if (scalewayToken) {
      const secretKey = extractScalewaySecretKey(scalewayToken);
      if (secretKey) {
        credentialData = { credential: secretKey, credentialKind: 'api-key', credentialSource: 'user' };
      } else {
        log.warn('agent_key.scaleway_credential_missing_secret_key', { workspaceId, userId: workspace.userId, agentType: body.agentType });
      }
    }
  }

  // AI proxy fallback: if no user credential and the AI proxy is enabled,
  // return platform inference config so the VM agent can use the proxy.
  // Only applies to OpenCode — the proxy uses Workers AI for inference.
  const aiProxyEnabled = (c.env.AI_PROXY_ENABLED ?? 'true') !== 'false';
  if (!credentialData && body.agentType === 'opencode' && aiProxyEnabled) {
    const baseDomain = c.env.BASE_DOMAIN;
    const proxyBaseUrl = `https://api.${baseDomain}/ai/v1`;

    // Resolve default model: KV (admin-set) > env var > shared constant
    let defaultModel = c.env.AI_PROXY_DEFAULT_MODEL ?? DEFAULT_AI_PROXY_MODEL;
    try {
      const kvConfig = await c.env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
      if (kvConfig) {
        const parsed: AIProxyConfig = JSON.parse(kvConfig);
        if (parsed.defaultModel) defaultModel = parsed.defaultModel;
      }
    } catch { /* KV unavailable or corrupt data — use env/default */ }

    log.info('agent_key.ai_proxy_fallback', { workspaceId, userId: workspace.userId, proxyBaseUrl });

    // Track credential source on associated task
    const taskRows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.workspaceId, workspaceId))
      .limit(1);
    const task = taskRows[0];
    if (task) {
      await db
        .update(schema.tasks)
        .set({ agentCredentialSource: 'platform' })
        .where(eq(schema.tasks.id, task.id));
    }

    return c.json({
      apiKey: '__platform_proxy__',
      credentialKind: 'api-key' as const,
      credentialSource: 'platform' as const,
      inferenceConfig: {
        provider: 'openai-compatible',
        baseURL: proxyBaseUrl,
        model: defaultModel,
        apiKeySource: 'callback-token',
      },
    });
  }

  if (!credentialData) {
    throw errors.notFound('Agent credential');
  }

  // Track credential source on associated task if applicable
  if (credentialData.credentialSource === 'platform') {
    const taskRows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.workspaceId, workspaceId))
      .limit(1);
    const task = taskRows[0];
    if (task) {
      await db
        .update(schema.tasks)
        .set({ agentCredentialSource: 'platform' })
        .where(eq(schema.tasks.id, task.id));
    }
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
runtimeRoutes.post('/:id/agent-credential-sync', jsonValidator(AgentCredentialSyncSchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  // Payload size check (64KB default — auth.json files are typically a few KB).
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  const maxPayloadBytes = parsePositiveInt(c.env.MAX_AGENT_CREDENTIAL_SYNC_BYTES as string, 64 * 1024);
  if (contentLength > maxPayloadBytes) {
    throw errors.badRequest(`Payload exceeds ${maxPayloadBytes} byte limit`);
  }

  const body = c.req.valid('json');
  const agentType = body.agentType;
  const credentialKind = body.credentialKind;

  // Validate against known values. Use the shared catalog so new agents
  // are accepted automatically without a manual allowlist update.
  const validCredentialKinds = new Set(['api-key', 'oauth-token']);
  if (!agentType || !isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agentType');
  }
  if (!credentialKind || !validCredentialKinds.has(credentialKind)) {
    throw errors.badRequest('Invalid credentialKind');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  // Look up the workspace to get the user ID and project ID.
  const workspaceRows = await db
    .select({ userId: schema.workspaces.userId, projectId: schema.workspaces.projectId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  // Find the existing credential row to update. Prefer project-scoped match
  // when the workspace is in a project; fall back to user-scoped only when
  // there is no project-scoped row at all.
  //
  // Match the same HIGH #2 invariant enforced by runtime credential delivery
  // and CodexRefreshLock: if a project-scoped row exists but is inactive, do
  // NOT fall through to the user-scoped row. That would silently collapse a
  // project override back onto the user default during post-session refresh sync.
  let existing: typeof schema.credentials.$inferSelect | undefined;
  if (workspace.projectId) {
    const projectMatch = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, workspace.userId),
          eq(schema.credentials.projectId, workspace.projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType),
          eq(schema.credentials.credentialKind, credentialKind)
        )
      )
      .limit(1);
    const projectCredential = projectMatch[0];
    if (projectCredential) {
      if (projectCredential.isActive) {
        existing = projectCredential;
      } else {
        return c.json({ success: false, reason: 'credential_not_found' });
      }
    }
  }
  if (!existing) {
    const userMatch = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, workspace.userId),
          isNull(schema.credentials.projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType),
          eq(schema.credentials.credentialKind, credentialKind),
          eq(schema.credentials.isActive, true)
        )
      )
      .limit(1);
    existing = userMatch[0];
  }
  if (!existing) {
    // No credential found — the user may have deleted it while the session was active.
    return c.json({ success: false, reason: 'credential_not_found' });
  }

  // Decrypt the current credential to compare.
  const currentCredential = await decrypt(
    existing.encryptedToken,
    existing.iv,
    getCredentialEncryptionKey(c.env)
  );

  // Only update if the credential has actually changed.
  if (currentCredential === body.credential) {
    return c.json({ success: true, updated: false });
  }

  // Re-encrypt with a fresh IV and update.
  const { ciphertext, iv } = await encrypt(body.credential, getCredentialEncryptionKey(c.env));
  await db
    .update(schema.credentials)
    .set({
      encryptedToken: ciphertext,
      iv,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.credentials.id, existing.id));

  log.info('agent_credential_sync.credential_updated', {
    workspaceId,
    agentType,
    credentialKind,
    credentialId: existing.id,
  });

  return c.json({ success: true, updated: true });
});

/**
 * POST /:id/agent-settings — VM agent callback to fetch user's agent settings.
 * Uses workspace callback auth (same as agent-key).
 */
runtimeRoutes.post('/:id/agent-settings', jsonValidator(AgentTypeBodySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const body = c.req.valid('json');

  const db = drizzle(c.env.DATABASE, { schema });

  const workspaceRows = await db
    .select({
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

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

  // Resolution: project.agentDefaults[agentType] > user agent_settings > null.
  // OpenCode-specific provider/baseUrl stay user-scoped (phase 1 does not include them).
  return c.json({
    model: projectDefaults.model ?? userRow?.model ?? null,
    permissionMode: projectDefaults.permissionMode ?? userRow?.permissionMode ?? null,
    opencodeProvider: userRow?.opencodeProvider ?? null,
    opencodeBaseUrl: userRow?.opencodeBaseUrl ?? null,
    opencodeProviderName: userRow?.opencodeProviderName ?? null,
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
  const assets = await getWorkspaceRuntimeAssets(db, workspaceId, getCredentialEncryptionKey(c.env));
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

runtimeRoutes.post('/:id/boot-log', jsonValidator(BootLogEntrySchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = c.req.valid('json');

  const entry = {
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
runtimeRoutes.post('/:id/messages', jsonValidator(MessageBatchSchema), async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  // Payload size check (256KB default, configurable via MAX_MESSAGES_PAYLOAD_BYTES)
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  const maxPayloadBytes = parsePositiveInt(c.env.MAX_MESSAGES_PAYLOAD_BYTES as string, 256 * 1024);
  if (contentLength > maxPayloadBytes) {
    throw errors.badRequest(`Payload exceeds ${maxPayloadBytes} byte limit`);
  }

  const body = c.req.valid('json');

  if (body.messages.length === 0) {
    throw errors.badRequest('messages array must not be empty');
  }
  const maxMessagesPerBatch = parsePositiveInt(c.env.MAX_MESSAGES_PER_BATCH as string, 100);
  if (body.messages.length > maxMessagesPerBatch) {
    throw errors.badRequest(`Maximum ${maxMessagesPerBatch} messages per batch`);
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
    log.error('message_routing.session_mismatch', context);
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
    log.warn('message_routing.no_chat_session_linked', context);
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

  // Delegate to ProjectData DO with structured error handling.
  // On failure, return appropriate status codes so the VM agent outbox
  // can distinguish transient (retry) from permanent (discard) errors.
  let result: { persisted: number; duplicates: number };
  try {
    result = await projectDataService.persistMessageBatch(
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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to persist messages';

    // Session-not-found and stopped-session errors are permanent — do not retry
    if (message.includes('not found') || message.includes('is stopped')) {
      log.error('message_persistence.rejected_by_do', {
        workspaceId,
        projectId: workspace.projectId,
        sessionId,
        error: message,
        action: 'rejected_permanent',
      });
      throw errors.badRequest(message);
    }

    // All other DO errors are transient — return 503 so the outbox retries
    log.error('message_persistence.do_error_transient', {
      workspaceId,
      projectId: workspace.projectId,
      sessionId,
      error: message,
      action: 'rejected_transient',
    });
    return c.json(
      { error: 'SERVICE_UNAVAILABLE', message: 'Message persistence temporarily unavailable' },
      503
    );
  }

  // Fire-and-forget: pipe agent activity to the trial SSE feed (if this
  // workspace belongs to a trial project). Non-trial projects short-circuit
  // with a single KV lookup inside the bridge.
  if (workspace.projectId && result.persisted > 0) {
    c.executionCtx.waitUntil(
      bridgeAgentActivity(
        c.env,
        workspace.projectId,
        body.messages.map((m) => ({
          role: m.role,
          content: m.content,
          toolMetadata: m.toolMetadata ? safeParseJson(m.toolMetadata) : undefined,
        })),
      ),
    );
  }

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
