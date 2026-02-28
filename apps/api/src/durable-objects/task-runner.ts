/**
 * TaskRunner Durable Object — alarm-driven task orchestration (TDF-2).
 *
 * Replaces the unreliable `waitUntil(executeTaskRun())` approach with a
 * Durable Object that drives each orchestration step via alarm callbacks.
 * Each step is independent, idempotent, and survives Worker restarts.
 *
 * One DO instance per task, keyed by taskId:
 *   env.TASK_RUNNER.idFromName(taskId)
 *
 * Step flow:
 *   node_selection → [node_provisioning → node_agent_ready] → workspace_creation
 *   → workspace_ready → agent_session → running
 *
 * Each step handler:
 *   1. Reads persisted state
 *   2. Performs the operation (or checks if it's already done — idempotent)
 *   3. Persists results
 *   4. Schedules the next alarm
 *
 * On transient failure: retry with exponential backoff (up to max retries).
 * On permanent failure: transition task to failed, clean up resources.
 *
 * See: specs/tdf-2-orchestration-engine/ for full design.
 */
import { DurableObject } from 'cloudflare:workers';
import type { TaskExecutionStep, VMSize, VMLocation } from '@simple-agent-manager/shared';
import type { NodeLifecycle } from './node-lifecycle';
import {
  DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES,
  DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS,
  DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS,
  DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS,
  DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS,
  DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
  DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';

// =============================================================================
// Types
// =============================================================================

/** The subset of Env bindings the TaskRunner DO needs. */
type TaskRunnerEnv = {
  DATABASE: D1Database;
  OBSERVABILITY_DATABASE: D1Database;
  NODE_LIFECYCLE: DurableObjectNamespace;
  TASK_RUNNER_STEP_MAX_RETRIES?: string;
  TASK_RUNNER_RETRY_BASE_DELAY_MS?: string;
  TASK_RUNNER_RETRY_MAX_DELAY_MS?: string;
  TASK_RUNNER_AGENT_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_AGENT_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_PROVISION_POLL_INTERVAL_MS?: string;
  // Env vars passed through for services
  BASE_DOMAIN: string;
  ENCRYPTION_KEY: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_NODES_PER_USER?: string;
  TASK_RUN_NODE_CPU_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT?: string;
  NODE_AGENT_READY_TIMEOUT_MS?: string;
  NODE_AGENT_READY_POLL_INTERVAL_MS?: string;
  NODE_AGENT_REQUEST_TIMEOUT_MS?: string;
  NODE_WARM_TIMEOUT_MS?: string;
  TASK_RUN_CLEANUP_DELAY_MS?: string;
  KV: KVNamespace;
};

interface StepResults {
  nodeId: string | null;
  autoProvisioned: boolean;
  workspaceId: string | null;
  chatSessionId: string | null;
  agentSessionId: string | null;
}

interface TaskRunConfig {
  vmSize: VMSize;
  vmLocation: VMLocation;
  branch: string;
  preferredNodeId: string | null;
  userName: string | null;
  userEmail: string | null;
  githubId: string | null;
  taskTitle: string;
  taskDescription: string | null;
  repository: string;
  installationId: string;
  outputBranch: string | null;
  projectDefaultVmSize: VMSize | null;
  /** Chat session ID created at task submit time (TDF-6: single session per task) */
  chatSessionId: string | null;
}

export interface TaskRunnerState {
  version: 1;
  taskId: string;
  projectId: string;
  userId: string;
  currentStep: TaskExecutionStep;
  stepResults: StepResults;
  config: TaskRunConfig;
  retryCount: number;
  workspaceReadyReceived: boolean;
  workspaceReadyStatus: 'running' | 'recovery' | 'error' | null;
  workspaceErrorMessage: string | null;
  createdAt: number;
  lastStepAt: number;
  /** Set when we started waiting for agent ready — used for timeout detection */
  agentReadyStartedAt: number | null;
  /** Set when we started waiting for workspace ready — used for timeout detection */
  workspaceReadyStartedAt: number | null;
  /** Terminal — DO has completed or failed, no more alarms */
  completed: boolean;
}

export interface StartTaskInput {
  taskId: string;
  projectId: string;
  userId: string;
  config: TaskRunConfig;
}

// =============================================================================
// Helpers (pure functions extracted to task-runner-helpers.ts for testability)
// =============================================================================

import { parseEnvInt, computeBackoffMs, isTransientError } from './task-runner-helpers';

// =============================================================================
// TaskRunner Durable Object
// =============================================================================

export class TaskRunner extends DurableObject<TaskRunnerEnv> {
  // =========================================================================
  // Public RPCs (called from Worker routes)
  // =========================================================================

  /**
   * Start a new task run. Called once from task-submit or task-runs routes.
   * Persists initial state and schedules the first alarm immediately.
   */
  async start(input: StartTaskInput): Promise<void> {
    const existing = await this.getState();
    if (existing) {
      // Idempotent: if already started, don't re-initialize.
      // This can happen if the route retries after a timeout.
      log.warn('task_runner_do.start.already_initialized', {
        taskId: input.taskId,
        currentStep: existing.currentStep,
      });
      return;
    }

    const now = Date.now();
    const state: TaskRunnerState = {
      version: 1,
      taskId: input.taskId,
      projectId: input.projectId,
      userId: input.userId,
      currentStep: 'node_selection',
      stepResults: {
        nodeId: null,
        autoProvisioned: false,
        workspaceId: null,
        chatSessionId: input.config.chatSessionId ?? null,
        agentSessionId: null,
      },
      config: input.config,
      retryCount: 0,
      workspaceReadyReceived: false,
      workspaceReadyStatus: null,
      workspaceErrorMessage: null,
      createdAt: now,
      lastStepAt: now,
      agentReadyStartedAt: null,
      workspaceReadyStartedAt: null,
      completed: false,
    };

    await this.ctx.storage.put('state', state);

    // Fire first alarm immediately (0ms delay)
    await this.ctx.storage.setAlarm(now);

    log.info('task_runner_do.started', {
      taskId: input.taskId,
      projectId: input.projectId,
    });
  }

  /**
   * Called when the workspace-ready callback arrives from the VM agent.
   * If the DO is waiting at `workspace_ready` step, this advances it immediately.
   * If the DO hasn't reached that step yet, the signal is stored for later.
   */
  async advanceWorkspaceReady(
    status: 'running' | 'recovery' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    const state = await this.getState();
    if (!state || state.completed) return;

    state.workspaceReadyReceived = true;
    state.workspaceReadyStatus = status;
    state.workspaceErrorMessage = errorMessage;
    await this.ctx.storage.put('state', state);

    log.info('task_runner_do.workspace_ready_received', {
      taskId: state.taskId,
      currentStep: state.currentStep,
      status,
    });

    // If we're at the workspace_ready step, fire alarm immediately to process
    if (state.currentStep === 'workspace_ready') {
      await this.ctx.storage.setAlarm(Date.now());
    }
    // Otherwise the alarm handler will pick it up when it reaches workspace_ready
  }

  /**
   * Get the current DO state (for debugging/testing).
   */
  async getStatus(): Promise<TaskRunnerState | null> {
    return this.getState();
  }

  // =========================================================================
  // Alarm handler — step dispatch
  // =========================================================================

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.completed) return;

    const stepStartMs = Date.now();

    try {
      switch (state.currentStep) {
        case 'node_selection':
          await this.handleNodeSelection(state);
          break;
        case 'node_provisioning':
          await this.handleNodeProvisioning(state);
          break;
        case 'node_agent_ready':
          await this.handleNodeAgentReady(state);
          break;
        case 'workspace_creation':
          await this.handleWorkspaceCreation(state);
          break;
        case 'workspace_ready':
          await this.handleWorkspaceReady(state);
          break;
        case 'agent_session':
          await this.handleAgentSession(state);
          break;
        case 'running':
        case 'awaiting_followup':
          // Terminal DO steps — agent manages from here via callbacks
          return;
        default:
          log.error('task_runner_do.unknown_step', { taskId: state.taskId, step: state.currentStep });
          await this.failTask(state, `Unknown execution step: ${state.currentStep}`);
          return;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - stepStartMs;

      log.error('task_runner_do.step_error', {
        taskId: state.taskId,
        step: state.currentStep,
        retryCount: state.retryCount,
        errorMessage,
        durationMs,
      });

      if (isTransientError(err) && state.retryCount < this.getMaxRetries()) {
        // Transient failure — retry with backoff
        state.retryCount++;
        await this.ctx.storage.put('state', state);
        const backoff = computeBackoffMs(
          state.retryCount,
          this.getRetryBaseDelayMs(),
          this.getRetryMaxDelayMs(),
        );
        await this.ctx.storage.setAlarm(Date.now() + backoff);

        log.info('task_runner_do.step_retry_scheduled', {
          taskId: state.taskId,
          step: state.currentStep,
          retryCount: state.retryCount,
          backoffMs: backoff,
        });
      } else {
        // Permanent failure or max retries exceeded
        await this.failTask(state, errorMessage);
      }
    }
  }

  // =========================================================================
  // Step Handlers
  // =========================================================================

  private async handleNodeSelection(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'node_selection');

    log.info('task_runner_do.step.node_selection', {
      taskId: state.taskId,
      preferredNodeId: state.config.preferredNodeId,
    });

    if (state.config.preferredNodeId) {
      // Validate the preferred node
      const node = await this.env.DATABASE.prepare(
        `SELECT id, status FROM nodes WHERE id = ? AND user_id = ?`
      ).bind(state.config.preferredNodeId, state.userId).first<{ id: string; status: string }>();

      if (!node || node.status !== 'running') {
        throw Object.assign(new Error('Specified node is not available'), { permanent: true });
      }

      state.stepResults.nodeId = node.id;
      await this.advanceToStep(state, 'workspace_creation');
      return;
    }

    // Try warm pool first
    const nodeId = await this.tryClaimWarmNode(state);
    if (nodeId) {
      state.stepResults.nodeId = nodeId;
      await this.advanceToStep(state, 'workspace_creation');
      return;
    }

    // Try existing running nodes with capacity
    const existingNodeId = await this.findNodeWithCapacity(state);
    if (existingNodeId) {
      state.stepResults.nodeId = existingNodeId;
      await this.advanceToStep(state, 'workspace_creation');
      return;
    }

    // No node found — need to provision
    await this.advanceToStep(state, 'node_provisioning');
  }

  private async handleNodeProvisioning(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'node_provisioning');

    // If we already created the node (retry scenario), check its status
    if (state.stepResults.nodeId) {
      const node = await this.env.DATABASE.prepare(
        `SELECT id, status, error_message FROM nodes WHERE id = ?`
      ).bind(state.stepResults.nodeId).first<{ id: string; status: string; error_message: string | null }>();

      if (node?.status === 'running') {
        // Already provisioned — advance
        await this.advanceToStep(state, 'node_agent_ready');
        return;
      }
      if (node?.status === 'error' || node?.status === 'stopped') {
        throw new Error(node.error_message || 'Node provisioning failed');
      }
      // Still creating — schedule another poll
      await this.ctx.storage.setAlarm(
        Date.now() + this.getProvisionPollIntervalMs()
      );
      return;
    }

    // Check user node limit
    const maxNodes = parseEnvInt(this.env.MAX_NODES_PER_USER, 10);
    const countResult = await this.env.DATABASE.prepare(
      `SELECT COUNT(*) as c FROM nodes WHERE user_id = ?`
    ).bind(state.userId).first<{ c: number }>();

    if ((countResult?.c ?? 0) >= maxNodes) {
      throw Object.assign(
        new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`),
        { permanent: true },
      );
    }

    // Import and call node creation services
    // We import dynamically to avoid circular dependency issues and
    // to keep the DO module lighter
    const { createNodeRecord, provisionNode } = await import('../services/nodes');
    const { getRuntimeLimits } = await import('../services/limits');
    const limits = getRuntimeLimits(this.env as any);

    const createdNode = await createNodeRecord(this.env as any, {
      userId: state.userId,
      name: `Auto: ${state.config.taskTitle.slice(0, 40)}`,
      vmSize: state.config.vmSize,
      vmLocation: state.config.vmLocation,
      heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
    });

    state.stepResults.nodeId = createdNode.id;
    state.stepResults.autoProvisioned = true;

    // Store autoProvisionedNodeId on the task
    await this.env.DATABASE.prepare(
      `UPDATE tasks SET auto_provisioned_node_id = ?, updated_at = ? WHERE id = ?`
    ).bind(createdNode.id, new Date().toISOString(), state.taskId).run();

    await this.ctx.storage.put('state', state);

    log.info('task_runner_do.step.node_provisioning', {
      taskId: state.taskId,
      nodeId: createdNode.id,
      vmSize: state.config.vmSize,
    });

    // Provision the node (calls Hetzner API)
    await provisionNode(createdNode.id, this.env as any);

    // Verify it's running
    const provisionedNode = await this.env.DATABASE.prepare(
      `SELECT status, error_message FROM nodes WHERE id = ?`
    ).bind(createdNode.id).first<{ status: string; error_message: string | null }>();

    if (!provisionedNode || provisionedNode.status !== 'running') {
      throw new Error(provisionedNode?.error_message || 'Node provisioning failed');
    }

    await this.advanceToStep(state, 'node_agent_ready');
  }

  private async handleNodeAgentReady(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'node_agent_ready');

    if (!state.stepResults.nodeId) {
      throw new Error('No nodeId in state — cannot check agent readiness');
    }

    // Initialize timeout tracking on first entry
    if (!state.agentReadyStartedAt) {
      state.agentReadyStartedAt = Date.now();
      await this.ctx.storage.put('state', state);
    }

    // Check timeout
    const timeoutMs = this.getAgentReadyTimeoutMs();
    const elapsed = Date.now() - state.agentReadyStartedAt;
    if (elapsed > timeoutMs) {
      throw Object.assign(
        new Error(`Node agent not ready within ${timeoutMs}ms`),
        { permanent: true },
      );
    }

    // Check agent health
    const baseUrl = `http://vm-${state.stepResults.nodeId.toLowerCase()}.${this.env.BASE_DOMAIN}:8080`;
    const healthUrl = `${baseUrl}/health`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        log.info('task_runner_do.step.node_agent_ready', {
          taskId: state.taskId,
          nodeId: state.stepResults.nodeId,
          elapsedMs: elapsed,
        });
        await this.advanceToStep(state, 'workspace_creation');
        return;
      }
    } catch {
      // Agent not ready yet — schedule another poll
    }

    // Not ready — schedule another poll
    await this.ctx.storage.setAlarm(Date.now() + this.getAgentPollIntervalMs());
  }

  private async handleWorkspaceCreation(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'workspace_creation');

    if (!state.stepResults.nodeId) {
      throw new Error('No nodeId in state — cannot create workspace');
    }

    // If workspace already created (retry or crash recovery), skip creation.
    // Check both DO state AND D1 to handle the crash window between D1 insert
    // and storage.put — if D1 has a workspace_id for this task but the DO
    // state doesn't, recover it.
    if (!state.stepResults.workspaceId) {
      const existingTask = await this.env.DATABASE.prepare(
        `SELECT workspace_id, status FROM tasks WHERE id = ?`
      ).bind(state.taskId).first<{ workspace_id: string | null; status: string }>();

      if (existingTask?.workspace_id) {
        // D1 has a workspace — recover it into DO state (crash recovery)
        state.stepResults.workspaceId = existingTask.workspace_id;
        await this.ctx.storage.put('state', state);

        log.info('task_runner_do.workspace_recovered_from_d1', {
          taskId: state.taskId,
          workspaceId: existingTask.workspace_id,
        });
      }
    }

    if (state.stepResults.workspaceId) {
      // Check if we already transitioned to delegated
      const task = await this.env.DATABASE.prepare(
        `SELECT status FROM tasks WHERE id = ?`
      ).bind(state.taskId).first<{ status: string }>();

      if (task?.status === 'delegated') {
        await this.advanceToStep(state, 'workspace_ready');
        return;
      }
      // If still queued, proceed with delegation transition below
    } else {
      // Create workspace in D1
      const { ulid } = await import('../lib/ulid');
      const { resolveUniqueWorkspaceDisplayName } = await import('../services/workspace-names');
      const { drizzle } = await import('drizzle-orm/d1');
      const schema = await import('../db/schema');

      const db = drizzle(this.env.DATABASE, { schema });
      const workspaceId = ulid();
      const workspaceName = `Task: ${state.config.taskTitle.slice(0, 50)}`;
      const uniqueName = await resolveUniqueWorkspaceDisplayName(db, state.stepResults.nodeId, workspaceName);
      const now = new Date().toISOString();

      await db.insert(schema.workspaces).values({
        id: workspaceId,
        nodeId: state.stepResults.nodeId,
        projectId: state.projectId,
        userId: state.userId,
        installationId: state.config.installationId,
        name: workspaceName,
        displayName: uniqueName.displayName,
        normalizedDisplayName: uniqueName.normalizedDisplayName,
        repository: state.config.repository,
        branch: state.config.branch,
        status: 'creating',
        vmSize: state.config.vmSize,
        vmLocation: state.config.vmLocation,
        createdAt: now,
        updatedAt: now,
      });

      // Update task with workspace ID
      await this.env.DATABASE.prepare(
        `UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ?`
      ).bind(workspaceId, now, state.taskId).run();

      state.stepResults.workspaceId = workspaceId;
      await this.ctx.storage.put('state', state);

      // TDF-6: Link existing chat session to workspace (session created at submit time).
      // No new session creation here — one session per task.
      //
      // D1 update is done FIRST and separately from the DO call because:
      // - D1 chat_session_id on workspace is used by idle cleanup and task completion hooks
      // - The DO link is for the session's internal workspace_id field
      // - Even if the DO call fails, D1 must have the link for downstream correctness
      if (state.stepResults.chatSessionId) {
        // Step 1: Update D1 workspace record (critical — used by idle cleanup, task hooks)
        try {
          await this.env.DATABASE.prepare(
            `UPDATE workspaces SET chat_session_id = ?, updated_at = ? WHERE id = ?`
          ).bind(state.stepResults.chatSessionId, now, workspaceId).run();

          log.info('task_runner_do.session_d1_linked', {
            taskId: state.taskId,
            sessionId: state.stepResults.chatSessionId,
            workspaceId,
          });
        } catch (err) {
          // D1 link failure is serious — log as error but don't block task execution.
          // The cron sweep catches orphaned sessions without workspace links.
          log.error('task_runner_do.session_d1_link_failed', {
            taskId: state.taskId,
            sessionId: state.stepResults.chatSessionId,
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Step 2: Update ProjectData DO session record (best-effort — enriches session data)
        try {
          const projectDataService = await import('../services/project-data');
          await projectDataService.linkSessionToWorkspace(
            this.env as any,
            state.projectId,
            state.stepResults.chatSessionId,
            workspaceId,
          );

          log.info('task_runner_do.session_linked_to_workspace', {
            taskId: state.taskId,
            sessionId: state.stepResults.chatSessionId,
            workspaceId,
          });
        } catch (err) {
          // DO link failure is best-effort — session still works without workspace_id
          // in the DO's SQLite. The D1 link above handles downstream needs.
          log.error('task_runner_do.session_do_link_failed', {
            taskId: state.taskId,
            sessionId: state.stepResults.chatSessionId,
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Set output_branch
      const outputBranch = state.config.outputBranch || `task/${state.taskId}`;
      await this.env.DATABASE.prepare(
        `UPDATE tasks SET output_branch = ?, updated_at = ? WHERE id = ?`
      ).bind(outputBranch, now, state.taskId).run();

      // Create workspace on VM agent
      const { signCallbackToken } = await import('../services/jwt');
      const { createWorkspaceOnNode } = await import('../services/node-agent');

      const callbackToken = await signCallbackToken(workspaceId, this.env as any);
      await createWorkspaceOnNode(state.stepResults.nodeId, this.env as any, state.userId, {
        workspaceId,
        repository: state.config.repository,
        branch: state.config.branch,
        callbackToken,
        gitUserName: state.config.userName,
        gitUserEmail: state.config.userEmail,
        githubId: state.config.githubId,
      });

      await this.ctx.storage.put('state', state);
    }

    // Transition task: queued → delegated (optimistic locking)
    const now = new Date().toISOString();
    const result = await this.env.DATABASE.prepare(
      `UPDATE tasks SET status = 'delegated', updated_at = ? WHERE id = ? AND status = 'queued'`
    ).bind(now, state.taskId).run();

    if (!result.meta.changes || result.meta.changes === 0) {
      // Task was already failed by cron recovery — abort gracefully
      log.warn('task_runner_do.aborted_by_recovery', {
        taskId: state.taskId,
        step: 'delegated_transition',
      });
      state.completed = true;
      await this.ctx.storage.put('state', state);
      return;
    }

    // Record status event
    const { ulid } = await import('../lib/ulid');
    await this.env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, 'queued', 'delegated', 'system', NULL, ?, ?)`
    ).bind(
      ulid(),
      state.taskId,
      `Delegated to workspace ${state.stepResults.workspaceId} on node ${state.stepResults.nodeId}`,
      now,
    ).run();

    await this.advanceToStep(state, 'workspace_ready');
  }

  private async handleWorkspaceReady(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'workspace_ready');

    // Initialize timeout tracking on first entry
    if (!state.workspaceReadyStartedAt) {
      state.workspaceReadyStartedAt = Date.now();
      await this.ctx.storage.put('state', state);
    }

    // Check if callback already arrived
    if (state.workspaceReadyReceived) {
      if (state.workspaceReadyStatus === 'running' || state.workspaceReadyStatus === 'recovery') {
        log.info('task_runner_do.step.workspace_ready', {
          taskId: state.taskId,
          workspaceId: state.stepResults.workspaceId,
          status: state.workspaceReadyStatus,
        });
        await this.advanceToStep(state, 'agent_session');
        return;
      }
      if (state.workspaceReadyStatus === 'error') {
        throw Object.assign(
          new Error(state.workspaceErrorMessage || 'Workspace creation failed'),
          { permanent: true },
        );
      }
    }

    // Check timeout
    const timeoutMs = this.getWorkspaceReadyTimeoutMs();
    const elapsed = Date.now() - state.workspaceReadyStartedAt;
    if (elapsed > timeoutMs) {
      throw Object.assign(
        new Error(`Workspace did not become ready within ${timeoutMs}ms`),
        { permanent: true },
      );
    }

    // Also check D1 as fallback (in case callback was processed by old code path
    // or the advanceWorkspaceReady RPC was lost)
    if (state.stepResults.workspaceId) {
      const ws = await this.env.DATABASE.prepare(
        `SELECT status, error_message FROM workspaces WHERE id = ?`
      ).bind(state.stepResults.workspaceId).first<{ status: string; error_message: string | null }>();

      if (ws) {
        if (ws.status === 'running' || ws.status === 'recovery') {
          log.info('task_runner_do.step.workspace_ready_from_d1', {
            taskId: state.taskId,
            workspaceId: state.stepResults.workspaceId,
          });
          await this.advanceToStep(state, 'agent_session');
          return;
        }
        if (ws.status === 'error') {
          throw Object.assign(
            new Error(ws.error_message || 'Workspace creation failed'),
            { permanent: true },
          );
        }
        if (ws.status === 'stopped') {
          throw Object.assign(
            new Error('Workspace was stopped during creation'),
            { permanent: true },
          );
        }
      }
    }

    // Still waiting — schedule another poll as fallback
    // (Primary advancement is via advanceWorkspaceReady callback)
    await this.ctx.storage.setAlarm(Date.now() + this.getAgentPollIntervalMs());
  }

  private async handleAgentSession(state: TaskRunnerState): Promise<void> {
    await this.updateD1ExecutionStep(state.taskId, 'agent_session');

    if (!state.stepResults.nodeId || !state.stepResults.workspaceId) {
      throw new Error('Missing nodeId or workspaceId for agent session creation');
    }

    // If agent session already created (retry), skip
    if (state.stepResults.agentSessionId) {
      const existing = await this.env.DATABASE.prepare(
        `SELECT id FROM agent_sessions WHERE id = ?`
      ).bind(state.stepResults.agentSessionId).first<{ id: string }>();

      if (existing) {
        // Already created — just advance
        await this.transitionToInProgress(state);
        return;
      }
    }

    const { ulid } = await import('../lib/ulid');
    const { createAgentSessionOnNode } = await import('../services/node-agent');
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../db/schema');

    const db = drizzle(this.env.DATABASE, { schema });
    const sessionId = ulid();
    const sessionLabel = `Task: ${state.config.taskTitle.slice(0, 40)}`;
    const now = new Date().toISOString();

    await db.insert(schema.agentSessions).values({
      id: sessionId,
      workspaceId: state.stepResults.workspaceId,
      userId: state.userId,
      status: 'running',
      label: sessionLabel,
      createdAt: now,
      updatedAt: now,
    });

    state.stepResults.agentSessionId = sessionId;
    await this.ctx.storage.put('state', state);

    await createAgentSessionOnNode(
      state.stepResults.nodeId,
      state.stepResults.workspaceId,
      sessionId,
      sessionLabel,
      this.env as any,
      state.userId,
    );

    log.info('task_runner_do.step.agent_session_created', {
      taskId: state.taskId,
      agentSessionId: sessionId,
      workspaceId: state.stepResults.workspaceId,
      nodeId: state.stepResults.nodeId,
    });

    await this.transitionToInProgress(state);
  }

  // =========================================================================
  // State machine helpers
  // =========================================================================

  /**
   * Advance to the next step: persist state, reset retry count, schedule alarm.
   */
  private async advanceToStep(
    state: TaskRunnerState,
    nextStep: TaskExecutionStep,
  ): Promise<void> {
    state.currentStep = nextStep;
    state.retryCount = 0;
    state.lastStepAt = Date.now();
    await this.ctx.storage.put('state', state);

    // Schedule alarm immediately for next step
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Transition the task to in_progress and mark the DO as done.
   */
  private async transitionToInProgress(state: TaskRunnerState): Promise<void> {
    const now = new Date().toISOString();

    // Optimistic lock: only transition if still delegated
    const result = await this.env.DATABASE.prepare(
      `UPDATE tasks SET status = 'in_progress', started_at = ?, execution_step = 'running', updated_at = ? WHERE id = ? AND status = 'delegated'`
    ).bind(now, now, state.taskId).run();

    if (!result.meta.changes || result.meta.changes === 0) {
      log.warn('task_runner_do.aborted_by_recovery', {
        taskId: state.taskId,
        step: 'in_progress_transition',
      });
      state.completed = true;
      await this.ctx.storage.put('state', state);
      return;
    }

    // Record status event
    const { ulid } = await import('../lib/ulid');
    await this.env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, 'delegated', 'in_progress', 'system', NULL, ?, ?)`
    ).bind(
      ulid(),
      state.taskId,
      `Agent session ${state.stepResults.agentSessionId} created. Task execution started.`,
      now,
    ).run();

    log.info('task_runner_do.step.in_progress', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
      nodeId: state.stepResults.nodeId,
      agentSessionId: state.stepResults.agentSessionId,
      autoProvisioned: state.stepResults.autoProvisioned,
      totalDurationMs: Date.now() - state.createdAt,
    });

    state.currentStep = 'running';
    state.completed = true;
    await this.ctx.storage.put('state', state);
  }

  /**
   * Fail the task, clean up resources, record error, mark DO as complete.
   */
  private async failTask(state: TaskRunnerState, errorMessage: string): Promise<void> {
    const now = new Date().toISOString();

    log.error('task_runner_do.task_failed', {
      taskId: state.taskId,
      step: state.currentStep,
      errorMessage,
      totalDurationMs: Date.now() - state.createdAt,
    });

    // Check current status before failing (idempotent)
    const task = await this.env.DATABASE.prepare(
      `SELECT status FROM tasks WHERE id = ?`
    ).bind(state.taskId).first<{ status: string }>();

    const currentStatus = task?.status;
    if (currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'cancelled') {
      // Already terminal — skip
      state.completed = true;
      await this.ctx.storage.put('state', state);
      return;
    }

    // Fail the task
    await this.env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`
    ).bind(errorMessage, now, now, state.taskId).run();

    const { ulid } = await import('../lib/ulid');
    await this.env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, 'failed', 'system', NULL, ?, ?)`
    ).bind(ulid(), state.taskId, currentStatus || 'queued', errorMessage, now).run();

    // Write to observability database
    try {
      await this.env.OBSERVABILITY_DATABASE.prepare(
        `INSERT INTO errors (id, source, level, message, stack, context, user_id, node_id, workspace_id, ip_address, user_agent, timestamp)
         VALUES (?, 'api', 'error', ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`
      ).bind(
        ulid(),
        `Task ${state.taskId} failed at step ${state.currentStep}: ${errorMessage}`,
        JSON.stringify({
          taskId: state.taskId,
          projectId: state.projectId,
          step: state.currentStep,
          retryCount: state.retryCount,
        }),
        state.userId,
        state.stepResults.nodeId,
        state.stepResults.workspaceId,
        now,
      ).run();
    } catch (err) {
      log.error('task_runner_do.observability_write_failed', {
        taskId: state.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Best-effort cleanup
    await this.cleanupOnFailure(state);

    state.completed = true;
    await this.ctx.storage.put('state', state);
  }

  /**
   * Best-effort cleanup: stop workspace, mark node warm if auto-provisioned.
   */
  private async cleanupOnFailure(state: TaskRunnerState): Promise<void> {
    const now = new Date().toISOString();

    // Stop workspace if one was created
    if (state.stepResults.workspaceId && state.stepResults.nodeId) {
      try {
        const { stopWorkspaceOnNode } = await import('../services/node-agent');
        await stopWorkspaceOnNode(
          state.stepResults.nodeId,
          state.stepResults.workspaceId,
          this.env as any,
          state.userId,
        );
      } catch (err) {
        log.error('task_runner_do.cleanup.workspace_stop_failed', {
          taskId: state.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await this.env.DATABASE.prepare(
        `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ?`
      ).bind(now, state.stepResults.workspaceId).run();
    }

    // Clean up auto-provisioned node. If a workspace exists, cleanupTaskRun
    // handles checking for other workspaces and marking the node warm.
    // If no workspace was created (failure during provisioning), we still need
    // to mark the auto-provisioned node as warm directly via NodeLifecycle DO.
    if (state.stepResults.autoProvisioned && state.stepResults.nodeId) {
      if (state.stepResults.workspaceId) {
        try {
          const { cleanupTaskRun } = await import('../services/task-runner');
          await cleanupTaskRun(state.taskId, this.env as any);
        } catch (err) {
          log.error('task_runner_do.cleanup.node_cleanup_failed', {
            taskId: state.taskId,
            nodeId: state.stepResults.nodeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // No workspace — mark node warm directly since cleanupTaskRun
        // expects a workspace_id on the task to work properly.
        // Use markIdle(nodeId, userId) which transitions to warm state.
        try {
          const doId = this.env.NODE_LIFECYCLE.idFromName(state.stepResults.nodeId);
          const stub = this.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
          await stub.markIdle(state.stepResults.nodeId, state.userId);

          log.info('task_runner_do.cleanup.node_marked_warm_direct', {
            taskId: state.taskId,
            nodeId: state.stepResults.nodeId,
          });
        } catch (err) {
          log.error('task_runner_do.cleanup.node_warm_failed', {
            taskId: state.taskId,
            nodeId: state.stepResults.nodeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // =========================================================================
  // Node selection helpers
  // =========================================================================

  private async tryClaimWarmNode(state: TaskRunnerState): Promise<string | null> {
    if (!this.env.NODE_LIFECYCLE) return null;

    const warmNodes = await this.env.DATABASE.prepare(
      `SELECT id, vm_size, vm_location FROM nodes
       WHERE user_id = ? AND status = 'running' AND warm_since IS NOT NULL`
    ).bind(state.userId).all<{ id: string; vm_size: string; vm_location: string }>();

    if (!warmNodes.results.length) return null;

    // Sort: prefer matching size/location
    const sorted = warmNodes.results.sort((a, b) => {
      const aSizeMatch = a.vm_size === state.config.vmSize ? 1 : 0;
      const bSizeMatch = b.vm_size === state.config.vmSize ? 1 : 0;
      if (aSizeMatch !== bSizeMatch) return bSizeMatch - aSizeMatch;
      const aLocMatch = a.vm_location === state.config.vmLocation ? 1 : 0;
      const bLocMatch = b.vm_location === state.config.vmLocation ? 1 : 0;
      return bLocMatch - aLocMatch;
    });

    for (const warmNode of sorted) {
      try {
        // Re-check freshness
        const fresh = await this.env.DATABASE.prepare(
          `SELECT status, warm_since FROM nodes WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL`
        ).bind(warmNode.id).first<{ status: string; warm_since: string | null }>();

        if (!fresh) continue;

        // Try to claim via NodeLifecycle DO
        const doId = this.env.NODE_LIFECYCLE.idFromName(warmNode.id);
        const stub = this.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
        const result = await stub.tryClaim(state.taskId) as { claimed: boolean };

        if (result.claimed) {
          log.info('task_runner_do.warm_node_claimed', {
            taskId: state.taskId,
            nodeId: warmNode.id,
          });
          return warmNode.id;
        }
      } catch {
        // Claim failed — try next
      }
    }

    return null;
  }

  private async findNodeWithCapacity(state: TaskRunnerState): Promise<string | null> {
    const cpuThreshold = parseEnvInt(
      this.env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT, 80,
    );
    const memThreshold = parseEnvInt(
      this.env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT, 85,
    );
    const maxWsPerNode = parseEnvInt(this.env.MAX_WORKSPACES_PER_NODE, 10);

    const nodes = await this.env.DATABASE.prepare(
      `SELECT id, vm_size, vm_location, health_status, last_metrics FROM nodes
       WHERE user_id = ? AND status = 'running' AND health_status != 'unhealthy'`
    ).bind(state.userId).all<{
      id: string;
      vm_size: string;
      vm_location: string;
      health_status: string;
      last_metrics: string | null;
    }>();

    if (!nodes.results.length) return null;

    type ScoredNode = {
      id: string;
      vmSize: string;
      vmLocation: string;
      score: number | null;
      wsCount: number;
    };

    const candidates: ScoredNode[] = [];

    for (const node of nodes.results) {
      const wsCountResult = await this.env.DATABASE.prepare(
        `SELECT COUNT(*) as c FROM workspaces
         WHERE node_id = ? AND user_id = ? AND status IN ('running', 'creating', 'recovery')`
      ).bind(node.id, state.userId).first<{ c: number }>();

      const wsCount = wsCountResult?.c ?? 0;
      if (wsCount >= maxWsPerNode) continue;

      let metrics: { cpuLoadAvg1?: number; memoryPercent?: number } | null = null;
      if (node.last_metrics) {
        try { metrics = JSON.parse(node.last_metrics); } catch { /* ignore */ }
      }

      if (metrics) {
        const cpu = metrics.cpuLoadAvg1 ?? 0;
        const mem = metrics.memoryPercent ?? 0;
        if (cpu >= cpuThreshold || mem >= memThreshold) continue;
        candidates.push({
          id: node.id,
          vmSize: node.vm_size,
          vmLocation: node.vm_location,
          score: cpu * 0.4 + mem * 0.6,
          wsCount,
        });
      } else {
        candidates.push({
          id: node.id,
          vmSize: node.vm_size,
          vmLocation: node.vm_location,
          score: null,
          wsCount,
        });
      }
    }

    if (!candidates.length) return null;

    // Sort: prefer matching location/size, then lowest load
    candidates.sort((a, b) => {
      const aLoc = a.vmLocation === state.config.vmLocation ? 1 : 0;
      const bLoc = b.vmLocation === state.config.vmLocation ? 1 : 0;
      if (aLoc !== bLoc) return bLoc - aLoc;
      const aSize = a.vmSize === state.config.vmSize ? 1 : 0;
      const bSize = b.vmSize === state.config.vmSize ? 1 : 0;
      if (aSize !== bSize) return bSize - aSize;
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return a.score - b.score;
    });

    return candidates[0]!.id;
  }

  // =========================================================================
  // D1 helpers
  // =========================================================================

  private async updateD1ExecutionStep(taskId: string, step: TaskExecutionStep): Promise<void> {
    await this.env.DATABASE.prepare(
      `UPDATE tasks SET execution_step = ?, updated_at = ? WHERE id = ?`
    ).bind(step, new Date().toISOString(), taskId).run();
  }

  // =========================================================================
  // State access
  // =========================================================================

  private async getState(): Promise<TaskRunnerState | null> {
    return (await this.ctx.storage.get<TaskRunnerState>('state')) ?? null;
  }

  // =========================================================================
  // Configuration (all configurable via env vars — Constitution Principle XI)
  // =========================================================================

  private getMaxRetries(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_STEP_MAX_RETRIES,
      DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES,
    );
  }

  private getRetryBaseDelayMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_RETRY_BASE_DELAY_MS,
      DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS,
    );
  }

  private getRetryMaxDelayMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_RETRY_MAX_DELAY_MS,
      DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS,
    );
  }

  private getAgentPollIntervalMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_AGENT_POLL_INTERVAL_MS,
      DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS,
    );
  }

  private getAgentReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_AGENT_READY_TIMEOUT_MS,
      DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS,
    );
  }

  private getWorkspaceReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
    );
  }

  private getProvisionPollIntervalMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
      DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
    );
  }
}
