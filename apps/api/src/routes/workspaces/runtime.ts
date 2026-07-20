// FILE SIZE EXCEPTION: Workspace runtime routes — splitting credential resolution logic across files increases fragmentation risk. See .claude/rules/18-file-size-limits.md
import {
  AI_PROXY_DEFAULT_MODEL_KV_KEY,
  type AIProxyConfig,
  type BootstrapTokenData,
  DEFAULT_AI_PROXY_ANTHROPIC_MODEL,
  DEFAULT_AI_PROXY_MODEL,
  DEFAULT_AI_PROXY_OPENAI_MODEL,
  getAgentDefinition,
  HARNESS_CAPABILITIES,
  isValidAgentType,
  resolveHarnessDialect,
} from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  AgentCredentialSyncSchema,
  AgentTypeBodySchema,
  BootLogEntrySchema,
  formatIssues,
  jsonValidator,
  MessageBatchSchema,
} from '../../schemas';
import { appendBootLog } from '../../services/boot-log';
import { syncActiveAgentCredentialSecret } from '../../services/composable-credentials/agent-sync';
import { decrypt, encrypt } from '../../services/encryption';
import { getInstallationToken, getUserInstallationRepositories } from '../../services/github-app';
import {
  GitHubCliPolicyError,
  resolveWorkspaceGitHubTokenOptions,
} from '../../services/github-cli-policy';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { backfillProjectGithubRepoId } from '../../services/github-repo-id-backfill';
import { getGitHubUserAccessTokenForOwner } from '../../services/github-user-access-token';
import {
  getProjectGitLabRepository,
  requireGitLabUserAccessTokenResultForOwner,
  verifyGitLabProjectAccess,
} from '../../services/gitlab';
import { persistError } from '../../services/observability';
import { resolveProjectAgentDefault } from '../../services/project-agent-defaults';
import * as projectDataService from '../../services/project-data';
import { extractScalewaySecretKey } from '../../services/provider-credentials';
import { bridgeAgentActivity } from '../../services/trial/bridge';
import { getWorkspaceRuntimeAssets } from '../../services/workspace-runtime-assets';
import { getDecryptedAgentKey, getDecryptedCredential } from '../credentials';
import { assertRepositoryAccess } from '../projects/_helpers';
import { safeParseJson, verifyWorkspaceCallbackAuth } from './_helpers';

/** Agent types eligible for AI proxy credential fallback (module-scope for isolate reuse). */
const PROXY_ELIGIBLE_AGENTS: ReadonlySet<string> = new Set(
  HARNESS_CAPABILITIES.filter(
    (capability) => capability.proxyRouteSegment && capability.proxyProviderTag
  ).map((capability) => capability.agentType)
);

function getProxyCapability(agentType: string) {
  const capability = HARNESS_CAPABILITIES.find((entry) => entry.agentType === agentType);
  if (!capability?.proxyRouteSegment || !capability.proxyProviderTag) return null;
  return capability;
}

function buildPassthroughInferenceConfig(input: {
  agentType: string;
  baseDomain: string;
  defaultModel: string;
}) {
  const capability = getProxyCapability(input.agentType);
  if (!capability) return null;
  return {
    provider: capability.proxyProviderTag,
    baseURL: `https://api.${input.baseDomain}/ai/proxy/{wstoken}/${capability.proxyRouteSegment}`,
    model: input.defaultModel,
    apiKeySource: 'callback-token' as const,
  };
}

function buildPlatformInferenceConfig(input: {
  agentType: string;
  baseDomain: string;
  defaultModel: string;
}) {
  const capability = getProxyCapability(input.agentType);
  if (!capability) return null;
  const provider =
    capability.proxyProviderTag === 'anthropic-passthrough'
      ? 'anthropic-proxy'
      : capability.usesOpencodeConfig
        ? 'openai-compatible'
        : 'openai-proxy';
  const routeSegment = capability.proxyRouteSegment === 'anthropic' ? 'anthropic' : 'v1';
  return {
    provider,
    baseURL: `https://api.${input.baseDomain}/ai/${routeSegment}`,
    model: input.defaultModel,
    apiKeySource: 'callback-token' as const,
  };
}

const runtimeRoutes = new Hono<{ Bindings: Env }>();
type RuntimeContext = Context<{ Bindings: Env }>;
type MessageBatchBody = v.InferOutput<typeof MessageBatchSchema>;

const DEFAULT_MAX_MESSAGES_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MESSAGE_SIZE_THRESHOLD_BYTES = 102400;
const ACTIVE_MESSAGE_WORKSPACE_STATUSES = new Set(['creating', 'running', 'recovery']);
const VALID_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool', 'thinking', 'plan']);

type MessageWorkspace = {
  projectId: string | null;
  chatSessionId: string | null;
  status: string;
};

