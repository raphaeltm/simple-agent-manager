/**
 * Trial Runner — bootstraps the anonymous discovery agent for a trial.
 *
 * Invoked by Track A after the trial workspace is provisioned and reachable.
 * Responsibilities:
 *   1. Resolve the correct agent type based on deployment mode (staging vs production).
 *   2. Create a chat session + ACP session on the trial's project.
 *   3. Seed the discovery prompt as the initial prompt.
 *   4. Return the ACP session id so Track A can wire the VM-agent bootstrap.
 *
 * Event streaming: the Track B SSE endpoint (/api/trial/:trialId/events) polls
 * the TrialEventBus DO; callers that produce trial events should invoke
 * `emitTrialEvent()` to fan them out. Bridge from ACP session notifications to
 * the event bus is wired in Track A / ACP status handlers (separate concern).
 */

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../project-data';
import { DISCOVERY_PROMPT, DISCOVERY_PROMPT_VERSION } from './discovery-prompt';

// ---------------------------------------------------------------------------
// Defaults (Principle XI)
// ---------------------------------------------------------------------------

/** Deployment mode — staging uses cheaper models, production uses Anthropic. */
const DEFAULT_ENVIRONMENT = 'staging';
const DEFAULT_TRIAL_AGENT_TYPE_STAGING = 'opencode';
const DEFAULT_TRIAL_AGENT_TYPE_PRODUCTION = 'claude-code';
const DEFAULT_TRIAL_MODEL_STAGING = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DEFAULT_TRIAL_MODEL_PRODUCTION = 'claude-sonnet-4-5';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrialRunnerConfig {
  /** "staging" | "production". Falls back to ENVIRONMENT env var then DEFAULT. */
  mode: 'staging' | 'production';
  /** Agent runtime to launch in the workspace (e.g. opencode, claude-code). */
  agentType: string;
  /** Model name / provider-specific identifier for the discovery agent. */
  model: string;
  /** LLM provider that the VM agent should route requests through. */
  provider: 'anthropic' | 'workers-ai';
}

export interface StartDiscoveryAgentOptions {
  /** Project id — already created by Track A under `system_anonymous_trials`. */
  projectId: string;
  /** Workspace id bound to the trial. Used for session->workspace linkage. */
  workspaceId: string;
  /** Short human-facing topic recorded on the chat session (e.g. repo slug). */
  sessionTopic?: string | null;
}

export interface StartDiscoveryAgentResult {
  chatSessionId: string;
  acpSessionId: string;
  agentType: string;
  model: string;
  provider: 'anthropic' | 'workers-ai';
  promptVersion: string;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export function resolveTrialRunnerConfig(env: Env): TrialRunnerConfig {
  const modeStr = (env.ENVIRONMENT ?? DEFAULT_ENVIRONMENT).toLowerCase();
  const mode: 'staging' | 'production' =
    modeStr === 'production' || modeStr === 'prod' ? 'production' : 'staging';

  const agentType =
    mode === 'production'
      ? (env.TRIAL_AGENT_TYPE_PRODUCTION ?? DEFAULT_TRIAL_AGENT_TYPE_PRODUCTION)
      : (env.TRIAL_AGENT_TYPE_STAGING ?? DEFAULT_TRIAL_AGENT_TYPE_STAGING);

  const providerOverride = env.TRIAL_LLM_PROVIDER?.toLowerCase();
  const provider: 'anthropic' | 'workers-ai' =
    providerOverride === 'anthropic' || providerOverride === 'workers-ai'
      ? providerOverride
      : mode === 'production'
        ? 'anthropic'
        : 'workers-ai';

  const model =
    env.TRIAL_MODEL ??
    (provider === 'anthropic' ? DEFAULT_TRIAL_MODEL_PRODUCTION : DEFAULT_TRIAL_MODEL_STAGING);

  return { mode, agentType, model, provider };
}

// ---------------------------------------------------------------------------
// Start the discovery agent
// ---------------------------------------------------------------------------

/**
 * Create chat + ACP sessions on the trial project and seed the discovery prompt.
 *
 * Does NOT actually boot the VM-agent subprocess — Track A owns the workspace
 * lifecycle and will call the VM agent once the workspace is provisioned. This
 * function only records the intent in Durable Object state so it can be picked
 * up from the project dashboard after the trial is claimed.
 */
export async function startDiscoveryAgent(
  env: Env,
  opts: StartDiscoveryAgentOptions
): Promise<StartDiscoveryAgentResult> {
  const config = resolveTrialRunnerConfig(env);

  // Validate production config: Anthropic mode REQUIRES the API key.
  if (config.mode === 'production' && config.provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY_TRIAL) {
      throw new Error(
        'ANTHROPIC_API_KEY_TRIAL is required for production trial runner (Anthropic provider)'
      );
    }
  }

  // Chat session — groups messages/activity on the project page.
  const chatSessionId = await projectDataService.createSession(
    env,
    opts.projectId,
    opts.workspaceId,
    opts.sessionTopic ?? 'Exploring repository',
    null /* taskId */
  );

  // ACP session — represents the agent run in the workspace.
  const acpSession = await projectDataService.createAcpSession(
    env,
    opts.projectId,
    chatSessionId,
    DISCOVERY_PROMPT,
    config.agentType
  );

  log.info('trial_runner.discovery_started', {
    projectId: opts.projectId,
    workspaceId: opts.workspaceId,
    chatSessionId,
    acpSessionId: acpSession.id,
    agentType: config.agentType,
    model: config.model,
    provider: config.provider,
    promptVersion: DISCOVERY_PROMPT_VERSION,
  });

  return {
    chatSessionId,
    acpSessionId: acpSession.id,
    agentType: config.agentType,
    model: config.model,
    provider: config.provider,
    promptVersion: DISCOVERY_PROMPT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Event emission helpers (for use by any code path that produces TrialEvents)
// ---------------------------------------------------------------------------

import type { TrialEvent } from '@simple-agent-manager/shared';

import { readTrial, readTrialByProject } from './trial-store';

/**
 * Append a TrialEvent to the trial's event bus DO.
 * Safe to call from any code path — silently no-ops if the trial does not exist
 * or the bus is already closed (terminal event emitted).
 */
export async function emitTrialEvent(
  env: Env,
  trialId: string,
  event: TrialEvent
): Promise<void> {
  log.info('trial_event_bus.emit_begin', { trialId, type: event.type });
  try {
    const id = env.TRIAL_EVENT_BUS.idFromName(trialId);
    const stub = env.TRIAL_EVENT_BUS.get(id);
    const resp = await stub.fetch('https://trial-event-bus/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!resp.ok && resp.status !== 409 /* closed */) {
      log.warn('trial_event_bus.append_failed', {
        trialId,
        type: event.type,
        status: resp.status,
      });
    } else {
      log.info('trial_event_bus.emit_ok', {
        trialId,
        type: event.type,
        status: resp.status,
      });
    }
  } catch (err) {
    log.warn('trial_event_bus.append_error', {
      trialId,
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

/**
 * Look up the active trialId for a given projectId and emit the event. Used by
 * ACP notification hooks that only know the project id.
 */
export async function emitTrialEventForProject(
  env: Env,
  projectId: string,
  event: TrialEvent
): Promise<void> {
  const record = await readTrialByProject(env, projectId);
  if (!record) return;
  await emitTrialEvent(env, record.trialId, event);
}

/** Look up trial record by id — passthrough for callers that don't import trial-store directly. */
export async function getTrialRecord(
  env: Env,
  trialId: string
): Promise<ReturnType<typeof readTrial>> {
  return readTrial(env, trialId);
}
