/**
 * TrialOrchestrator Durable Object — alarm-driven trial provisioning.
 *
 * Mirrors the TaskRunner DO pattern: one DO instance per trialId, driven by
 * `ctx.storage.setAlarm()`, with each step handler idempotent and independent.
 * Replaces the earlier fire-and-forget `waitUntil(provisionTrial())` approach
 * that couldn't survive Worker restarts or partial failures.
 *
 * Keyed by trialId:
 *   env.TRIAL_ORCHESTRATOR.idFromName(trialId)
 *
 * Step flow (see steps.ts for handlers):
 *   project_creation → node_selection
 *     → (healthy existing node) → workspace_creation
 *     → (no healthy node)       → node_provisioning → node_agent_ready → workspace_creation
 *   → workspace_ready → discovery_agent_start → running
 *
 * Terminal-for-orchestrator at `running`: the ACP bridge (wired into
 * ProjectData DO's `transitionAcpSession`) fires `trial.ready` once the
 * discovery agent produces its first assistant turn.
 *
 * On transient failure: exponential backoff up to configurable max retries.
 * On permanent failure: emit trial.error + mark DO completed.
 * On overall timeout: emit trial.error with a timeout code.
 *
 * See: tasks/active/2026-04-19-trial-orchestrator-wire-up.md for full spec.
 */
