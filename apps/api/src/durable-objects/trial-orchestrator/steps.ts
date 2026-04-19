/**
 * Step handlers for the TrialOrchestrator DO state machine.
 *
 * Mirrors TaskRunner's split (node-steps.ts + workspace-steps.ts) but consolidated
 * because the trial flow is narrower: no task lifecycle, no attachments, no
 * follow-ups. Each handler is idempotent and either advances to the next step
 * or schedules another poll via the DO alarm.
 *
 * Flow:
 *   project_creation
 *     → node_selection
 *        → (warm/existing node healthy) → workspace_creation
 *        → (no healthy node)            → node_provisioning → node_agent_ready → workspace_creation
 *     → workspace_creation → workspace_ready → discovery_agent_start → running
 *
 * Event emission: each handler fires a trial.progress event at the start so
 * the SSE stream reflects what the orchestrator is doing right now.
 */

import {
  DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { signCallbackToken } from '../../services/jwt';
import { getRuntimeLimits } from '../../services/limits';
import { generateMcpToken, storeMcpToken } from '../../services/mcp-token';
import {
  createAgentSessionOnNode,
  createWorkspaceOnNode,
  startAgentSessionOnNode,
} from '../../services/node-agent';
import { createNodeRecord, provisionNode } from '../../services/nodes';
import * as projectDataService from '../../services/project-data';
import { DISCOVERY_PROMPT } from '../../services/trial/discovery-prompt';
import { startDiscoveryAgent } from '../../services/trial/trial-runner';
import { readTrial, writeTrial } from '../../services/trial/trial-store';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import { verifyNodeAgentHealthy } from '../task-runner/node-steps';
import {
  parseEnvInt,
  resolveAnonymousInstallationId,
  resolveAnonymousUserId,
  safeEmitTrialEvent,
} from './helpers';
import type {
  TrialOrchestratorContext,
  TrialOrchestratorState,
} from './types';

/** Default trial workspace profile when TRIAL_DEFAULT_WORKSPACE_PROFILE is unset. */
const DEFAULT_TRIAL_WORKSPACE_PROFILE = 'lightweight';
/** Fallback branch when the GitHub default-branch probe fails or times out. */
const TRIAL_FALLBACK_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Helpers — trial KV upkeep
// ---------------------------------------------------------------------------

/**
 * Persist project/workspace ids back into the KV trial record. SSE `/events`
 * and `/claim` both read from KV, so the orchestrator MUST mirror its progress
 * there. Failures are logged but non-fatal — KV writes are best-effort.
 */
async function syncTrialRecord(
  rc: TrialOrchestratorContext,
  state: TrialOrchestratorState,
  patch: { projectId?: string; workspaceId?: string | null }
): Promise<void> {
  try {
    const record = await readTrial(rc.env, state.trialId);
    if (!record) return;
    const updated = {
      ...record,
      projectId: patch.projectId ?? record.projectId,
      workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : record.workspaceId,
    };
    await writeTrial(rc.env, updated);
  } catch (err) {
    log.warn('trial_orchestrator.trial_record_sync_failed', {
      trialId: state.trialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Probe the GitHub public API for the repo's default branch. Returns
 * `TRIAL_FALLBACK_BRANCH` ('main') on any failure — timeout, 404, malformed
 * JSON, etc. — so master-default repos work out of the box but a transient
 * GitHub outage never breaks trial provisioning.
 *
 * Configurable via `TRIAL_GITHUB_TIMEOUT_MS` (default
 * `DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS`, 5s).
 */
async function fetchDefaultBranch(
  owner: string,
  repo: string,
  env: TrialOrchestratorContext['env'],
): Promise<string> {
  const timeoutMs = parseEnvInt(
    env.TRIAL_GITHUB_TIMEOUT_MS,
    DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'user-agent': 'sam-trial-onboarding',
        accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('trial_orchestrator.default_branch_probe_http_error', {
        owner,
        repo,
        status: res.status,
      });
      return TRIAL_FALLBACK_BRANCH;
    }
    const body = (await res.json()) as { default_branch?: unknown };
    if (typeof body.default_branch === 'string' && body.default_branch.length > 0) {
      return body.default_branch;
    }
    return TRIAL_FALLBACK_BRANCH;
  } catch (err) {
    log.warn('trial_orchestrator.default_branch_probe_failed', {
      owner,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return TRIAL_FALLBACK_BRANCH;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the initial prompt for the discovery agent — the canonical discovery
 * prompt prefixed with the repo slug. Trials have no task row in D1, so we
 * deliberately do NOT ask the agent to call `get_instructions` (which requires
 * a task row and would 500). The discovery prompt itself names the tools it
 * needs (`add_knowledge`, `create_idea`).
 */
function buildDiscoveryInitialPrompt(repoOwner: string, repoName: string): string {
  const header = `Repository under exploration: \`${repoOwner}/${repoName}\`\n\n`;
  return `${header}${DISCOVERY_PROMPT}`;
}

// ---------------------------------------------------------------------------
// Step: project_creation
// ---------------------------------------------------------------------------

export async function handleProjectCreation(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'creating_project',
    progress: 0.1,
    at: Date.now(),
  });

  // Idempotency — a retry after partial progress should pick up the existing row.
  if (state.projectId) {
    const existing = await rc.env.DATABASE.prepare(
      `SELECT id FROM projects WHERE id = ?`
    ).bind(state.projectId).first<{ id: string }>();
    if (existing) {
      await rc.advanceToStep(state, 'node_selection');
      return;
    }
    // projectId recorded but row missing — fall through and recreate.
    log.warn('trial_orchestrator.project_row_missing', {
      trialId: state.trialId,
      projectId: state.projectId,
    });
    state.projectId = null;
  }

  const projectId = ulid();
  const userId = resolveAnonymousUserId(rc.env);
  const installationId = resolveAnonymousInstallationId(rc.env);
  const now = new Date().toISOString();
  const db = drizzle(rc.env.DATABASE, { schema });

  // Probe GitHub for the real default branch — falls back to 'main' on any
  // failure so master-default repos (e.g. octocat/Hello-World) clone correctly
  // without breaking main-default repos when GitHub is unreachable.
  const defaultBranch = state.defaultBranch
    ?? (await fetchDefaultBranch(state.repoOwner, state.repoName, rc.env));
  // Persist the resolved branch BEFORE the D1 insert so a crash between here
  // and the project persist (line ~222) does not cause a retry to re-probe
  // GitHub and potentially resolve a different value than what is about to
  // land in the D1 projects row.
  if (state.defaultBranch !== defaultBranch) {
    state.defaultBranch = defaultBranch;
    await rc.ctx.storage.put('state', state);
  }

  // Normalize the repo name for uniqueness. Two trials on the same repo are
  // expected — scope uniqueness by trialId so collisions are impossible.
  const rawName = `${state.repoOwner}/${state.repoName}`;
  const normalizedName = `trial-${state.trialId.toLowerCase()}`;

  await db.insert(schema.projects).values({
    id: projectId,
    userId,
    name: rawName,
    normalizedName,
    installationId,
    repository: `${state.repoOwner}/${state.repoName}`,
    defaultBranch,
    description: 'Anonymous trial — repository exploration',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  state.projectId = projectId;
  await rc.ctx.storage.put('state', state);

  // Mirror into KV so /claim and /events can resolve the trial before any
  // further steps complete.
  await syncTrialRecord(rc, state, { projectId });

  log.info('trial_orchestrator.step.project_created', {
    trialId: state.trialId,
    projectId,
    repo: rawName,
  });

  await rc.advanceToStep(state, 'node_selection');
}

// ---------------------------------------------------------------------------
// Step: node_selection
// ---------------------------------------------------------------------------

export async function handleNodeSelection(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'finding_node',
    progress: 0.2,
    at: Date.now(),
  });

  // Idempotency: if we already picked a node, verify it's still healthy then
  // skip ahead. If a preferred-node survived but isn't healthy anymore we
  // fall back to provisioning (trials never pin a specific node).
  if (state.nodeId) {
    if (await verifyNodeAgentHealthy(state.nodeId, rc as unknown as import('../task-runner/types').TaskRunnerContext)) {
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    log.warn('trial_orchestrator.recorded_node_unhealthy', {
      trialId: state.trialId,
      nodeId: state.nodeId,
    });
    state.nodeId = null;
    await rc.ctx.storage.put('state', state);
  }

  // Find any running node owned by the sentinel user with capacity. The
  // sentinel user never has user-level Hetzner credentials, so in practice
  // trial fleets always auto-provision on platform credentials. We still try
  // reuse first because warm/multi-trial scenarios benefit from it.
  const userId = resolveAnonymousUserId(rc.env);
  const existing = await rc.env.DATABASE.prepare(
    `SELECT id FROM nodes
     WHERE user_id = ? AND status = 'running' AND health_status = 'healthy'
     LIMIT 1`
  ).bind(userId).first<{ id: string }>();

  if (existing?.id) {
    if (await verifyNodeAgentHealthy(existing.id, rc as unknown as import('../task-runner/types').TaskRunnerContext)) {
      state.nodeId = existing.id;
      await rc.ctx.storage.put('state', state);
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
  }

  await rc.advanceToStep(state, 'node_provisioning');
}

// ---------------------------------------------------------------------------
// Step: node_provisioning
// ---------------------------------------------------------------------------

export async function handleNodeProvisioning(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'provisioning_node',
    progress: 0.3,
    at: Date.now(),
  });

  // If we already created the node (retry), poll its status.
  if (state.nodeId) {
    const node = await rc.env.DATABASE.prepare(
      `SELECT status, error_message FROM nodes WHERE id = ?`
    ).bind(state.nodeId).first<{ status: string; error_message: string | null }>();

    if (node?.status === 'running') {
      await rc.advanceToStep(state, 'node_agent_ready');
      return;
    }
    if (node?.status === 'error' || node?.status === 'stopped') {
      throw Object.assign(
        new Error(node.error_message || 'Trial node provisioning failed'),
        { permanent: true },
      );
    }
    // Still creating — retry via backoff (caller's alarm loop handles the delay).
    throw new Error('Node still provisioning — will retry');
  }

  const userId = resolveAnonymousUserId(rc.env);
  const limits = getRuntimeLimits(rc.env);

  const vmSize = (rc.env.TRIAL_VM_SIZE as never) ?? DEFAULT_VM_SIZE;
  const vmLocation = rc.env.TRIAL_VM_LOCATION ?? DEFAULT_VM_LOCATION;

  const createdNode = await createNodeRecord(rc.env, {
    userId,
    name: `trial-${state.trialId.slice(-8)}`,
    vmSize,
    vmLocation,
    heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
  });

  state.nodeId = createdNode.id;
  state.autoProvisionedNode = true;
  await rc.ctx.storage.put('state', state);

  log.info('trial_orchestrator.step.node_provisioning_started', {
    trialId: state.trialId,
    nodeId: createdNode.id,
    vmSize,
    vmLocation,
  });

  // Kick provisioning. We omit taskContext — trial agents don't need the
  // VM message reporter wiring that TaskRunner uses for chat persistence,
  // because startDiscoveryAgent creates its own chat/ACP sessions later.
  //
  // Note: provisionNode() may return with the node in 'creating' status for
  // async-IP providers (Scaleway) — the VM boots and gets its IP via the
  // first heartbeat backfill. Do NOT synchronously require status='running'
  // here; the next step (node_agent_ready) polls heartbeat freshness, which
  // correctly waits for the VM to boot + heartbeat regardless of provider.
  await provisionNode(createdNode.id, rc.env);

  await rc.advanceToStep(state, 'node_agent_ready');
}

// ---------------------------------------------------------------------------
// Step: node_agent_ready
// ---------------------------------------------------------------------------

export async function handleNodeAgentReady(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  if (!state.nodeId) {
    throw Object.assign(
      new Error('node_agent_ready entered without nodeId'),
      { permanent: true },
    );
  }

  if (!state.nodeAgentReadyStartedAt) {
    state.nodeAgentReadyStartedAt = Date.now();
    await rc.ctx.storage.put('state', state);
  }

  const timeoutMs = rc.getNodeReadyTimeoutMs();
  const elapsed = Date.now() - state.nodeAgentReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(
      new Error(`Trial node agent not ready within ${timeoutMs}ms`),
      { permanent: true },
    );
  }

  const node = await rc.env.DATABASE.prepare(
    `SELECT health_status, last_heartbeat_at FROM nodes WHERE id = ?`
  ).bind(state.nodeId).first<{ health_status: string | null; last_heartbeat_at: string | null }>();

  if (node?.health_status === 'healthy' && node.last_heartbeat_at) {
    const heartbeatTime = new Date(node.last_heartbeat_at).getTime();
    // Require a heartbeat after we started waiting — otherwise a stale warm
    // node's heartbeat from a previous boot would satisfy this check.
    const skewMs = rc.getHeartbeatSkewMs();
    if (heartbeatTime > state.nodeAgentReadyStartedAt - skewMs) {
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
  }

  // Not ready — requeue. We use the DO's existing alarm loop: throwing a
  // transient error causes the orchestrator to schedule a backoff retry.
  throw new Error('Trial node agent not yet ready — will retry');
}

// ---------------------------------------------------------------------------
// Step: workspace_creation
// ---------------------------------------------------------------------------

export async function handleWorkspaceCreation(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'creating_workspace',
    progress: 0.5,
    at: Date.now(),
  });

  if (!state.projectId || !state.nodeId) {
    throw Object.assign(
      new Error('workspace_creation requires projectId and nodeId'),
      { permanent: true },
    );
  }

  // Idempotency — if workspace row already exists, just move on.
  if (state.workspaceId) {
    const existing = await rc.env.DATABASE.prepare(
      `SELECT id FROM workspaces WHERE id = ?`
    ).bind(state.workspaceId).first<{ id: string }>();
    if (existing) {
      await rc.advanceToStep(state, 'workspace_ready');
      return;
    }
    // Row missing — fall through and recreate.
    state.workspaceId = null;
  }

  const userId = resolveAnonymousUserId(rc.env);
  const installationId = resolveAnonymousInstallationId(rc.env);
  const workspaceId = ulid();
  const repository = `${state.repoOwner}/${state.repoName}`;
  const displayName = `trial-${state.repoName}`.slice(0, 60);
  const db = drizzle(rc.env.DATABASE, { schema });
  const unique = await resolveUniqueWorkspaceDisplayName(db, state.nodeId, displayName);
  const now = new Date().toISOString();

  const profile = rc.env.TRIAL_DEFAULT_WORKSPACE_PROFILE ?? DEFAULT_TRIAL_WORKSPACE_PROFILE;
  const vmSize = (rc.env.TRIAL_VM_SIZE as never) ?? DEFAULT_VM_SIZE;
  const vmLocation = rc.env.TRIAL_VM_LOCATION ?? DEFAULT_VM_LOCATION;
  const branch = state.defaultBranch ?? TRIAL_FALLBACK_BRANCH;

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId: state.nodeId,
    projectId: state.projectId,
    userId,
    installationId,
    name: displayName,
    displayName: unique.displayName,
    normalizedDisplayName: unique.normalizedDisplayName,
    repository,
    branch,
    status: 'creating',
    vmSize,
    vmLocation,
    workspaceProfile: profile,
    createdAt: now,
    updatedAt: now,
  });

  state.workspaceId = workspaceId;
  await rc.ctx.storage.put('state', state);

  await syncTrialRecord(rc, state, { workspaceId });

  const callbackToken = await signCallbackToken(workspaceId, rc.env);
  await createWorkspaceOnNode(state.nodeId, rc.env, userId, {
    workspaceId,
    repository,
    branch,
    callbackToken,
    lightweight: profile === 'lightweight',
  });

  log.info('trial_orchestrator.step.workspace_creating', {
    trialId: state.trialId,
    projectId: state.projectId,
    workspaceId,
    nodeId: state.nodeId,
  });

  await rc.advanceToStep(state, 'workspace_ready');
}

// ---------------------------------------------------------------------------
// Step: workspace_ready
// ---------------------------------------------------------------------------

export async function handleWorkspaceReady(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'starting_agent',
    progress: 0.7,
    at: Date.now(),
  });

  if (!state.workspaceId) {
    throw Object.assign(
      new Error('workspace_ready without workspaceId'),
      { permanent: true },
    );
  }

  if (!state.workspaceReadyStartedAt) {
    state.workspaceReadyStartedAt = Date.now();
    await rc.ctx.storage.put('state', state);
  }

  const ws = await rc.env.DATABASE.prepare(
    `SELECT status, error_message FROM workspaces WHERE id = ?`
  ).bind(state.workspaceId).first<{ status: string; error_message: string | null }>();

  if (ws?.status === 'running' || ws?.status === 'recovery') {
    await rc.advanceToStep(state, 'discovery_agent_start');
    return;
  }
  if (ws?.status === 'error') {
    throw Object.assign(
      new Error(ws.error_message || 'Trial workspace creation failed'),
      { permanent: true },
    );
  }

  const timeoutMs = rc.getWorkspaceReadyTimeoutMs();
  const elapsed = Date.now() - state.workspaceReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(
      new Error(`Trial workspace did not become ready within ${timeoutMs}ms`),
      { permanent: true },
    );
  }

  const pollIntervalMs = rc.getWorkspaceReadyPollIntervalMs();
  const nextPollMs = Math.min(pollIntervalMs, Math.max(timeoutMs - elapsed, 1_000));
  await rc.ctx.storage.setAlarm(Date.now() + nextPollMs);
}

