import type { AgentProfileRuntime } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { signCallbackToken, signNodeCallbackToken } from './jwt';
import { generateMcpToken, revokeMcpToken, storeMcpToken } from './mcp-token';
import {
  type AgentSessionOverrides,
  createAgentSessionOnNode,
  createWorkspaceOnNode,
  startAgentSessionOnNode,
  waitForNodeAgentReady,
} from './node-agent';
import { createNodeRecord } from './nodes';
import * as projectDataService from './project-data';
import { truncateTitle } from './task-title';
import {
  destroyVmAgentContainer,
  getVmAgentContainerConfig,
  launchVmAgentContainer,
  requireVmAgentContainer,
  runContainerPhase,
} from './vm-agent-container';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface LaunchInstantSessionInput {
  project: schema.Project;
  userId: string;
  initialPrompt: string;
  displayMessage?: string | null;
  agentType: string;
  agentProfileId?: string | null;
  skillId?: string | null;
  branch?: string | null;
  workspaceName?: string | null;
  overrides?: AgentSessionOverrides;
}

export interface LaunchInstantSessionResult {
  runtime: AgentProfileRuntime;
  nodeId: string;
  workspaceId: string;
  projectId: string;
  chatSessionId: string;
  agentSessionId: string;
  acpSessionId: string;
  agentType: string;
  containerId: string;
  processId: string;
  workspaceUrl: string;
  timings: {
    setupDurationMs: number;
    installDurationMs: number;
    agentReadyDurationMs: number;
    workspaceCreateDurationMs: number;
    acpSessionCreateDurationMs: number;
    acpSessionStartDurationMs: number;
  };
}

function normalizeWorkspaceName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function stripGitSuffix(value: string): string {
  return value.toLowerCase().endsWith('.git') ? value.slice(0, -4) : value;
}

function isRepositoryDirectoryChar(char: string): boolean {
  return /^[a-zA-Z0-9._-]$/.test(char);
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function toSafeRepositoryDirectoryName(value: string): string {
  return trimDashes(
    [...value]
      .map((char) => isRepositoryDirectoryChar(char) ? char : '-')
      .join('')
  );
}

function lastNonEmptyPathSegment(value: string): string {
  const parts = value.split('/');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const segment = parts[index];
    if (segment) {
      return segment;
    }
  }
  return '';
}

function getWorkspaceName(input: LaunchInstantSessionInput): string {
  const requested = input.workspaceName?.trim();
  if (requested) return requested;
  const source = input.displayMessage?.trim() || input.initialPrompt;
  return truncateTitle(source, DEFAULT_TASK_TITLE_MAX_LENGTH) || 'Instant Chat';
}