import {
  DEFAULT_TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_HEARTBEAT_SKEW_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES,
  DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS,
  DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { computeBackoffMs, isTransientError, parseEnvInt, safeEmitTrialEvent } from './helpers';
import {
  handleDiscoveryAgentStart,
  handleNodeAgentReady,
  handleNodeProvisioning,
  handleNodeSelection,
  handleProjectCreation,
  handleRunning,
  handleWorkspaceCreation,
  handleWorkspaceReady,
} from './steps';
import type {
  StartTrialInput,
  TrialOrchestratorContext,
  TrialOrchestratorState,
  TrialOrchestratorStep,
} from './types';

// Re-export public types for consumers
export type { StartTrialInput, TrialOrchestratorState } from './types';

export class TrialOrchestrator extends DurableObject<Env> {
  // =========================================================================
  // Public RPCs (called from Worker routes)
  // =========================================================================

  /**
   * Start a new trial orchestration. Called once from POST /api/trial/create
   * via `c.executionCtx.waitUntil(stub.start(...))`. Idempotent — if the DO is
   * already initialized the call is a no-op.
   */
  async start(input: StartTrialInput): Promise<void> {
    log.info('trial_orchestrator_do.start.enter', { trialId: input.trialId });
    const existing = await this.getState();
    if (existing) {
      log.warn('trial_orchestrator_do.start.already_initialized', {
        trialId: input.trialId,
        currentStep: existing.currentStep,
      });
      return;
    }

    const now = Date.now();
    const state: TrialOrchestratorState = {
      version: 1,
      trialId: input.trialId,
      repoUrl: input.repoUrl,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      currentStep: 'project_creation',
      projectId: null,
      nodeId: null,
      autoProvisionedNode: false,
      workspaceId: null,
      chatSessionId: null,
      acpSessionId: null,
      defaultBranch: null,
      mcpToken: null,
      agentSessionCreatedOnVm: false,
      agentStartedOnVm: false,
      acpAssignedOnVm: false,
      acpRunningOnVm: false,
      retryCount: 0,
      createdAt: now,
      lastStepAt: now,
      nodeAgentReadyStartedAt: null,
      workspaceReadyStartedAt: null,
      completed: false,
      failureReason: null,
    };

    await this.ctx.storage.put('state', state);
    log.info('trial_orchestrator_do.start.state_put', { trialId: input.trialId });
    await this.ctx.storage.setAlarm(now);
    log.info('trial_orchestrator_do.start.alarm_set', { trialId: input.trialId });

    // Emit `trial.started` so the SSE stream's first real event confirms the
    // orchestrator picked up the trial. The frontend uses this to transition
    // out of the "Warming up..." empty state.
    await safeEmitTrialEvent(this.env, input.trialId, {
      type: 'trial.started',
      trialId: input.trialId,
      projectId: '', // project not yet created; filled in on `trial.ready`
      repoUrl: input.repoUrl,
      startedAt: now,
    });
    log.info('trial_orchestrator_do.start.trial_started_emitted', {
      trialId: input.trialId,
    });

    log.info('trial_orchestrator_do.started', {
      trialId: input.trialId,
      repoUrl: input.repoUrl,
    });
  }

  /**
   * Public status accessor for debugging / tests. The DO now stores an
   * `mcpToken` (minted for the discovery agent in `handleDiscoveryAgentStart`)
   * which is a live bearer credential — it must be redacted before leaving
   * the DO boundary so any debug endpoint that surfaces status cannot
   * inadvertently leak the token.
   */
  async getStatus(): Promise<TrialOrchestratorState | null> {
    const state = await this.getState();
    if (!state) return null;
    return {
      ...state,
      mcpToken: state.mcpToken ? '[redacted]' : null,
    };
  }

  // =========================================================================
  // Alarm handler — step dispatch
  // =========================================================================

  async alarm(): Promise<void> {
    const state = await this.getState();
    log.info('trial_orchestrator_do.alarm.enter', {
      trialId: state?.trialId ?? null,
      step: state?.currentStep ?? null,
      completed: state?.completed ?? null,
    });
    if (!state || state.completed) return;

    // Hard overall-timeout guard — independent of per-step retries.
    const overallTimeoutMs = this.getOverallTimeoutMs();
    if (Date.now() - state.createdAt > overallTimeoutMs) {
      await this.failTrial(state, `Trial timed out after ${overallTimeoutMs}ms`, 'timeout');
      return;
    }

    const rc = this.buildContext();
    const stepStartMs = Date.now();

    try {
      switch (state.currentStep) {
        case 'project_creation':
          await handleProjectCreation(state, rc);
          break;
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
        case 'workspace_ready':
          await handleWorkspaceReady(state, rc);
          break;
        case 'discovery_agent_start':
          await handleDiscoveryAgentStart(state, rc);
          break;
        case 'running':
          await handleRunning(state, rc);
          return;
        case 'succeeded':
        case 'failed':
          return;
        default:
          log.error('trial_orchestrator_do.unknown_step', {
            trialId: state.trialId,
            step: state.currentStep,
          });
          await this.failTrial(state, `Unknown step: ${state.currentStep}`, 'internal');
          return;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - stepStartMs;

      log.error('trial_orchestrator_do.step_error', {
        trialId: state.trialId,
        step: state.currentStep,
        retryCount: state.retryCount,
        errorMessage,
        durationMs,
      });

      if (isTransientError(err) && state.retryCount < this.getMaxRetries()) {
        state.retryCount++;
        await this.ctx.storage.put('state', state);
        const backoff = computeBackoffMs(
          state.retryCount,
          this.getRetryBaseDelayMs(),
          this.getRetryMaxDelayMs(),
        );
        await this.ctx.storage.setAlarm(Date.now() + backoff);
        log.info('trial_orchestrator_do.step_retry_scheduled', {
          trialId: state.trialId,
          step: state.currentStep,
          retryCount: state.retryCount,
          backoffMs: backoff,
        });
      } else {
        await this.failTrial(state, errorMessage, 'step_failed');
      }
    }
  }

  // =========================================================================
  // Terminal failure helper
  // =========================================================================

  private async failTrial(
    state: TrialOrchestratorState,
    reason: string,
    errorCode: string,
  ): Promise<void> {
    state.currentStep = 'failed';
    state.completed = true;
    state.failureReason = reason;
    await this.ctx.storage.put('state', state);

    log.error('trial_orchestrator_do.failed', {
      trialId: state.trialId,
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      reason,
      errorCode,
    });

    // `trial.error` is part of the terminal SSE contract — always emit, even
    // if the event bus is closed (the bus itself handles the 409).
    await safeEmitTrialEvent(this.env, state.trialId, {
      type: 'trial.error',
      // TrialErrorCode is a shared enum; cast through unknown to preserve
      // the string provided by callers without forcing an import cycle.
      error: errorCode as never,
      message: reason,
      at: Date.now(),
    });
  }

  // =========================================================================
  // Context builder
  // =========================================================================

  private buildContext(): TrialOrchestratorContext {
    return {
      env: this.env,
      ctx: this.ctx,
      advanceToStep: async (state: TrialOrchestratorState, nextStep: TrialOrchestratorStep) => {
        state.currentStep = nextStep;
        state.retryCount = 0;
        state.lastStepAt = Date.now();
        await this.ctx.storage.put('state', state);
        await this.ctx.storage.setAlarm(Date.now());
      },
      getOverallTimeoutMs: () => this.getOverallTimeoutMs(),
      getRetryBaseDelayMs: () => this.getRetryBaseDelayMs(),
      getRetryMaxDelayMs: () => this.getRetryMaxDelayMs(),
      getMaxRetries: () => this.getMaxRetries(),
      getWorkspaceReadyTimeoutMs: () => this.getWorkspaceReadyTimeoutMs(),
      getWorkspaceReadyPollIntervalMs: () => this.getWorkspaceReadyPollIntervalMs(),
      getNodeReadyTimeoutMs: () => this.getNodeReadyTimeoutMs(),
      getAgentReadyTimeoutMs: () => this.getAgentReadyTimeoutMs(),
      getHeartbeatSkewMs: () => this.getHeartbeatSkewMs(),
    };
  }

  // =========================================================================
  // State accessor
  // =========================================================================

  private async getState(): Promise<TrialOrchestratorState | null> {
    return (await this.ctx.storage.get<TrialOrchestratorState>('state')) ?? null;
  }

  // =========================================================================
  // Tunable knobs — env var override with DEFAULT_* fallback (Principle XI).
  // =========================================================================

  private getOverallTimeoutMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS,
    );
  }

  private getRetryBaseDelayMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS,
    );
  }

  private getRetryMaxDelayMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS,
    );
  }

  private getMaxRetries(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES,
      DEFAULT_TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES,
    );
  }

  private getWorkspaceReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS,
    );
  }

  private getWorkspaceReadyPollIntervalMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS,
    );
  }

  private getNodeReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS,
    );
  }

  private getAgentReadyTimeoutMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS,
    );
  }

  private getHeartbeatSkewMs(): number {
    return parseEnvInt(
      this.env.TRIAL_ORCHESTRATOR_HEARTBEAT_SKEW_MS,
      DEFAULT_TRIAL_ORCHESTRATOR_HEARTBEAT_SKEW_MS,
    );
  }
}