// ---------------------------------------------------------------------------
// Step: discovery_agent_start
// ---------------------------------------------------------------------------

export async function handleDiscoveryAgentStart(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  await safeEmitTrialEvent(rc.env, state.trialId, {
    type: 'trial.progress',
    stage: 'agent_booting',
    progress: 0.9,
    at: Date.now(),
  });

  if (!state.projectId || !state.workspaceId || !state.nodeId) {
    throw Object.assign(
      new Error('discovery_agent_start requires projectId, workspaceId, and nodeId'),
      { permanent: true },
    );
  }

  const userId = resolveAnonymousUserId(rc.env);
  const projectId = state.projectId;
  const workspaceId = state.workspaceId;
  const nodeId = state.nodeId;

  // Step 1: create the chat + ACP session rows in ProjectData DO (idempotent
  // via state.chatSessionId / state.acpSessionId flags).
  let chatSessionId = state.chatSessionId;
  let acpSessionId = state.acpSessionId;
  let agentType: string | null = null;
  if (!chatSessionId || !acpSessionId) {
    const res = await startDiscoveryAgent(rc.env, {
      projectId,
      workspaceId,
      sessionTopic: `${state.repoOwner}/${state.repoName}`,
    });
    chatSessionId = res.chatSessionId;
    acpSessionId = res.acpSessionId;
    agentType = res.agentType;
    state.chatSessionId = chatSessionId;
    state.acpSessionId = acpSessionId;
    await rc.ctx.storage.put('state', state);

    // Link session → workspace (mirrors TaskRunner's ensureSessionLinked).
    try {
      await rc.env.DATABASE.prepare(
        `UPDATE workspaces SET chat_session_id = ?, updated_at = ? WHERE id = ?`
      ).bind(chatSessionId, new Date().toISOString(), workspaceId).run();
      await projectDataService.linkSessionToWorkspace(
        rc.env,
        projectId,
        chatSessionId,
        workspaceId,
      );
    } catch (err) {
      log.warn('trial_orchestrator.session_link_failed', {
        trialId: state.trialId,
        projectId,
        chatSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('trial_orchestrator.step.discovery_agent_session_created', {
      trialId: state.trialId,
      projectId,
      chatSessionId,
      acpSessionId,
      agentType: res.agentType,
      model: res.model,
      provider: res.provider,
    });
  }

  // If we re-entered after crash with both IDs but no agentType in scope,
  // re-resolve so startAgentSessionOnNode below has what it needs.
  if (!agentType) {
    const { resolveTrialRunnerConfig } = await import('../../services/trial/trial-runner');
    agentType = resolveTrialRunnerConfig(rc.env).agentType;
  }

  if (!acpSessionId || !chatSessionId) {
    throw Object.assign(
      new Error('discovery_agent_start lost session ids after creation'),
      { permanent: true },
    );
  }
  const resolvedAcpSessionId: string = acpSessionId;
  const resolvedChatSessionId: string = chatSessionId;

  // Step 2: register the agent-session record on the VM agent (idempotent).
  if (!state.agentSessionCreatedOnVm) {
    await createAgentSessionOnNode(
      nodeId,
      workspaceId,
      resolvedAcpSessionId,
      `Trial: ${state.repoOwner}/${state.repoName}`.slice(0, 60),
      rc.env,
      userId,
      resolvedChatSessionId,
      projectId,
    );
    state.agentSessionCreatedOnVm = true;
    await rc.ctx.storage.put('state', state);
    log.info('trial_orchestrator.step.agent_session_registered', {
      trialId: state.trialId,
      workspaceId,
      acpSessionId,
      nodeId,
    });
  }

  // Step 3: mint + store the MCP token so the VM agent can call MCP tools
  // (add_knowledge, create_idea) on behalf of this trial. Trials have no task
  // row in D1, so we pass the trialId as the synthetic taskId — this keeps
  // rate-limit keying (per-trial) and audit logging working without needing
  // a schema change to McpTokenData.
  if (!state.mcpToken) {
    const token = generateMcpToken();
    await storeMcpToken(
      rc.env.KV,
      token,
      {
        taskId: state.trialId,
        projectId,
        userId,
        workspaceId,
        createdAt: new Date().toISOString(),
      },
      rc.env,
    );
    state.mcpToken = token;
    await rc.ctx.storage.put('state', state);
    log.info('trial_orchestrator.step.mcp_token_created', {
      trialId: state.trialId,
      projectId,
    });
  }

  // Step 4: tell the VM agent to actually launch the subprocess with the
  // discovery prompt as the initial turn. This is the missing piece that made
  // previous trials hang at 90% — without this call the ACP session stayed
  // in 'pending' forever.
  if (!state.agentStartedOnVm) {
    if (!state.mcpToken) {
      throw new Error('discovery_agent_start: mcpToken missing after step 3');
    }
    const initialPrompt = buildDiscoveryInitialPrompt(state.repoOwner, state.repoName);
    const mcpServerUrl = `https://api.${rc.env.BASE_DOMAIN}/mcp`;
    await startAgentSessionOnNode(
      nodeId,
      workspaceId,
      resolvedAcpSessionId,
      agentType,
      initialPrompt,
      rc.env,
      userId,
      { url: mcpServerUrl, token: state.mcpToken },
    );
    state.agentStartedOnVm = true;
    await rc.ctx.storage.put('state', state);
    log.info('trial_orchestrator.step.agent_subprocess_started', {
      trialId: state.trialId,
      workspaceId,
      acpSessionId,
      agentType,
    });
  }

  // Step 5: drive the ACP session state machine pending → assigned → running.
  // The trial flow has no UI claim and no VM-agent callback that moves the
  // session forward on its own, so the orchestrator owns these transitions.
  // The `running` transition is what the ACP bridge listens for to fire
  // `trial.ready` (see apps/api/src/services/trial/bridge.ts).
  if (!state.acpAssignedOnVm) {
    try {
      await projectDataService.transitionAcpSession(
        rc.env,
        projectId,
        resolvedAcpSessionId,
        'assigned',
        {
          actorType: 'system',
          reason: 'trial_orchestrator.agent_subprocess_started',
          workspaceId,
          nodeId,
        },
      );
      state.acpAssignedOnVm = true;
      await rc.ctx.storage.put('state', state);
    } catch (err) {
      log.warn('trial_orchestrator.acp_assign_failed', {
        trialId: state.trialId,
        acpSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  if (!state.acpRunningOnVm) {
    try {
      await projectDataService.transitionAcpSession(
        rc.env,
        projectId,
        resolvedAcpSessionId,
        'running',
        {
          actorType: 'system',
          reason: 'trial_orchestrator.agent_subprocess_running',
          workspaceId,
          nodeId,
        },
      );
      state.acpRunningOnVm = true;
      await rc.ctx.storage.put('state', state);
    } catch (err) {
      log.warn('trial_orchestrator.acp_running_failed', {
        trialId: state.trialId,
        acpSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  await rc.advanceToStep(state, 'running');
}

// ---------------------------------------------------------------------------
// Step: running (terminal for orchestrator)
// ---------------------------------------------------------------------------

/**
 * Terminal-for-orchestrator. The ACP bridge (wired into ProjectData DO's
 * `transitionAcpSession`) is what actually emits `trial.ready` once the
 * discovery agent produces its first assistant turn. This handler simply
 * marks the DO state as completed so no further alarms fire.
 *
 * Note on mcpToken lifecycle: we intentionally DO NOT revoke `state.mcpToken`
 * here. The orchestrator terminating at `running` means provisioning is done,
 * but the discovery agent is still active inside the workspace for up to
 * TRIAL_WORKSPACE_TTL_MS (default 20 min) and continues to need the token for
 * `add_knowledge` / `create_idea` MCP calls. Revocation on failure happens in
 * `TrialOrchestrator.failTrial()`; on success, the token is bounded by its KV
 * TTL (DEFAULT_MCP_TOKEN_TTL_SECONDS = 4h) and by the workspace teardown at
 * the end of the trial window. A future follow-up could shorten the token TTL
 * to match the trial window for defence-in-depth.
 */
export async function handleRunning(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext
): Promise<void> {
  state.completed = true;
  await rc.ctx.storage.put('state', state);
  log.info('trial_orchestrator.state.running', {
    trialId: state.trialId,
    projectId: state.projectId,
    workspaceId: state.workspaceId,
  });
}

// Re-export ulid for the DO class (keeps imports in index.ts tidy).
export { ulid };
