/**
 * Live-steer delivery to a VM agent (`POST .../steer`, idea 01M2EPH9WGDYFDQBZCP9QY1FDE).
 *
 * A steer only ever reaches a runtime that is already running a turn. It never wakes
 * a session, restores a snapshot or starts a container: anything that is not a live,
 * steering-capable runtime returns `steer_fallback`, which hands the message to the
 * ordinary queue (`prompt-delivery-steer.ts`). The VM answers with a durable receipt;
 * `not_consumed` guarantees the agent never saw the text, `ambiguous` is surfaced and
 * never replayed.
 */
import {
  buildVmSteerDeliveryPath,
  buildVmSteerReceiptPath,
  VM_STEER_DELIVERY_PROTOCOL_VERSION,
  type VmPromptDeliveryCapabilities,
  type VmSteerReceipt,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { NodeAgentHttpError, nodeAgentRequest } from './node-agent';
import type { VmPromptDeliveryAdapterInput } from './vm-prompt-delivery-adapter';
import { SteerReceiptSchema, SteerResponseSchema } from './vm-prompt-delivery-adapter-schemas';
import {
  checkpointVmPromptSubmission,
  prepareVmPromptDelivery,
  PromptDeliveryGuardError,
} from './vm-prompt-delivery-preparation';
import {
  errorMessage,
  getDeliveryCapabilities,
  httpStatus,
  runSideEffectGuard,
} from './vm-prompt-delivery-runtime-queries';
import {
  resolveVmPromptDeliveryTarget,
  SESSION_NOT_AWAKE_REASON,
  type VmPromptDeliveryTarget,
} from './vm-prompt-delivery-target';

type Prepared = {
  kind: 'prepared';
  target: VmPromptDeliveryTarget;
  capabilities: VmPromptDeliveryCapabilities;
};

function fallback(
  reason: string,
  error: string,
  capabilities: VmPromptDeliveryCapabilities | null = null
): PromptDeliveryResult {
  return {
    kind: 'steer_fallback',
    reason,
    error,
    runtimeIdentity: capabilities?.runtimeIdentity ?? null,
    capabilities,
  };
}

function ambiguous(
  error: string,
  capabilities: VmPromptDeliveryCapabilities | null,
  reason: 'lost_response' | 'runtime_changed' | 'receipt_unavailable' = 'lost_response'
): PromptDeliveryResult {
  return {
    kind: 'ambiguous',
    reason,
    error,
    runtimeIdentity: capabilities?.runtimeIdentity ?? null,
    capabilities,
    receipt: null,
  };
}

async function resolveSteerTarget(
  env: Env,
  input: VmPromptDeliveryAdapterInput
): Promise<Prepared | PromptDeliveryResult> {
  const resolution = input.resolvedTarget
    ? ({ kind: 'ready', target: input.resolvedTarget } as const)
    : await resolveVmPromptDeliveryTarget(
        env,
        input.projectId,
        input.claim.message.targetSessionId,
        input.sourceTaskGuard,
        () => runSideEffectGuard(input),
        { allowWake: false }
      );
  if (resolution.kind === 'guarded') return resolution.result;
  if (resolution.kind === 'failed') return fallback(resolution.reason, resolution.error);
  if (resolution.kind === 'retry') {
    return resolution.reason === SESSION_NOT_AWAKE_REASON
      ? fallback(
          SESSION_NOT_AWAKE_REASON,
          'The session is not running, so there is no turn to steer'
        )
      : fallback('runtime_not_ready', resolution.reason);
  }
  const guarded = await runSideEffectGuard(input);
  if (guarded) return guarded;
  const capabilities = await getDeliveryCapabilities(
    env,
    resolution.target,
    input.requestTimeoutMs,
    input.sourceTaskGuard,
    true
  );
  if (!capabilities)
    return fallback('capability_probe_failed', 'Target VM capability probe did not complete');
  if (
    !capabilities.steering?.supported ||
    capabilities.steering.version !== VM_STEER_DELIVERY_PROTOCOL_VERSION
  ) {
    // Agents that predate live steering, or speak another version, get the queue.
    return fallback(
      'runtime_steering_unsupported',
      'Target VM agent does not support live steering',
      capabilities
    );
  }
  return { kind: 'prepared', target: resolution.target, capabilities };
}

/** Map a VM steer receipt to a delivery result. Only `deliveryId` must match: the VM
 * reports the runtime that owned the receipt, which differs after a restart even
 * though its terminal verdict is still authoritative. */
export function steerResultFromReceipt(
  receipt: VmSteerReceipt,
  deliveryId: string,
  capabilities: VmPromptDeliveryCapabilities,
  mode: 'submit' | 'reconcile'
): PromptDeliveryResult {
  if (receipt.deliveryId !== deliveryId) {
    return ambiguous(
      'Steer receipt belongs to a different delivery',
      capabilities,
      'receipt_unavailable'
    );
  }
  switch (receipt.state) {
    case 'injected':
      return {
        kind: 'steered',
        promptEpoch: receipt.promptEpoch,
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    case 'not_consumed':
      return fallback(
        receipt.reason ?? receipt.state,
        'The agent did not take the steer',
        capabilities
      );
    case 'not_found':
      // The VM records every steer before contacting the agent, so not-found means it
      // was never invoked. Right after a lost response the request may still be in
      // transit, so only a reconcile (a receipt timeout later) may conclude that.
      return mode === 'reconcile'
        ? fallback('steer_not_recorded', 'The VM never received the steer', capabilities)
        : {
            kind: 'steer_pending',
            reason: 'receipt_not_found_yet',
            error: 'The VM has no record of the steer yet',
            runtimeIdentity: capabilities.runtimeIdentity,
            capabilities,
          };
    case 'ambiguous':
      return ambiguous(
        `The VM cannot confirm whether the agent took the steer (${receipt.reason ?? 'unknown'})`,
        capabilities,
        receipt.reason?.startsWith('runtime_changed') ? 'runtime_changed' : 'lost_response'
      );
    case 'accepted':
    case 'in_flight':
      // Another request for this delivery is still deciding. Reconcile later, but a
      // reconcile that still finds it undecided gives up visibly instead of looping.
      return mode === 'submit'
        ? {
            kind: 'steer_pending',
            reason: receipt.state,
            error: 'The VM is still delivering this steer',
            runtimeIdentity: capabilities.runtimeIdentity,
            capabilities,
          }
        : ambiguous('The steer stayed undecided on the VM past the receipt timeout', capabilities);
  }
}

async function lookupSteerReceipt(
  env: Env,
  target: VmPromptDeliveryTarget,
  input: VmPromptDeliveryAdapterInput,
  capabilities: VmPromptDeliveryCapabilities,
  mode: 'submit' | 'reconcile'
): Promise<PromptDeliveryResult> {
  const deliveryId = input.claim.message.id;
  try {
    const raw = await nodeAgentRequest(
      target.nodeId,
      env,
      buildVmSteerReceiptPath(target.workspaceId, target.agentSessionId, deliveryId),
      {
        method: 'GET',
        userId: target.userId,
        workspaceId: target.workspaceId,
        requestTimeoutMs: input.requestTimeoutMs,
        noWakeContainer: true,
        recoverContainerOnTimeout: false,
        ...(input.sourceTaskGuard ? { sourceTaskGuard: input.sourceTaskGuard } : {}),
      }
    );
    return steerResultFromReceipt(v.parse(SteerReceiptSchema, raw), deliveryId, capabilities, mode);
  } catch (error) {
    const notFound = parseErrorBody(error, SteerReceiptSchema);
    if (
      httpStatus(error) === 404 &&
      notFound?.state === 'not_found' &&
      notFound.deliveryId === deliveryId
    ) {
      return steerResultFromReceipt(notFound, deliveryId, capabilities, mode);
    }
    return mode === 'submit'
      ? {
          kind: 'steer_pending',
          reason: 'receipt_lookup_failed',
          error: errorMessage(error),
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
        }
      : ambiguous(
          `Steer receipt lookup failed: ${errorMessage(error)}`,
          capabilities,
          'receipt_unavailable'
        );
  }
}

function parseErrorBody<T extends v.GenericSchema>(
  error: unknown,
  schema: T
): v.InferOutput<T> | null {
  if (!(error instanceof NodeAgentHttpError)) return null;
  try {
    return v.parse(schema, JSON.parse(error.responseBody));
  } catch {
    return null;
  }
}

export async function submitSteerDelivery(
  env: Env,
  input: VmPromptDeliveryAdapterInput
): Promise<PromptDeliveryResult> {
  const prepared = await prepareVmPromptDelivery(input.requestTimeoutMs, () =>
    resolveSteerTarget(env, input)
  );
  if (prepared.kind !== 'prepared') {
    // A preparation timeout never reached the VM; the queue owns it from here.
    return prepared.kind === 'retry' ? fallback('runtime_not_ready', prepared.error) : prepared;
  }
  const { target, capabilities } = prepared;
  const checkpointFailure = checkpointVmPromptSubmission(input.beforeSubmit, capabilities);
  if (checkpointFailure) return checkpointFailure;
  const deliveryId = input.claim.message.id;
  try {
    const raw = await nodeAgentRequest(
      target.nodeId,
      env,
      buildVmSteerDeliveryPath(target.workspaceId, target.agentSessionId),
      {
        method: 'POST',
        userId: target.userId,
        workspaceId: target.workspaceId,
        requestTimeoutMs: input.requestTimeoutMs,
        noWakeContainer: true,
        recoverContainerOnTimeout: false,
        ...(input.sourceTaskGuard ? { sourceTaskGuard: input.sourceTaskGuard } : {}),
        beforeExternalMutation: async () => {
          const denied = await runSideEffectGuard(input);
          if (denied) throw new PromptDeliveryGuardError(denied);
        },
        body: JSON.stringify({
          protocolVersion: VM_STEER_DELIVERY_PROTOCOL_VERSION,
          deliveryId,
          messageId: input.claim.message.promptMessageId,
          prompt: input.claim.message.content,
        }),
      }
    );
    const parsed = v.safeParse(SteerResponseSchema, raw);
    if (!parsed.success || parsed.output.sessionId !== target.agentSessionId) {
      return lookupSteerReceipt(env, target, input, capabilities, 'submit');
    }
    return steerResultFromReceipt(parsed.output.receipt, deliveryId, capabilities, 'submit');
  } catch (error) {
    if (error instanceof PromptDeliveryGuardError) return error.result;
    const status = httpStatus(error);
    const body = parseErrorBody(error, SteerResponseSchema);
    if (status === 409 && body?.status === 'conflict' && body.receipt.deliveryId === deliveryId) {
      return {
        kind: 'failed',
        reason: 'delivery_conflict',
        error: 'deliveryId already belongs to a different steer',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
      };
    }
    if (
      status === 404 &&
      error instanceof NodeAgentHttpError &&
      error.responseBody.toLowerCase().includes('no active agent session found')
    ) {
      return fallback('agent_session_unavailable', errorMessage(error), capabilities);
    }
    if (status === 400) {
      // Rejected before any receipt was written: an incompatible request is not a steer.
      return fallback('runtime_steering_unsupported', errorMessage(error), capabilities);
    }
    return lookupSteerReceipt(env, target, input, capabilities, 'submit');
  }
}

/** A steer claim that went stale after its possible-send boundary. */
export async function reconcileSteerDelivery(
  env: Env,
  input: VmPromptDeliveryAdapterInput
): Promise<PromptDeliveryResult> {
  const resolution = input.resolvedTarget
    ? ({ kind: 'ready', target: input.resolvedTarget } as const)
    : await resolveVmPromptDeliveryTarget(
        env,
        input.projectId,
        input.claim.message.targetSessionId,
        input.sourceTaskGuard,
        () => runSideEffectGuard(input),
        { allowWake: false }
      );
  if (resolution.kind === 'guarded') return resolution.result;
  if (resolution.kind !== 'ready') {
    return ambiguous(
      'The steer cannot be confirmed: its runtime is no longer reachable',
      null,
      'receipt_unavailable'
    );
  }
  const capabilities = await getDeliveryCapabilities(
    env,
    resolution.target,
    input.requestTimeoutMs,
    input.sourceTaskGuard,
    true
  );
  if (!capabilities?.steering?.lookup) {
    return ambiguous(
      'The steer cannot be confirmed: no receipt lookup',
      capabilities,
      'receipt_unavailable'
    );
  }
  return lookupSteerReceipt(env, resolution.target, input, capabilities, 'reconcile');
}
