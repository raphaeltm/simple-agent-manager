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
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
} from '@simple-agent-manager/shared';

/** Default trial workspace profile when TRIAL_DEFAULT_WORKSPACE_PROFILE is unset. */
const DEFAULT_TRIAL_WORKSPACE_PROFILE = 'lightweight';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { signCallbackToken } from '../../services/jwt';
import { getRuntimeLimits } from '../../services/limits';
import { createWorkspaceOnNode } from '../../services/node-agent';
import { createNodeRecord, provisionNode } from '../../services/nodes';
import * as projectDataService from '../../services/project-data';
import { startDiscoveryAgent } from '../../services/trial/trial-runner';
import { readTrial, writeTrial } from '../../services/trial/trial-store';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import { verifyNodeAgentHealthy } from '../task-runner/node-steps';
import {
  resolveAnonymousInstallationId,
  resolveAnonymousUserId,
  safeEmitTrialEvent,
} from './helpers';
import type {
  TrialOrchestratorContext,
  TrialOrchestratorState,
} from './types';

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
    defaultBranch: 'main',
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
  await provisionNode(createdNode.id, rc.env);

  const provisioned = await rc.env.DATABASE.prepare(
    `SELECT status, error_message FROM nodes WHERE id = ?`
  ).bind(createdNode.id).first<{ status: string; error_message: string | null }>();

  if (!provisioned || provisioned.status !== 'running') {
    throw new Error(provisioned?.error_message || 'Trial node provisioning failed');
  }

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
    if (heartbeatTime > state.nodeAgentReadyStartedAt - 30_000) {
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
    branch: 'main',
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
    branch: 'main',
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

  if (!state.projectId || !state.workspaceId) {
    throw Object.assign(
      new Error('discovery_agent_start requires projectId and workspaceId'),
      { permanent: true },
    );
  }

  // Idempotent — re-entering after a crash shouldn't double-create sessions.
  if (state.acpSessionId && state.chatSessionId) {
    await rc.advanceToStep(state, 'running');
    return;
  }

  const agentReadyTimeoutMs = rc.getAgentReadyTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentReadyTimeoutMs);
  try {
    const res = await startDiscoveryAgent(rc.env, {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      sessionTopic: `${state.repoOwner}/${state.repoName}`,
    });
    state.chatSessionId = res.chatSessionId;
    state.acpSessionId = res.acpSessionId;
    await rc.ctx.storage.put('state', state);

    // Link session → workspace so downstream UI/DO lookups work the same way
    // TaskRunner links them (ensureSessionLinked pattern).
    try {
      await rc.env.DATABASE.prepare(
        `UPDATE workspaces SET chat_session_id = ?, updated_at = ? WHERE id = ?`
      ).bind(res.chatSessionId, new Date().toISOString(), state.workspaceId).run();
      await projectDataService.linkSessionToWorkspace(
        rc.env,
        state.projectId,
        res.chatSessionId,
        state.workspaceId,
      );
    } catch (err) {
      log.warn('trial_orchestrator.session_link_failed', {
        trialId: state.trialId,
        projectId: state.projectId,
        chatSessionId: res.chatSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('trial_orchestrator.step.discovery_agent_started', {
      trialId: state.trialId,
      projectId: state.projectId,
      chatSessionId: res.chatSessionId,
      acpSessionId: res.acpSessionId,
      agentType: res.agentType,
      model: res.model,
      provider: res.provider,
    });
  } finally {
    clearTimeout(timer);
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