function repositoryDirectoryName(repository: string): string {
  let repo = repository.trim();
  if (!repo) return 'workspace';

  if (repo.includes('://')) {
    try {
      repo = new URL(repo).pathname;
    } catch {
      // Fall back to path splitting below.
    }
  }

  const rawName = stripGitSuffix(repo
    ? lastNonEmptyPathSegment(repo)
    : ''
  ).trim();
  const safeName = toSafeRepositoryDirectoryName(rawName);
  return safeName || 'workspace';
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function containerWorkspaceBaseDir(env: Env): string {
  const configured = stripTrailingSlashes(
    (env.CF_CONTAINER_WORKSPACE_BASE_DIR || env.SANDBOX_WORKSPACE_BASE_DIR)?.trim() ?? ''
  );
  return configured || '/workspaces';
}

function containerWorkspaceDir(env: Env, repository: string): string {
  const baseDir = containerWorkspaceBaseDir(env);
  const repoDir = repositoryDirectoryName(repository);
  return baseDir === '/' ? `/${repoDir}` : `${baseDir}/${repoDir}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function launchInstantSession(
  db: Db,
  env: Env,
  input: LaunchInstantSessionInput
): Promise<LaunchInstantSessionResult> {
  requireVmAgentContainer(env);

  const config = getVmAgentContainerConfig(env);
  const startedAt = Date.now();
  const branch = input.branch?.trim() || input.project.defaultBranch || 'main';
  const workspaceName = getWorkspaceName(input);

  const node = await createNodeRecord(env, {
    userId: input.userId,
    credentialAttributionUserId: input.userId,
    credentialAttributionSource: 'platform',
    name: `${workspaceName} Node`,
    vmSize: 'standard-1',
    vmLocation: 'cf-container',
    cloudProvider: 'cloudflare',
    heartbeatStaleAfterSeconds: env.NODE_HEARTBEAT_STALE_SECONDS
      ? Number.parseInt(env.NODE_HEARTBEAT_STALE_SECONDS, 10)
      : 180,
    runtime: 'cf-container',
  });

  const workspaceId = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId: node.id,
    projectId: input.project.id,
    userId: input.userId,
    installationId: input.project.installationId ?? undefined,
    name: workspaceName,
    displayName: workspaceName,
    normalizedDisplayName: normalizeWorkspaceName(workspaceName),
    repository: input.project.repository,
    branch,
    status: 'creating',
    vmSize: 'standard-1',
    vmLocation: 'cf-container',
    workspaceProfile: 'lightweight',
    agentProfileHint: input.agentProfileId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  const chatSessionId = await projectDataService.createSession(
    env,
    input.project.id,
    workspaceId,
    workspaceName,
    null,
    input.userId
  );
  await projectDataService.persistMessage(
    env,
    input.project.id,
    chatSessionId,
    'user',
    input.displayMessage ?? input.initialPrompt,
    null
  );
  await db
    .update(schema.workspaces)
    .set({ chatSessionId, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  const containerId = node.id.toLowerCase();
  const nodeCallbackToken = await signNodeCallbackToken(node.id, env);
  const vmAgentPort = config.vmAgentPort;
  const controlPlaneUrl = `https://api.${env.BASE_DOMAIN}`;
  const phaseDetail = { nodeId: node.id, workspaceId, containerId };
  const workspaceDir = containerWorkspaceDir(env, input.project.repository);

  try {
    const launchStart = Date.now();
    await runContainerPhase('launch', phaseDetail, () =>
      launchVmAgentContainer(
        env,
        node.id,
        {
          nodeId: node.id,
          workspaceId,
          projectId: input.project.id,
          chatSessionId,
          repository: input.project.repository,
          branch,
          workspaceDir,
          controlPlaneUrl,
          vmAgentPort,
        },
        {
          nodeCallbackToken,
        }
      )
    );
    const launchDurationMs = Date.now() - launchStart;

    const agentReadyStart = Date.now();
    await runContainerPhase('wait_for_ready', phaseDetail, () => waitForNodeAgentReady(node.id, env));
    const agentReadyDurationMs = Date.now() - agentReadyStart;

    const workspaceCreateStart = Date.now();
    const workspaceCallbackToken = await signCallbackToken(workspaceId, env);
    await runContainerPhase('create_workspace', phaseDetail, () =>
      createWorkspaceOnNode(node.id, env, input.userId, {
        workspaceId,
        repository: input.project.repository,
        branch,
        callbackToken: workspaceCallbackToken,
        lightweight: true,
      })
    );
    const workspaceCreateDurationMs = Date.now() - workspaceCreateStart;

    const agentSessionId = ulid();
    const acpSessionCreateStart = Date.now();
    await db.insert(schema.agentSessions).values({
      id: agentSessionId,
      workspaceId,
      userId: input.userId,
      status: 'running',
      label: workspaceName,
      agentType: input.agentType,
      createdAt: now,
      updatedAt: now,
    });

    let mcpToken: string | null = null;
    try {
      const token = generateMcpToken();
      mcpToken = token;
      await storeMcpToken(
        env.KV,
        token,
        {
          taskId: '',
          projectId: input.project.id,
          userId: input.userId,
          workspaceId,
          chatSessionId,
          agentSessionId,
          createdAt: new Date().toISOString(),
        },
        env
      );

      await runContainerPhase('create_vm_agent_session', phaseDetail, () =>
        createAgentSessionOnNode(
          node.id,
          workspaceId,
          agentSessionId,
          workspaceName,
          env,
          input.userId,
          chatSessionId,
          input.project.id,
          {
            url: `https://api.${env.BASE_DOMAIN}/mcp`,
            token,
          }
        )
      );
    } catch (err) {
      if (mcpToken) {
        await revokeMcpToken(env.KV, mcpToken).catch(() => {});
      }
      await db
        .update(schema.agentSessions)
        .set({
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Failed to create agent session',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agentSessions.id, agentSessionId));
      throw err;
    }

    const acpSession = await runContainerPhase('create_acp_session', phaseDetail, () =>
      projectDataService.createAcpSession(
        env,
        input.project.id,
        chatSessionId,
        null,
        input.agentType,
        null,
        0,
        agentSessionId
      )
    );
    await runContainerPhase('assign_acp_session', phaseDetail, () =>
      projectDataService.transitionAcpSession(env, input.project.id, acpSession.id, 'assigned', {
        actorType: 'system',
        actorId: input.userId,
        reason: 'CF container instant session assigned',
        workspaceId,
        nodeId: node.id,
      })
    );
    const acpSessionCreateDurationMs = Date.now() - acpSessionCreateStart;

    const acpSessionStartStart = Date.now();
    await runContainerPhase('start_acp_session', phaseDetail, () =>
      startAgentSessionOnNode(
        node.id,
        workspaceId,
        agentSessionId,
        input.agentType,
        input.initialPrompt,
        env,
        input.userId,
        {
          url: `https://api.${env.BASE_DOMAIN}/mcp`,
          token: mcpToken,
        },
        input.overrides
      )
    );
    await runContainerPhase('mark_acp_session_running', phaseDetail, () =>
      projectDataService.transitionAcpSession(env, input.project.id, acpSession.id, 'running', {
        actorType: 'system',
        actorId: input.userId,
        reason: 'CF container instant session started',
        acpSdkSessionId: agentSessionId,
      })
    );
    const acpSessionStartDurationMs = Date.now() - acpSessionStartStart;

    await db
      .update(schema.workspaces)
      .set({ dispatchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspaceId));

    return {
      nodeId: node.id,
      workspaceId,
      projectId: input.project.id,
      chatSessionId,
      agentSessionId,
      acpSessionId: acpSession.id,
      agentType: input.agentType,
      containerId,
      processId: containerId,
      runtime: 'cf-container',
      workspaceUrl: `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`,
      timings: {
        setupDurationMs: Date.now() - startedAt,
        installDurationMs: launchDurationMs,
        agentReadyDurationMs,
        workspaceCreateDurationMs,
        acpSessionCreateDurationMs,
        acpSessionStartDurationMs,
      },
    };
  } catch (err) {
    const message = errorMessage(err);
    const failedAt = new Date().toISOString();
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: message,
        updatedAt: failedAt,
      })
      .where(eq(schema.workspaces.id, workspaceId))
      .catch((updateErr) => {
        log.warn('instant_session.workspace_error_update_failed', {
          workspaceId,
          error: errorMessage(updateErr),
        });
      });
    await db
      .update(schema.nodes)
      .set({
        status: 'error',
        healthStatus: 'unhealthy',
        errorMessage: message,
        updatedAt: failedAt,
      })
      .where(eq(schema.nodes.id, node.id))
      .catch((updateErr) => {
        log.warn('instant_session.node_error_update_failed', {
          nodeId: node.id,
          error: errorMessage(updateErr),
        });
      });
    await destroyVmAgentContainer(env, containerId).catch((destroyErr) => {
      log.error('instant_session.container_destroy_after_failure_failed', {
        nodeId: node.id,
        workspaceId,
        containerId,
        error: errorMessage(destroyErr),
      });
    });
    throw err;
  }
}
