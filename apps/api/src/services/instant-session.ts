import type { AgentProfileRuntime } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { startSamAwareAgentSession } from './agent-session-bootstrap';
import { signCallbackToken, signNodeCallbackToken } from './jwt';
import {
  type AgentSessionOverrides,
  createWorkspaceOnNode,
  getCfContainerCreateWorkspaceTimeoutMs,
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
import { resolveWorkspaceGitSource } from './workspace-git-source';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface LaunchInstantSessionInput {
  taskId: string;
  project: schema.Project;
  userId: string;
  initialPrompt: string;
  displayMessage?: string | null;
  contextSummary?: string | null;
  agentType: string;
  agentProfileId?: string | null;
  skillId?: string | null;
  branch?: string | null;
  workspaceName?: string | null;
  overrides?: AgentSessionOverrides;
}

export interface LaunchInstantSessionResult {
  taskId: string;
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
    totalDurationMs: number;
    preContainerDurationMs: number;
    containerLaunchDurationMs: number;
    /** @deprecated backward-compat alias for totalDurationMs; prefer totalDurationMs. */
    setupDurationMs: number;
    /** @deprecated backward-compat alias for containerLaunchDurationMs; prefer containerLaunchDurationMs. */
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
    [...value].map((char) => (isRepositoryDirectoryChar(char) ? char : '-')).join('')
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

  const rawName = stripGitSuffix(repo ? lastNonEmptyPathSegment(repo) : '').trim();
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
  const gitSource = await resolveWorkspaceGitSource(db, input.project);

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
    input.taskId,
    input.userId
  );
  await db
    .update(schema.tasks)
    .set({ chatSessionId, workspaceId, autoProvisionedNodeId: node.id, updatedAt: now })
    .where(eq(schema.tasks.id, input.taskId));
  if (input.contextSummary) {
    await projectDataService.persistMessage(
      env,
      input.project.id,
      chatSessionId,
      'system',
      input.contextSummary,
      null
    );
  }
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
    await runContainerPhase('wait_for_ready', phaseDetail, () =>
      waitForNodeAgentReady(node.id, env)
    );
    const agentReadyDurationMs = Date.now() - agentReadyStart;

    const workspaceCreateStart = Date.now();
    const workspaceCallbackToken = await signCallbackToken(workspaceId, env);
    await runContainerPhase('create_workspace', phaseDetail, () =>
      createWorkspaceOnNode(
        node.id,
        env,
        input.userId,
        {
          workspaceId,
          repository: input.project.repository,
          branch,
          repoProvider: gitSource.repoProvider,
          cloneUrl: gitSource.cloneUrl,
          repositoryHost: gitSource.repositoryHost,
          repositoryPath: gitSource.repositoryPath,
          callbackToken: workspaceCallbackToken,
          lightweight: true,
        },
        // The standalone vm-agent clones the repository synchronously inside
        // this request, so it gets the cf-container create budget instead of
        // the interactive node-agent default.
        { requestTimeoutMs: getCfContainerCreateWorkspaceTimeoutMs(env) }
      )
    );
    const workspaceCreateDurationMs = Date.now() - workspaceCreateStart;

    const acpSessionCreateStart = Date.now();
    const phaseDurations = new Map<string, number>();
    const bootstrapResult = await startSamAwareAgentSession(db, env, {
      nodeId: node.id,
      workspaceId,
      projectId: input.project.id,
      userId: input.userId,
      chatSessionId,
      label: workspaceName,
      agentType: input.agentType,
      agentProfileId: input.agentProfileId ?? null,
      skillId: input.skillId ?? null,
      visibleInitialPrompt: input.initialPrompt,
      promptKind: 'conversation',
      taskContext: { taskId: input.taskId, taskMode: 'conversation' },
      overrides: input.overrides,
      actor: {
        type: 'system',
        id: input.userId,
        reasonPrefix: 'CF container instant session',
      },
      runPhase: async (name, fn) => {
        const phaseStart = Date.now();
        const result = await runContainerPhase(name, phaseDetail, fn);
        phaseDurations.set(name, Date.now() - phaseStart);
        return result;
      },
    });
    if (input.agentProfileId || input.skillId) {
      await db
        .update(schema.agentSessions)
        .set({
          agentProfileId: input.agentProfileId ?? null,
          skillId: input.skillId ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agentSessions.id, bootstrapResult.agentSessionId));
    }
    const acpSessionCreateDurationMs = Date.now() - acpSessionCreateStart;
    const acpSessionStartDurationMs =
      (phaseDurations.get('start_acp_session') ?? 0) +
      (phaseDurations.get('mark_acp_session_running') ?? 0);

    await db
      .update(schema.workspaces)
      .set({ dispatchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspaceId));

    await db
      .update(schema.tasks)
      .set({
        status: 'in_progress',
        executionStep: 'agent_running',
        workspaceId,
        autoProvisionedNodeId: node.id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.id, input.taskId));

    const totalDurationMs = Date.now() - startedAt;
    const preContainerDurationMs = launchStart - startedAt;
    const timings = {
      totalDurationMs,
      preContainerDurationMs,
      containerLaunchDurationMs: launchDurationMs,
      setupDurationMs: totalDurationMs,
      installDurationMs: launchDurationMs,
      agentReadyDurationMs,
      workspaceCreateDurationMs,
      acpSessionCreateDurationMs,
      acpSessionStartDurationMs,
    };
    log.info('instant_session.cold_start_complete', { ...phaseDetail, ...timings });

    return {
      taskId: input.taskId,
      nodeId: node.id,
      workspaceId,
      projectId: input.project.id,
      chatSessionId,
      agentSessionId: bootstrapResult.agentSessionId,
      acpSessionId: bootstrapResult.acpSessionId ?? bootstrapResult.agentSessionId,
      agentType: input.agentType,
      containerId,
      processId: containerId,
      runtime: 'cf-container',
      workspaceUrl: `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`,
      timings,
    };
  } catch (err) {
    const message = errorMessage(err);
    const failedAt = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        executionStep: 'launch_failed',
        errorMessage: message,
        workspaceId,
        autoProvisionedNodeId: node.id,
        updatedAt: failedAt,
      })
      .where(eq(schema.tasks.id, input.taskId))
      .catch((updateErr) => {
        log.warn('instant_session.task_error_update_failed', {
          taskId: input.taskId,
          error: errorMessage(updateErr),
        });
      });
    await projectDataService
      .failSession(env, input.project.id, chatSessionId, message)
      .catch((updateErr) => {
        log.warn('instant_session.chat_error_update_failed', {
          taskId: input.taskId,
          chatSessionId,
          error: errorMessage(updateErr),
        });
      });
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
