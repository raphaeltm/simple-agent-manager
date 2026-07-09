import type { AgentProfileRuntime } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
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
import {
  getSandboxConfig,
  getSandboxInstance,
  requireSandbox,
  runSandboxPhase,
  shellQuote,
} from './sandbox';
import { truncateTitle } from './task-title';

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
  sandboxId: string;
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

  const rawName = repo
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/i, '')
    .trim();
  const safeName = rawName?.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return safeName || 'workspace';
}

function sandboxWorkspaceBaseDir(env: Env): string {
  const configured = env.SANDBOX_WORKSPACE_BASE_DIR?.trim().replace(/\/+$/g, '');
  return configured || '/workspaces';
}

function sandboxWorkspaceDir(env: Env, repository: string): string {
  const baseDir = sandboxWorkspaceBaseDir(env);
  const repoDir = repositoryDirectoryName(repository);
  return baseDir === '/' ? `/${repoDir}` : `${baseDir}/${repoDir}`;
}

export async function launchInstantSession(
  db: Db,
  env: Env,
  input: LaunchInstantSessionInput
): Promise<LaunchInstantSessionResult> {
  requireSandbox(env);

  const config = getSandboxConfig(env);
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
      ? parseInt(env.NODE_HEARTBEAT_STALE_SECONDS, 10)
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

  const sandboxId = node.id.toLowerCase();
  const sandbox = await getSandboxInstance(env, sandboxId);
  const nodeCallbackToken = await signNodeCallbackToken(node.id, env);
  const vmAgentPort = env.SANDBOX_VM_AGENT_PORT ? parseInt(env.SANDBOX_VM_AGENT_PORT, 10) : 8080;
  const controlPlaneUrl = `https://api.${env.BASE_DOMAIN}`;
  const phaseDetail = { nodeId: node.id, workspaceId, sandboxId };
  const workspaceDir = sandboxWorkspaceDir(env, input.project.repository);

  const installStart = Date.now();
  const install = await runSandboxPhase('install', phaseDetail, () =>
    sandbox.exec(
      [
        'set -e',
        `mkdir -p ${shellQuote(workspaceDir)} /var/lib/vm-agent`,
        `curl -fsSL "${controlPlaneUrl}/api/agent/download?os=linux&arch=amd64" -o /usr/local/bin/vm-agent.tmp`,
        'chmod +x /usr/local/bin/vm-agent.tmp',
        'mv /usr/local/bin/vm-agent.tmp /usr/local/bin/vm-agent',
        '/usr/local/bin/vm-agent --help >/dev/null 2>&1 || true',
        'ls -l /usr/local/bin/vm-agent',
      ].join('\n'),
      { timeout: config.execTimeoutMs }
    )
  );
  const installDurationMs = Date.now() - installStart;
  if (!install.success) {
    throw errors.internal(`vm-agent install failed: ${install.stderr || install.stdout}`);
  }

  const standaloneEnv = {
    NODE_ROLE: 'standalone',
    NODE_ID: node.id,
    WORKSPACE_ID: workspaceId,
    PROJECT_ID: input.project.id,
    CHAT_SESSION_ID: chatSessionId,
    CONTROL_PLANE_URL: controlPlaneUrl,
    CALLBACK_TOKEN: nodeCallbackToken,
    REPOSITORY: input.project.repository,
    BRANCH: branch,
    WORKSPACE_DIR: workspaceDir,
    CONTAINER_WORK_DIR: workspaceDir,
    CONTAINER_MODE: 'false',
    PORT_SCAN_ENABLED: 'false',
    VM_AGENT_PORT: String(vmAgentPort),
    VM_AGENT_PROTOCOL: 'http',
    COOKIE_SECURE: 'true',
  };
  const processId = `vm-agent-${node.id.toLowerCase()}`;
  const envAssignments = Object.entries(standaloneEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const start = await runSandboxPhase('start', phaseDetail, () =>
    sandbox.exec(
      [
        'set -e',
        'test -x /usr/local/bin/vm-agent',
        `cd ${shellQuote(workspaceDir)}`,
        `nohup env ${envAssignments} /usr/local/bin/vm-agent > /tmp/vm-agent.log 2>&1 &`,
        'pid=$!',
        `echo "$pid" > ${shellQuote(`/tmp/${processId}.pid`)}`,
        'sleep 0.2',
        'if ! kill -0 "$pid" 2>/dev/null; then cat /tmp/vm-agent.log >&2 || true; exit 1; fi',
        'echo "$pid"',
      ].join('\n'),
      { timeout: config.execTimeoutMs }
    )
  );
  if (!start.success) {
    throw errors.internal(`vm-agent start failed: ${start.stderr || start.stdout}`);
  }

  const agentReadyStart = Date.now();
  await runSandboxPhase('wait_for_ready', phaseDetail, () => waitForNodeAgentReady(node.id, env));
  const agentReadyDurationMs = Date.now() - agentReadyStart;

  const workspaceCreateStart = Date.now();
  const workspaceCallbackToken = await signCallbackToken(workspaceId, env);
  await runSandboxPhase('create_workspace', phaseDetail, () =>
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

    await runSandboxPhase('create_vm_agent_session', phaseDetail, () =>
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

  const acpSession = await runSandboxPhase('create_acp_session', phaseDetail, () =>
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
  await runSandboxPhase('assign_acp_session', phaseDetail, () =>
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
  await runSandboxPhase('start_acp_session', phaseDetail, () =>
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
  await runSandboxPhase('mark_acp_session_running', phaseDetail, () =>
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
    sandboxId,
    processId,
    runtime: 'cf-container',
    workspaceUrl: `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`,
    timings: {
      setupDurationMs: Date.now() - startedAt,
      installDurationMs,
      agentReadyDurationMs,
      workspaceCreateDurationMs,
      acpSessionCreateDurationMs,
      acpSessionStartDurationMs,
    },
  };
}
