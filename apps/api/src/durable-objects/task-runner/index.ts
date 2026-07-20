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
 *   → workspace_dispatch → workspace_ready → agent_session → running
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
 * See: specs/032-tdf-2-orchestration-engine/ for full design.
 */
import type { TaskExecutionStep } from '@simple-agent-manager/shared';
import {
  DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS,
  DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS,
  DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
  DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS,
  DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS,
  DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS,
  DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES,
  DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_BASE_DELAY_MS,
  DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_MAX_DELAY_MS,
  DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_TIMEOUT_MS,
  DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS,
  DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { handleAgentSession } from './agent-session-step';
import { computeBackoffMs, isTransientError, parseEnvInt } from './helpers';
import { handleNodeAgentReady, handleNodeProvisioning, handleNodeSelection } from './node-steps';
import { failTask } from './state-machine';
import { redactTaskRunnerStatus } from './status';
import type { StartTaskInput, TaskRunnerContext, TaskRunnerState } from './types';
import {
  handleAttachmentTransfer,
  handleWorkspaceCreation,
  handleWorkspaceDispatch,
  handleWorkspaceReady,
} from './workspace-steps';

// Re-export public types for consumers
export type { StartTaskInput, TaskRunnerState } from './types';

export class TaskRunner extends DurableObject<Env> {
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
      await this.ensureAlarm(existing);
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
        agentStarted: false,
        mcpToken: null,
        provisionedVmSize: null,
      },
      config: input.config,
      retryCount: 0,
      workspaceReadyReceived: false,
      workspaceReadyStatus: null,
      workspaceErrorMessage: null,
      createdAt: now,
      lastStepAt: now,
      provisioningStartedAt: null,
      agentReadyStartedAt: null,
      workspaceReadyStartedAt: null,
      workspaceDispatchStartedAt: null,
      workspaceDispatchAttempts: 0,
      workspaceDispatchLastAttemptAt: null,
      workspaceDispatchLastError: null,
      workspaceDispatchAckedAt: null,
      lastD1Step: null,
      completed: false,
    };

    // Commit the state and first alarm together. A readable state must prove
    // that the orchestration wake-up was durably scheduled as well.
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put('state', state);
      await transaction.setAlarm(now);
    });

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
    const state = await this.getState();
    return redactTaskRunnerStatus(state);
  }

  /**
   * Confirm that a task run was initialized and repair a missing wake-up.
   * Used after an ambiguous start RPC and by webhook reconciliation.
   */
  async ensureStarted(): Promise<boolean> {
    const state = await this.getState();
    if (!state) return false;
    await this.ensureAlarm(state);
    return true;
  }

  private async ensureAlarm(state: TaskRunnerState): Promise<void> {
    const isTerminal =
      state.completed || state.currentStep === 'running' || state.currentStep === 'awaiting_followup';
    if (!isTerminal && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  // =========================================================================
  // Alarm handler — step dispatch
  // =========================================================================

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.completed) return;

    const rc = this.buildContext();
    const stepStartMs = Date.now();

    try {
      switch (state.currentStep) {
        case 'node_selection':
          await handleNodeSelection(state, rc);
          break;
        case 'node_provisioning':
          await handleNodeProvisioning(state, rc);
          break;
        case 'node_agent_ready':
          await handleNodeAgentReady(state, rc);
          break;
        case 'workspace_creation':
          await handleWorkspaceCreation(state, rc);
          break;
        case 'workspace_dispatch':
          await handleWorkspaceDispatch(state, rc);
          break;
        case 'workspace_ready':
          await handleWorkspaceReady(state, rc);
          break;
        case 'attachment_transfer':
          await handleAttachmentTransfer(state, rc);
          break;
        case 'agent_session':
          await handleAgentSession(state, rc);
          break;
        case 'running':
        case 'awaiting_followup':
          // Terminal DO steps — agent manages from here via callbacks
          return;
        default:
          log.error('task_runner_do.unknown_step', { taskId: state.taskId, step: state.currentStep });
          await failTask(state, `Unknown execution step: ${state.currentStep}`, rc);
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
        await failTask(state, errorMessage, rc);
      }
    }
  }

  // =========================================================================
  // Context builder
  // =========================================================================

  private buildContext(): TaskRunnerContext {
    return {
      env: this.env,
      ctx: this.ctx,
      advanceToStep: async (state: TaskRunnerState, nextStep: TaskExecutionStep) => {
        state.currentStep = nextStep;
        state.retryCount = 0;
        state.lastStepAt = Date.now();
        await this.ctx.storage.put('state', state);
        // Schedule alarm immediately for next step
        await this.ctx.storage.setAlarm(Date.now());
      },
      getAgentPollIntervalMs: () => this.getAgentPollIntervalMs(),
      getAgentReadyTimeoutMs: () => this.getAgentReadyTimeoutMs(),
      getWorkspaceDispatchTimeoutMs: () => this.getWorkspaceDispatchTimeoutMs(),
      getWorkspaceDispatchBaseDelayMs: () => this.getWorkspaceDispatchBaseDelayMs(),
      getWorkspaceDispatchMaxDelayMs: () => this.getWorkspaceDispatchMaxDelayMs(),
      getWorkspaceReadyTimeoutMs: () => this.getWorkspaceReadyTimeoutMs(),
      getWorkspaceReadyPollIntervalMs: () => this.getWorkspaceReadyPollIntervalMs(),
      getProvisionPollIntervalMs: () => this.getProvisionPollIntervalMs(),
      getProvisionTimeoutMs: () => this.getProvisionTimeoutMs(),
      updateD1ExecutionStep: async (taskId: string, step: TaskExecutionStep) => {
        // Idempotent guard: skip redundant D1 writes when the step hasn't changed.
        // This prevents updated_at from being refreshed on every poll cycle,
        // which was defeating the stuck-tasks cron's staleness detection.
        // Persisted in DO state so the guard survives DO eviction/reload.
        const currentState = await this.ctx.storage.get<TaskRunnerState>('state');
        if (currentState && step === currentState.lastD1Step) return;
        if (currentState) {
          currentState.lastD1Step = step;
          await this.ctx.storage.put('state', currentState);
        }
        await this.env.DATABASE.prepare(
          `UPDATE tasks SET execution_step = ?, updated_at = ? WHERE id = ?`
        ).bind(step, new Date().toISOString(), taskId).run();
      },
    };
  }

  // =========================================================================
  // State access
  // =========================================================================

  private async getState(): Promise<TaskRunnerState | null> {
    const raw = await this.ctx.storage.get<TaskRunnerState>('state');
    if (!raw) return null;
    // Normalize fields added after initial schema version (backward compat
    // for DOs started before deployment of the field).
    raw.config.systemPromptAppend ??= null;
    raw.config.agentProfileHint ??= null;
    raw.provisioningStartedAt ??= null;
    raw.agentReadyStartedAt ??= null;
    raw.workspaceReadyStartedAt ??= null;
    raw.workspaceDispatchStartedAt ??= null;
    raw.workspaceDispatchAttempts ??= 0;
    raw.workspaceDispatchLastAttemptAt ??= null;
    raw.workspaceDispatchLastError ??= null;
    raw.workspaceDispatchAckedAt ??= null;
    raw.lastD1Step ??= null;
    return raw;
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

  private getWorkspaceDispatchTimeoutMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_DISPATCH_TIMEOUT_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_TIMEOUT_MS,
    );
  }

  private getWorkspaceDispatchBaseDelayMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_DISPATCH_BASE_DELAY_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_BASE_DELAY_MS,
    );
  }

  private getWorkspaceDispatchMaxDelayMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_DISPATCH_MAX_DELAY_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_DISPATCH_MAX_DELAY_MS,
    );
  }

  private getWorkspaceReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS,
    );
  }

  private getWorkspaceReadyPollIntervalMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS,
      DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS,
    );
  }

  private getProvisionPollIntervalMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
      DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS,
    );
  }

  private getProvisionTimeoutMs(): number {
    return parseEnvInt(
      this.env.TASK_RUNNER_PROVISION_TIMEOUT_MS,
      DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS,
    );
  }
}
