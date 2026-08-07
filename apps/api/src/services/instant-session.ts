import type { AgentProfileRuntime, TaskMode } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { and, eq, notInArray } from 'drizzle-orm';
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
  taskMode?: TaskMode;
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

export interface AcceptedInstantSession {
  taskId: string;
  runtime: AgentProfileRuntime;
  nodeId: string;
  workspaceId: string;
  projectId: string;
  chatSessionId: string;
  agentType: string;
  containerId: string;
  workspaceUrl: string;
  branch: string;
  workspaceName: string;
  workspaceDir: string;
  nodeCallbackToken: string;
  startedAt: number;
  gitSource: Awaited<ReturnType<typeof resolveWorkspaceGitSource>>;
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

export async function acceptInstantSession(
  db: Db,
  env: Env,
  input: LaunchInstantSessionInput
): Promise<AcceptedInstantSession> {
  requireVmAgentContainer(env);

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

  const nodeId = node.id;
  const workspaceId = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId,
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
    .set({ chatSessionId, workspaceId, autoProvisionedNodeId: nodeId, updatedAt: now })
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
  const workspaceDir = containerWorkspaceDir(env, input.project.repository);

  return {
    taskId: input.taskId,
    runtime: 'cf-container',
    nodeId,
    workspaceId,
    projectId: input.project.id,
    chatSessionId,
    agentType: input.agentType,
    containerId,
    workspaceUrl: `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`,
    branch,
    workspaceName,
    workspaceDir,
    nodeCallbackToken,
    startedAt,
    gitSource,
  };
}

/**
 * Milestone hooks for a durable launch driver (TaskRunner DO). The driver
 * persists progress at the agent-bootstrap boundary so an interrupted attempt
 * can be classified on retry: before `beforeAgentBootstrap` the container can
 * be torn down safely; after `afterAgentBootstrap` the agent is live and only
 * the idempotent finalize writes remain.
 */
export interface InstantLaunchHooks {
  beforeAgentBootstrap?: () => Promise<void>;
  afterAgentBootstrap?: (agentSessionId: string) => Promise<void>;
}

/** Identity refs needed to fail-and-clean-up a launch without its live promise. */
export interface InstantLaunchFailureRef {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  containerId: string;
}

export async function continueInstantSessionLaunch(
  db: Db,
  env: Env,
  input: LaunchInstantSessionInput,
  accepted: AcceptedInstantSession,
  hooks?: InstantLaunchHooks
): Promise<LaunchInstantSessionResult> {
  requireVmAgentContainer(env);

  const config = getVmAgentContainerConfig(env);
  const taskMode = input.taskMode ?? 'conversation';
  const {
    nodeId,
    workspaceId,
    chatSessionId,
    containerId,
    branch,
    workspaceName,
    workspaceDir,
    nodeCallbackToken,
    gitSource,
    startedAt,
  } = accepted;
  const vmAgentPort = config.vmAgentPort;
  const controlPlaneUrl = `https://api.${env.BASE_DOMAIN}`;
  const phaseDetail = { nodeId, workspaceId, containerId };

  try {
    const launchStart = Date.now();
    await runContainerPhase('launch', phaseDetail, () =>
      launchVmAgentContainer(
        env,
        nodeId,
        {
          nodeId,
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
      waitForNodeAgentReady(nodeId, env)
    );
    const agentReadyDurationMs = Date.now() - agentReadyStart;

    const workspaceCreateStart = Date.now();
    const workspaceCallbackToken = await signCallbackToken(workspaceId, env);
    await runContainerPhase('create_workspace', phaseDetail, () =>
      createWorkspaceOnNode(
        nodeId,
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
    await hooks?.beforeAgentBootstrap?.();
    const bootstrapResult = await startSamAwareAgentSession(db, env, {
      nodeId,
      workspaceId,
      projectId: input.project.id,
      userId: input.userId,
      chatSessionId,
      label: workspaceName,
      agentType: input.agentType,
      agentProfileId: input.agentProfileId ?? null,
      skillId: input.skillId ?? null,
      visibleInitialPrompt: input.initialPrompt,
      promptKind: taskMode === 'task' ? 'task' : 'conversation',
      taskContext: { taskId: input.taskId, taskMode },
      overrides: input.overrides,
      // The LAUNCH now runs durably in the TaskRunner DO (instant-launch.ts),
      // but task-mode Instant sessions still lack the TaskRunner execution-
      // timeout watchdog for the RUNTIME phase after agent_running. Keep that
      // gap tracked by idea 01KXZNPR69JGK7S99KMPFCRZWJ plus
      // tasks/backlog/2026-07-19-instant-session-capacity-controls.md.
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

    await hooks?.afterAgentBootstrap?.(bootstrapResult.agentSessionId);

    await finalizeInstantLaunch(db, input.taskId, workspaceId, nodeId);

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
      nodeId,
      workspaceId,
      projectId: input.project.id,
      chatSessionId,
      agentSessionId: bootstrapResult.agentSessionId,
      acpSessionId: bootstrapResult.acpSessionId ?? bootstrapResult.agentSessionId,
      agentType: input.agentType,
      containerId,
      processId: containerId,
      runtime: 'cf-container',
      workspaceUrl: accepted.workspaceUrl,
      timings,
    };
  } catch (err) {
    await markInstantLaunchFailed(
      db,
      env,
      {
        taskId: input.taskId,
        projectId: input.project.id,
        chatSessionId,
        workspaceId,
        nodeId,
        containerId,
      },
      errorMessage(err)
    );
    throw err;
  }
}

/**
 * Idempotent success tail of an instant launch: mark the workspace dispatched
 * and advance the task queued -> in_progress/agent_running. Guarded on
 * status='queued' so a concurrent terminal transition (e.g. the stuck-task
 * sweep failing an over-deadline launch and destroying its container) is never
 * resurrected by a late finalize.
 */
export async function finalizeInstantLaunch(
  db: Db,
  taskId: string,
  workspaceId: string,
  nodeId: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  const updated = await db
    .update(schema.tasks)
    .set({
      status: 'in_progress',
      executionStep: 'agent_running',
      workspaceId,
      autoProvisionedNodeId: nodeId,
      updatedAt: nowIso,
    })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'queued')));
  // Defensive meta access mirrors services/bootstrap.ts: only a driver that
  // affirmatively reports zero changed rows is treated as a conflict.
  const changes = typeof updated?.meta?.changes === 'number' ? updated.meta.changes : 1;
  if (changes === 0) {
    log.warn('instant_session.finalize_conflict', {
      taskId,
      workspaceId,
      nodeId,
      message: 'Task left queued state before finalize; skipping in_progress transition',
    });
    return;
  }
  await db
    .update(schema.workspaces)
    .set({ dispatchedAt: nowIso, updatedAt: nowIso })
    .where(eq(schema.workspaces.id, workspaceId));
}

/**
 * Mark a failed or interrupted instant launch terminally failed and tear down
 * everything it created: task -> failed (never clobbering an already-terminal
 * row), chat session -> failed (UI-visible), workspace + node -> error,
 * lingering running agent_sessions rows -> error, and destroy the container.
 * Every step is individually guarded so partial teardown still proceeds.
 *
 * Callable without the live launch promise: the TaskRunner DO uses it when it
 * finds an attempt that died mid-flight (rule 43 — the job-owned context, not
 * the original HTTP request, owns failure-marking).
 */
export async function markInstantLaunchFailed(
  db: Db,
  env: Env,
  ref: InstantLaunchFailureRef,
  message: string
): Promise<void> {
  const failedAt = new Date().toISOString();
  await db
    .update(schema.tasks)
    .set({
      status: 'failed',
      executionStep: 'launch_failed',
      errorMessage: message,
      completedAt: failedAt,
      workspaceId: ref.workspaceId,
      autoProvisionedNodeId: ref.nodeId,
      updatedAt: failedAt,
    })
    .where(
      and(
        eq(schema.tasks.id, ref.taskId),
        notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled'])
      )
    )
    .catch((updateErr) => {
      log.warn('instant_session.task_error_update_failed', {
        taskId: ref.taskId,
        error: errorMessage(updateErr),
      });
    });
  await db
    .update(schema.agentSessions)
    .set({ status: 'error', errorMessage: message, stoppedAt: failedAt, updatedAt: failedAt })
    .where(
      and(
        eq(schema.agentSessions.workspaceId, ref.workspaceId),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .catch((updateErr) => {
      log.warn('instant_session.agent_session_error_update_failed', {
        workspaceId: ref.workspaceId,
        error: errorMessage(updateErr),
      });
    });
  await projectDataService
    .failSession(env, ref.projectId, ref.chatSessionId, message)
    .catch((updateErr) => {
      log.warn('instant_session.chat_error_update_failed', {
        taskId: ref.taskId,
        chatSessionId: ref.chatSessionId,
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
    .where(eq(schema.workspaces.id, ref.workspaceId))
    .catch((updateErr) => {
      log.warn('instant_session.workspace_error_update_failed', {
        workspaceId: ref.workspaceId,
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
    .where(eq(schema.nodes.id, ref.nodeId))
    .catch((updateErr) => {
      log.warn('instant_session.node_error_update_failed', {
        nodeId: ref.nodeId,
        error: errorMessage(updateErr),
      });
    });
  await destroyVmAgentContainer(env, ref.containerId).catch((destroyErr) => {
    log.error('instant_session.container_destroy_after_failure_failed', {
      nodeId: ref.nodeId,
      workspaceId: ref.workspaceId,
      containerId: ref.containerId,
      error: errorMessage(destroyErr),
    });
  });
}