type MessageBatchPersistenceRouteResult = {
  persisted: number;
  duplicates: number;
  limitReached?: boolean;
  maxMessages?: number;
  remainingCapacity?: number;
};

type MessageRouteContext = {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  messageCount: number;
};

function waitUntilIfAvailable(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  promise: Promise<unknown> | void
): void {
  if (!promise) return;
  try {
    c.executionCtx.waitUntil(promise);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('no ExecutionContext')) {
      throw err;
    }
  }
}

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw errors.badRequest('Invalid Content-Length header');
    }
    if (contentLength > maxBytes) {
      throw errors.badRequest(`Payload exceeds ${maxBytes} byte limit`);
    }
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let done = false;

  try {
    while (!done) {
      const read = await reader.read();
      done = read.done;
      if (done) continue;
      const { value } = read;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw errors.badRequest(`Payload exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function parseMessageBatchRequest(c: RuntimeContext): Promise<MessageBatchBody> {
  const maxPayloadBytes = parsePositiveInt(
    c.env.MAX_MESSAGES_PAYLOAD_BYTES as string,
    DEFAULT_MAX_MESSAGES_PAYLOAD_BYTES
  );
  const rawBody = await readRequestBodyWithLimit(c.req.raw, maxPayloadBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw errors.badRequest('Invalid JSON in request body');
  }

  const result = v.safeParse(MessageBatchSchema, parsed);
  if (!result.success) {
    throw errors.badRequest(formatIssues(result.issues));
  }
  return result.output;
}

function resolveMaxMessageBytes(env: Env): number {
  return env.MESSAGE_SIZE_THRESHOLD
    ? Number.parseInt(env.MESSAGE_SIZE_THRESHOLD, 10)
    : DEFAULT_MESSAGE_SIZE_THRESHOLD_BYTES;
}

function validateMessageEntry(
  msg: MessageBatchBody['messages'][number],
  maxMessageBytes: number
): void {
  if (!msg.messageId) {
    throw errors.badRequest('Each message must have a messageId string');
  }
  if (!msg.sessionId) {
    throw errors.badRequest('Each message must have a sessionId string');
  }
  if (!msg.role || !VALID_MESSAGE_ROLES.has(msg.role)) {
    throw errors.badRequest(
      `Invalid role "${msg.role}". Must be one of: user, assistant, system, tool, thinking, plan`
    );
  }
  if (!msg.content) {
    throw errors.badRequest('Each message must have non-empty content');
  }
  if (msg.content.length > maxMessageBytes) {
    throw errors.badRequest(`Individual message content exceeds ${maxMessageBytes} byte limit`);
  }
  if (!msg.timestamp) {
    throw errors.badRequest('Each message must have a timestamp string');
  }
}

function validateMessageBatch(env: Env, body: MessageBatchBody): string {
  if (body.messages.length === 0) {
    throw errors.badRequest('messages array must not be empty');
  }
  const maxMessagesPerBatch = parsePositiveInt(env.MAX_MESSAGES_PER_BATCH, 100);
  if (body.messages.length > maxMessagesPerBatch) {
    throw errors.badRequest(`Maximum ${maxMessagesPerBatch} messages per batch`);
  }

  const firstMessage = body.messages[0];
  if (!firstMessage) {
    throw errors.badRequest('messages array must not be empty');
  }
  const maxMessageBytes = resolveMaxMessageBytes(env);
  const sessionId = firstMessage.sessionId;
  for (const msg of body.messages) {
    validateMessageEntry(msg, maxMessageBytes);
    if (msg.sessionId !== sessionId) {
      throw errors.badRequest('All messages in a batch must target the same sessionId');
    }
  }
  return sessionId;
}

async function loadMessageWorkspace(
  env: Env,
  workspaceId: string
): Promise<MessageWorkspace | null> {
  const db = drizzle(env.DATABASE, { schema });
  const workspaceRows = await db
    .select({
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return workspaceRows[0] ?? null;
}

function rejectInactiveMessageWorkspace(
  c: RuntimeContext,
  context: MessageRouteContext,
  status: string
): never {
  const logContext = {
    ...context,
    status,
    action: 'rejected_inactive_workspace',
  };
  log.warn('message_persistence.inactive_workspace', logContext);
  waitUntilIfAvailable(
    c,
    persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'warn',
      message: `Rejecting messages for inactive workspace ${context.workspaceId}`,
      context: logContext,
      workspaceId: context.workspaceId,
    })
  );
  throw errors.badRequest(`Workspace is ${status}, not active`);
}

function rejectMessageSessionMismatch(
  c: RuntimeContext,
  context: MessageRouteContext,
  expectedSessionId: string
): never {
  const logContext = {
    ...context,
    expectedSessionId,
    receivedSessionId: context.sessionId,
    action: 'rejected_batch',
  };
  log.error('message_routing.session_mismatch', logContext);
  waitUntilIfAvailable(
    c,
    persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message: `Message routing mismatch: workspace ${context.workspaceId} linked to session ${expectedSessionId}, but messages target ${context.sessionId}`,
      context: logContext,
      workspaceId: context.workspaceId,
    })
  );
  throw errors.badRequest(
    `Session mismatch: workspace is linked to session ${expectedSessionId}, ` +
      `but messages target session ${context.sessionId}`
  );
}

function rejectWorkspaceWithoutChatSession(c: RuntimeContext, context: MessageRouteContext): never {
  const logContext = {
    ...context,
    providedSessionId: context.sessionId,
    action: 'rejected_no_session_link',
  };
  log.warn('message_routing.no_chat_session_linked', logContext);
  waitUntilIfAvailable(
    c,
    persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'warn',
      message: `Rejecting messages for workspace ${context.workspaceId}: no chatSessionId linked yet`,
      context: logContext,
      workspaceId: context.workspaceId,
    })
  );
  throw errors.conflict(
    'Workspace has no linked chat session yet — messages cannot be routed safely'
  );
}

function assertMessageWorkspaceAcceptsBatch(
  c: RuntimeContext,
  workspace: MessageWorkspace | null,
  workspaceId: string,
  sessionId: string,
  messageCount: number
): asserts workspace is MessageWorkspace & { projectId: string; chatSessionId: string } {
  if (!workspace) {
    throw errors.notFound('Workspace');
  }
  if (!workspace.projectId) {
    throw errors.badRequest('Workspace is not linked to a project');
  }

  const context: MessageRouteContext = {
    workspaceId,
    projectId: workspace.projectId,
    sessionId,
    messageCount,
  };
  if (!ACTIVE_MESSAGE_WORKSPACE_STATUSES.has(workspace.status)) {
    rejectInactiveMessageWorkspace(c, context, workspace.status);
  }
  if (workspace.chatSessionId && workspace.chatSessionId !== sessionId) {
    rejectMessageSessionMismatch(c, context, workspace.chatSessionId);
  }
  if (!workspace.chatSessionId) {
    rejectWorkspaceWithoutChatSession(c, context);
  }
}

function toProjectDataMessages(body: MessageBatchBody) {
  return body.messages.map((m) => ({
    messageId: m.messageId,
    role: m.role,
    content: m.content,
    toolMetadata: m.toolMetadata ? safeParseJson(m.toolMetadata) : null,
    timestamp: m.timestamp,
    sequence: m.sequence,
    origin: m.origin ?? null,
  }));
}

function sessionLimitReachedResponse(c: RuntimeContext, context: MessageRouteContext): Response {
  log.error('message_persistence.session_message_limit_exceeded', {
    ...context,
    action: 'rejected_session_message_limit',
  });
  waitUntilIfAvailable(
    c,
    persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message: `Session ${context.sessionId} has reached the message limit`,
      context: { ...context, action: 'rejected_session_message_limit' },
      workspaceId: context.workspaceId,
    })
  );
  return c.json(
    {
      error: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
      message: 'Session message limit reached; no additional messages can be persisted',
    },
    409
  );
}

function handleMessagePersistenceError(
  c: RuntimeContext,
  context: MessageRouteContext,
  err: unknown
): Response {
  const message = err instanceof Error ? err.message : 'Failed to persist messages';
  if (message.includes('SESSION_MESSAGE_LIMIT_EXCEEDED') || message.includes('message limit')) {
    return sessionLimitReachedResponse(c, context);
  }
  if (message.includes('not found') || message.includes('is stopped')) {
    log.error('message_persistence.rejected_by_do', {
      ...context,
      error: message,
      action: 'rejected_permanent',
    });
    throw errors.badRequest(message);
  }
  log.error('message_persistence.do_error_transient', {
    ...context,
    error: message,
    action: 'rejected_transient',
  });
  return c.json(
    { error: 'SERVICE_UNAVAILABLE', message: 'Message persistence temporarily unavailable' },
    503
  );
}

function partialSessionLimitResponse(
  c: RuntimeContext,
  context: MessageRouteContext,
  result: MessageBatchPersistenceRouteResult
): Response {
  const logContext = {
    ...context,
    persisted: result.persisted,
    duplicates: result.duplicates,
    maxMessages: result.maxMessages,
    remainingCapacity: result.remainingCapacity,
    action: 'partial_persist_session_message_limit',
  };
  log.error('message_persistence.session_message_limit_reached', logContext);
  waitUntilIfAvailable(
    c,
    persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message: `Session ${context.sessionId} reached the message limit while persisting a batch`,
      context: logContext,
      workspaceId: context.workspaceId,
    })
  );
  return c.json(
    {
      error: 'SESSION_MESSAGE_LIMIT_EXCEEDED',
      message: 'Session message limit reached; only part of the batch was persisted',
      persisted: result.persisted,
      duplicates: result.duplicates,
      maxMessages: result.maxMessages,
      remainingCapacity: result.remainingCapacity,
    },
    409
  );
}

function bridgePersistedAgentActivity(
  c: RuntimeContext,
  projectId: string,
  result: MessageBatchPersistenceRouteResult,
  body: MessageBatchBody
): void {
  if (result.persisted === 0) return;
  c.executionCtx.waitUntil(
    bridgeAgentActivity(
      c.env,
      projectId,
      body.messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolMetadata: m.toolMetadata ? safeParseJson(m.toolMetadata) : undefined,
      }))
    )
  );
}

async function verifyWorkspaceGitHubOwnerAccess(input: {
  env: Env;
  workspaceId: string;
  projectId: string | null;
  userId: string;
  repository: string;
  externalInstallationId: string;
  githubRepoId: number | null;
}): Promise<number> {
  const accessToken = await getGitHubUserAccessTokenForOwner(
    input.env,
    input.userId,
    'workspace-git-token'
  );
  if (!accessToken) {
    log.warn('workspace_git_token_user_access_missing', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      action: 'rejected',
    });
    throw errors.forbidden('GitHub user token unavailable');
  }

  const verifiedRepo = await assertRepositoryAccess(
    accessToken,
    input.externalInstallationId,
    input.repository,
    input.userId,
    'project-access'
  );

  if (input.githubRepoId !== null && verifiedRepo.id !== input.githubRepoId) {
    log.warn('workspace_git_token_repo_id_drift', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      expectedRepoId: input.githubRepoId,
      verifiedRepoId: verifiedRepo.id,
      action: 'rejected',
    });
    throw errors.forbidden('GitHub repository access has changed; repository ID no longer matches');
  }

  return verifiedRepo.id;
}

/**
 * Resolve numeric repository IDs for a project's additional Repository Access
 * entries, re-verifying user∩app access at the token-mint boundary. Stored rows
 * whose access has been revoked (or whose installation no longer exposes them)
 * are dropped from the scope — an unselected/inaccessible repo simply never makes
 * it into the minted token's `repository_ids`, so it fails clearly downstream.
 * Failure to fetch the accessible set returns the empty set rather than throwing,
 * so the primary-repo token still mints (additional repos degrade, never break
 * the primary clone).
 */
async function resolveAdditionalRepositoryIds(input: {
  env: Env;
  db: ReturnType<typeof drizzle<typeof schema>>;
  workspaceId: string;
  projectId: string;
  userId: string;
  externalInstallationId: string;
}): Promise<number[]> {
  const rows = await input.db
    .select({
      repository: schema.projectGithubRepositories.repository,
      githubRepoId: schema.projectGithubRepositories.githubRepoId,
    })
    .from(schema.projectGithubRepositories)
    .where(
      eq(schema.projectGithubRepositories.projectId, input.projectId)
    );
  if (rows.length === 0) {
    return [];
  }

  const accessToken = await getGitHubUserAccessTokenForOwner(
    input.env,
    input.userId,
    'workspace-git-token'
  );
  if (!accessToken) {
    log.warn('workspace_git_token_additional_repos_user_access_missing', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      action: 'additional_repos_skipped',
    });
    return [];
  }

  let accessibleById = new Map<string, number>();
  try {
    const repositories = await getUserInstallationRepositories(
      accessToken,
      input.externalInstallationId,
      {
        flow: 'project-access',
        userId: input.userId,
        installationId: input.externalInstallationId,
      }
    );
    accessibleById = new Map(repositories.map((r) => [r.fullName.toLowerCase(), r.id]));
  } catch (err) {
    log.warn('workspace_git_token_additional_repos_unavailable', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
      action: 'additional_repos_skipped',
    });
    return [];
  }

  const ids: number[] = [];
  for (const row of rows) {
    const accessibleId = accessibleById.get(row.repository.toLowerCase());
    if (accessibleId === undefined) {
      log.warn('workspace_git_token_additional_repo_access_revoked', {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        userId: input.userId,
        repository: row.repository,
        action: 'excluded_from_scope',
      });
      continue;
    }
    // Prefer the live, rename-stable id from the accessible set. Stored ids can
    // drift if the repo was deleted/recreated; the live id is authoritative.
    ids.push(accessibleId);
  }
  return ids;
}

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

  // OpenCode always uses a user-supplied credential (zen/go/custom). It never
  // routes through the SAM platform proxy, so it always requires a dedicated key.
  const opencodeRequiresDedicatedCredential = body.agentType === 'opencode';

  const encryptionKey = getCredentialEncryptionKey(c.env);
  let credentialData = await getDecryptedAgentKey(
    db,
    workspace.userId,
    body.agentType,
    encryptionKey,
    workspace.projectId
  );

  // SECURITY: Never return raw platform-managed credentials to tenant workspaces.
  // Platform credentials are control-plane secrets and must only be used via
  // SAM-mediated proxy flows (callback-token auth), not injected into tenant
  // containers as env vars or auth files.
  if (credentialData?.credentialSource === 'platform') {
    credentialData = null;
  }

  // Cloud provider credential fallback: if no dedicated agent key, check if the agent
  // definition specifies a cloud provider whose credential can be used instead.
  const agentDef = isValidAgentType(body.agentType)
    ? getAgentDefinition(body.agentType)
    : undefined;
  const fallbackCloudProvider = agentDef?.fallbackCloudProvider;
  if (!credentialData && fallbackCloudProvider) {
    const scalewayToken = await getDecryptedCredential(
      db,
      workspace.userId,
      fallbackCloudProvider,
      encryptionKey
    );
    if (scalewayToken) {
      const secretKey = extractScalewaySecretKey(scalewayToken);
      if (secretKey) {
        credentialData = {
          credential: secretKey,
          credentialKind: 'api-key',
          credentialSource: 'user',
        };
      } else {
        log.warn('agent_key.scaleway_credential_missing_secret_key', {
          workspaceId,
          userId: workspace.userId,
          agentType: body.agentType,
        });
      }
    }
  }

  if (credentialData && opencodeRequiresDedicatedCredential) {
    return c.json({
      apiKey: credentialData.credential,
      credentialKind: credentialData.credentialKind,
    });
  }

  if (!credentialData && opencodeRequiresDedicatedCredential) {
    log.info('agent_key.opencode_byo_provider_missing_credential', {
      workspaceId,
      userId: workspace.userId,
      agentType: body.agentType,
    });
    throw errors.notFound('Agent credential');
  }

  // AI proxy: when enabled and agent is eligible, return proxy config when the
  // credential can be forwarded to the upstream provider.
  // Two modes:
  // - Claude/Codex with no user credential + providerMode='sam' → platform proxy (callback-token auth)
  // - User has upstream-compatible credential → passthrough proxy (user credential
  //   forwarded via auth headers, wstoken in URL path for analytics/rate-limiting)
  // Note: platform proxy fallback requires explicit provider selection.
  // Without it, users with no credential get a 404 (agent not configured).
  const aiProxyEnabled = (c.env.AI_PROXY_ENABLED ?? 'true') !== 'false';
  if (PROXY_ELIGIBLE_AGENTS.has(body.agentType) && aiProxyEnabled) {
    const baseDomain = c.env.BASE_DOMAIN;
    const isClaudeCode = body.agentType === 'claude-code';
    const isCodex = body.agentType === 'openai-codex';
    let explicitProviderMode: string | null | undefined;
    const getExplicitProviderMode = async (): Promise<string | null> => {
      if (explicitProviderMode !== undefined) return explicitProviderMode;
      const settingsRows = await db
        .select({ providerMode: schema.agentSettings.providerMode })
        .from(schema.agentSettings)
        .where(
          and(
            eq(schema.agentSettings.userId, workspace.userId),
            eq(schema.agentSettings.agentType, body.agentType)
          )
        )
        .limit(1);
      explicitProviderMode = settingsRows[0]?.providerMode ?? null;
      return explicitProviderMode;
    };

    // Resolve default model: KV (admin-set) > env var > shared constant
    let defaultModel: string;
    if (isClaudeCode) {
      defaultModel = c.env.AI_PROXY_DEFAULT_ANTHROPIC_MODEL ?? DEFAULT_AI_PROXY_ANTHROPIC_MODEL;
    } else if (isCodex) {
      defaultModel = c.env.AI_PROXY_DEFAULT_OPENAI_MODEL ?? DEFAULT_AI_PROXY_OPENAI_MODEL;
    } else {
      defaultModel = c.env.AI_PROXY_DEFAULT_MODEL ?? DEFAULT_AI_PROXY_MODEL;
      try {
        const kvConfig = await c.env.KV.get(AI_PROXY_DEFAULT_MODEL_KV_KEY);
        if (kvConfig) {
          const parsed: AIProxyConfig = JSON.parse(kvConfig);
          if (parsed.defaultModel) defaultModel = parsed.defaultModel;
        }
      } catch {
        /* KV unavailable or corrupt data — use env/default */
      }
    }

    // Claude Code/Codex explicit SAM mode must route through the SAM proxy,
    // not through legacy platform agent credentials as user-style passthrough.
    if ((isClaudeCode || isCodex) && credentialData?.credentialSource === 'platform') {
      credentialData = null;
    }

    if (
      credentialData &&
      credentialData.baseUrl &&
      credentialData.providerDialect &&
      resolveHarnessDialect(body.agentType, credentialData.providerDialect) &&
      !((isClaudeCode || isCodex) && credentialData.credentialKind === 'oauth-token')
    ) {
      // User has their own credential — use passthrough proxy routes.
      // URL-path auth: wstoken embedded in URL, user credential in auth headers.
      const inferenceConfig = buildPassthroughInferenceConfig({
        agentType: body.agentType,
        baseDomain,
        defaultModel,
      });
      if (!inferenceConfig) {
        throw errors.notFound('Agent credential');
      }

      log.info('agent_key.ai_proxy_passthrough', {
        workspaceId,
        userId: workspace.userId,
        proxyBaseUrl: inferenceConfig.baseURL,
        agentType: body.agentType,
      });

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
          .set({ agentCredentialSource: credentialData.credentialSource })
          .where(eq(schema.tasks.id, task.id));
      }

      return c.json({
        apiKey: '__sam_proxy__',
        credentialKind: credentialData.credentialKind,
        credentialSource: credentialData.credentialSource,
        inferenceConfig,
      });
    }

    if (credentialData?.baseUrl) {
      log.warn('agent_key.ai_proxy_incompatible_passthrough_credential', {
        workspaceId,
        userId: workspace.userId,
        agentType: body.agentType,
        providerDialect: credentialData.providerDialect ?? null,
      });
      throw errors.notFound('Agent credential');
    }

    if (credentialData) {
      return c.json({
        apiKey: credentialData.credential,
        credentialKind: credentialData.credentialKind,
      });
    }

    // Claude Code and Codex require an explicit SAM provider selection before
    // using platform proxy. OpenCode never reaches this block — it always
    // requires a dedicated user credential and returns/throws above.
    if (isClaudeCode || isCodex) {
      const providerMode = await getExplicitProviderMode();

      if (providerMode !== 'sam') {
        log.info('agent_key.no_credential_no_sam_provider', {
          workspaceId,
          userId: workspace.userId,
          agentType: body.agentType,
          providerMode,
        });
        throw errors.notFound('Agent credential');
      }
    }

    // Activate platform proxy.
    // Auth via callback token in headers.
    const inferenceConfig = buildPlatformInferenceConfig({
      agentType: body.agentType,
      baseDomain,
      defaultModel,
    });
    if (!inferenceConfig) {
      throw errors.notFound('Agent credential');
    }

    log.info('agent_key.ai_proxy_sam_provider', {
      workspaceId,
      userId: workspace.userId,
      proxyBaseUrl: inferenceConfig.baseURL,
      agentType: body.agentType,
    });

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
      inferenceConfig,
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
runtimeRoutes.post(
  '/:id/agent-credential-sync',
  jsonValidator(AgentCredentialSyncSchema),
  async (c) => {
    const workspaceId = c.req.param('id');
    await verifyWorkspaceCallbackAuth(c, workspaceId);

    // Payload size check (64KB default — auth.json files are typically a few KB).
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    const maxPayloadBytes = parsePositiveInt(
      c.env.MAX_AGENT_CREDENTIAL_SYNC_BYTES as string,
      64 * 1024
    );
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

    await syncActiveAgentCredentialSecret(c.env.DATABASE, {
      userId: workspace.userId,
      projectId: existing.projectId,
      agentType,
      credentialKind,
      encryptedToken: ciphertext,
      iv,
    });

    log.info('agent_credential_sync.credential_updated', {
      workspaceId,
      agentType,
      credentialKind,
      credentialId: existing.id,
    });

    return c.json({ success: true, updated: true });
  }
);

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
  const agentSessionId = c.req.query('agentSessionId')?.trim() || null;
  const assets = await getWorkspaceRuntimeAssets(
    db,
    { workspaceId, agentSessionId },
    getCredentialEncryptionKey(c.env)
  );
  return c.json(assets);
});

runtimeRoutes.post('/:id/git-token', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  // Look up workspace → project to determine repo provider
  const workspaceRows = await db
    .select({
      id: schema.workspaces.id,
      installationId: schema.workspaces.installationId,
      projectId: schema.workspaces.projectId,
      userId: schema.workspaces.userId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  // Look up the project to check repoProvider
  let repoProvider = 'github';
  let artifactsRepoId: string | null = null;
  let githubRepoId: number | null = null;
  let repositoryName: string | null = null;
  if (workspace.projectId) {
    const projectRows = await db
      .select({
        repoProvider: schema.projects.repoProvider,
        artifactsRepoId: schema.projects.artifactsRepoId,
        githubRepoId: schema.projects.githubRepoId,
        repository: schema.projects.repository,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, workspace.projectId))
      .limit(1);

    const project = projectRows[0];
    if (project) {
      repoProvider = project.repoProvider || 'github';
      artifactsRepoId = project.artifactsRepoId;
      githubRepoId = project.githubRepoId;
      repositoryName = project.repository;
    }
  }

  if (repoProvider === 'artifacts') {
    // ─── Artifacts token ──────────────────────────────────────────────
    if (c.env.ARTIFACTS_ENABLED !== 'true') {
      throw errors.forbidden('Artifacts provider is not enabled');
    }
    if (!c.env.ARTIFACTS || !artifactsRepoId) {
      throw errors.internal('Artifacts binding or repo ID missing');
    }

    // Clamp the token TTL to a sane range: a negative/zero/NaN or excessively
    // large configured value must not mint a token that never expires (or expires
    // instantly). Default 1h; hard cap 24h.
    const rawTtl = Number.parseInt(c.env.ARTIFACTS_TOKEN_TTL_SECONDS || '', 10);
    const ttl = Number.isFinite(rawTtl) && rawTtl > 0 && rawTtl <= 86400 ? rawTtl : 3600;
    // Use requested scope or default to 'write' (agents need push access)
    const requestedScope = c.req.query('scope') === 'read' ? ('read' as const) : ('write' as const);
    const repo = await c.env.ARTIFACTS.get(artifactsRepoId);
    const tokenResult = await repo.createToken(requestedScope, ttl);

    // Strip ?expires= suffix from token for git credential use
    const tokenSecret = tokenResult.plaintext.split('?expires=')[0] || tokenResult.plaintext;

    // Prefer the stored project.repository as the clone URL: it is `created.remote`
    // captured at project creation and is exactly what the VM agent cloned, so its
    // host is guaranteed to match what git requests from the credential helper. The
    // Artifacts binding's `get().remote` has been observed to come back empty on
    // staging (unlike `create().remote`); when that happens an empty cloneUrl makes
    // the VM agent default the credential host to github.com, which then fails to
    // match the real Artifacts host and returns no credential (git fetch/push break).
    const cloneUrl = repositoryName || repo.remote || '';
    if (!repo.remote) {
      log.warn('workspace_git_token.artifacts_remote_empty', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        artifactsRepoId,
        usedStoredRepository: !!repositoryName,
        action: 'fell_back_to_stored_repository',
      });
    }
    if (!cloneUrl) {
      log.error('workspace_git_token.artifacts_clone_url_missing', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        artifactsRepoId,
        action: 'clone_url_empty',
      });
    }

    return c.json({
      token: tokenSecret,
      expiresAt: tokenResult.expiresAt ?? tokenResult.expires_at,
      cloneUrl,
    });
  }

  if (repoProvider === 'gitlab') {
    if (!workspace.projectId) {
      throw errors.forbidden('GitLab workspace has no project');
    }
    const metadata = await getProjectGitLabRepository(db, workspace.projectId);
    if (!metadata) {
      throw errors.forbidden('GitLab repository metadata is missing');
    }
    if (metadata.userId !== workspace.userId) {
      // The stored GitLab repo binding belongs to a different user than the
      // workspace owner — vending the owner's OAuth token against another
      // user's binding would cross a tenant boundary. Fail closed.
      log.error('workspace_git_token.gitlab_user_mismatch', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        workspaceUserId: workspace.userId,
        metadataUserId: metadata.userId,
        action: 'rejected',
      });
      throw errors.forbidden('GitLab repository is not linked for this workspace owner');
    }
    const tokenResult = await requireGitLabUserAccessTokenResultForOwner(
      c.env,
      workspace.userId,
      'workspace-git-token'
    );
    const verified = await verifyGitLabProjectAccess(
      c.env,
      tokenResult.accessToken,
      metadata.gitlabProjectId
    );
    if (
      verified.host !== metadata.host ||
      verified.gitlabProjectId !== metadata.gitlabProjectId ||
      verified.pathWithNamespace !== metadata.pathWithNamespace
    ) {
      throw errors.forbidden('GitLab repository access has changed; repository no longer matches');
    }

    return c.json({
      provider: 'gitlab',
      token: tokenResult.accessToken,
      expiresAt: tokenResult.accessTokenExpiresAt,
      cloneUrl: metadata.httpUrlToRepo,
      host: metadata.host,
      username: 'oauth2',
      repositoryPath: metadata.pathWithNamespace,
    });
  }

  // ─── GitHub token (existing flow) ──────────────────────────────────
  if (!workspace.installationId) {
    throw errors.notFound('Workspace has no GitHub installation');
  }
  // Scope the token to a single repo. Prefer the verified numeric repo ID; fall
  // back to the repository name for legacy projects created before github_repo_id
  // was backfilled (PR #1236). Both paths scope to exactly one repository, so the
  // personal-installation leak fix is preserved.
  const repoShortName =
    repositoryName && repositoryName.includes('/')
      ? (repositoryName.split('/').pop() ?? null)
      : repositoryName;
  if (!githubRepoId && !repoShortName) {
    throw errors.forbidden('GitHub repository is not verified for this workspace');
  }

  const installations = await db
    .select({
      installationId: schema.githubInstallations.installationId,
      externalInstallationId: schema.githubInstallations.externalInstallationId,
      userId: schema.githubInstallations.userId,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspace.installationId))
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    log.warn('workspace_git_token_installation_owner_mismatch', {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      installationRowId: workspace.installationId,
      expectedUserId: workspace.userId,
      action: 'rejected',
    });
    throw errors.notFound('GitHub installation');
  }
  if (installation.userId !== workspace.userId) {
    log.info('workspace_git_token_project_installation_shared', {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      installationRowId: workspace.installationId,
      workspaceUserId: workspace.userId,
      installationOwnerUserId: installation.userId,
      action: 'allowed_after_user_access_verification',
    });
  }

  if (!repositoryName) {
    throw errors.forbidden('GitHub repository is not verified for this workspace');
  }

  const verifiedRepoId = await verifyWorkspaceGitHubOwnerAccess({
    env: c.env,
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    userId: workspace.userId,
    repository: repositoryName,
    externalInstallationId: getExternalInstallationId(installation),
    githubRepoId,
  });

  // Lazy self-heal: legacy projects created before the numeric repo id was
  // captured have github_repo_id = null. Fetch + persist it now, BEFORE policy
  // resolution, so custom GitHub CLI policies (which require the numeric id) work
  // and scoping uses the rename-stable repositoryIds path. On any failure we fall
  // through to the name-based fallback below (no regression).
  if (!githubRepoId && repositoryName && workspace.projectId) {
    const backfill = await backfillProjectGithubRepoId(db, c.env, {
      projectId: workspace.projectId,
      repository: repositoryName,
      externalInstallationId: getExternalInstallationId(installation),
    });
    if (backfill.githubRepoId) {
      githubRepoId = backfill.githubRepoId;
    }
  }
  githubRepoId ??= verifiedRepoId;

  let tokenOptions = null;
  try {
    tokenOptions = await resolveWorkspaceGitHubTokenOptions(db, {
      workspaceId: workspace.id,
      userId: workspace.userId,
      githubRepoId,
    });
  } catch (err) {
    if (err instanceof GitHubCliPolicyError) {
      throw errors.forbidden('GitHub CLI policy prevents token minting');
    }
    throw err;
  }
  // Additional Repository Access: same-installation repos selected in Project
  // Settings. Re-verified at this boundary; revoked/inaccessible entries are
  // dropped from the scope. Primary repo is always included implicitly.
  const additionalRepoIds =
    githubRepoId && workspace.projectId
      ? await resolveAdditionalRepositoryIds({
          env: c.env,
          db,
          workspaceId: workspace.id,
          projectId: workspace.projectId,
          userId: workspace.userId,
          externalInstallationId: getExternalInstallationId(installation),
        })
      : [];

  const scopedTokenOptions = {
    ...(tokenOptions ?? {}),
    ...(githubRepoId
      ? { repositoryIds: [githubRepoId, ...additionalRepoIds.filter((id) => id !== githubRepoId)] }
      : { repositories: [repoShortName as string] }),
  };
  const token = await getInstallationToken(
    getExternalInstallationId(installation),
    c.env,
    scopedTokenOptions
  );
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
runtimeRoutes.post('/:id/messages', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const body = await parseMessageBatchRequest(c);
  const sessionId = validateMessageBatch(c.env, body);

  // Resolve workspace to project and validate session linkage (Principle XIII: Fail-Fast)
  const workspace = await loadMessageWorkspace(c.env, workspaceId);
  assertMessageWorkspaceAcceptsBatch(c, workspace, workspaceId, sessionId, body.messages.length);

  // Delegate to ProjectData DO with structured error handling.
  // On failure, return appropriate status codes so the VM agent outbox
  // can distinguish transient (retry) from permanent (discard) errors.
  const context: MessageRouteContext = {
    workspaceId,
    projectId: workspace.projectId,
    sessionId,
    messageCount: body.messages.length,
  };
  let result: MessageBatchPersistenceRouteResult;
  try {
    result = await projectDataService.persistMessageBatch(
      c.env,
      workspace.projectId,
      sessionId,
      toProjectDataMessages(body)
    );
  } catch (err) {
    return handleMessagePersistenceError(c, context, err);
  }

  if (result.limitReached) {
    return partialSessionLimitResponse(c, context, result);
  }

  // Fire-and-forget: pipe agent activity to the trial SSE feed (if this
  // workspace belongs to a trial project). Non-trial projects short-circuit
  // with a single KV lookup inside the bridge.
  bridgePersistedAgentActivity(c, workspace.projectId, result, body);

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
    encryptedCallbackToken: '',
    callbackTokenIv: '',
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
