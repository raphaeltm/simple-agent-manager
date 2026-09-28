/**
 * The delivery adapter's two read-only questions to its target runtime: what it supports
 * (capabilities) and what became of one delivery (receipt), plus the transport-error readers
 * (`httpStatus`, `errorMessage`) they share with the adapter's submit. Split out of
 * `vm-prompt-delivery-adapter.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import {
  buildVmPromptDeliveryCapabilitiesPath,
  buildVmPromptDeliveryReceiptPath,
  VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
  type VmPromptDeliveryCapabilities,
  type VmPromptDeliveryReceipt,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type {
  PromptDeliveryClaim,
  PromptDeliveryResult,
} from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { NodeAgentHttpError, nodeAgentRequest } from './node-agent';
import { CapabilitiesSchema, ReceiptSchema } from './vm-prompt-delivery-adapter-schemas';
import type {
  VmPromptDeliverySourceTaskGuard,
  VmPromptDeliveryTarget,
} from './vm-prompt-delivery-target';

const log = createModuleLogger('vm_prompt_delivery_adapter');

export function httpStatus(error: unknown): number | null {
  if (error instanceof NodeAgentHttpError) return error.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:failed:|request failed:)\s*(\d{3})/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyCapabilities(runtimeIdentity: string): VmPromptDeliveryCapabilities {
  return {
    protocolVersion: 0,
    runtimeIdentity,
    promptReceipts: { supported: false, lookup: false, states: [] },
    checkpointRollover: {
      supported: false,
      automatic: false,
      states: [],
      defaultGraceMs: 0,
      maxGraceMs: 0,
      operationTimeoutMs: 0,
    },
  };
}

export async function getDeliveryCapabilities(
  env: Env,
  target: VmPromptDeliveryTarget,
  requestTimeoutMs: number,
  sourceTaskGuard?: VmPromptDeliverySourceTaskGuard
): Promise<VmPromptDeliveryCapabilities | null> {
  try {
    const raw = await nodeAgentRequest(
      target.nodeId,
      env,
      buildVmPromptDeliveryCapabilitiesPath(target.workspaceId),
      {
        method: 'GET',
        userId: target.userId,
        workspaceId: target.workspaceId,
        requestTimeoutMs,
        ...(sourceTaskGuard ? { sourceTaskGuard } : {}),
      }
    );
    const capabilities = v.parse(CapabilitiesSchema, raw);
    if (capabilities.protocolVersion !== VM_PROMPT_DELIVERY_PROTOCOL_VERSION) {
      return {
        ...capabilities,
        promptReceipts: {
          ...capabilities.promptReceipts,
          supported: false,
          lookup: false,
        },
      };
    }
    return capabilities;
  } catch (error) {
    if (httpStatus(error) === 404) return legacyCapabilities(target.runtimeIdentity);
    log.warn('prompt_delivery.capability_probe_failed', {
      workspaceId: target.workspaceId,
      agentSessionId: target.agentSessionId,
      error: errorMessage(error),
    });
    return null;
  }
}

export async function lookupDeliveryReceipt(
  env: Env,
  target: VmPromptDeliveryTarget,
  claim: PromptDeliveryClaim,
  capabilities: VmPromptDeliveryCapabilities,
  requestTimeoutMs: number,
  sourceTaskGuard?: VmPromptDeliverySourceTaskGuard
): Promise<PromptDeliveryResult> {
  try {
    const raw = await nodeAgentRequest(
      target.nodeId,
      env,
      buildVmPromptDeliveryReceiptPath(target.workspaceId, target.agentSessionId, claim.message.id),
      {
        method: 'GET',
        userId: target.userId,
        workspaceId: target.workspaceId,
        requestTimeoutMs,
        ...(sourceTaskGuard ? { sourceTaskGuard } : {}),
      }
    );
    const receipt: VmPromptDeliveryReceipt = v.parse(ReceiptSchema, raw);
    if (receipt.deliveryId !== claim.message.id) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Receipt belongs to a different delivery',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    }
    if (receipt.runtimeIdentity !== capabilities.runtimeIdentity) {
      return {
        kind: 'ambiguous',
        reason: 'runtime_changed',
        error: 'Receipt belongs to a different runtime identity',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    }
    if (receipt.state === 'not_found') {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Receipt lookup returned not_found without the canonical HTTP 404 proof',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    }
    if (receipt.state === 'ambiguous') {
      return {
        kind: 'ambiguous',
        reason: 'lost_response',
        error: 'VM receipt reports ambiguous prompt acceptance',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    }
    if (receipt.acceptedAt === null) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Accepted VM receipt omitted acceptedAt',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt,
      };
    }
    return {
      kind: 'accepted',
      acpSessionId: target.agentSessionId,
      promptEpoch: receipt.acceptedAt,
      runtimeIdentity: capabilities.runtimeIdentity,
      capabilities,
      receipt,
    };
  } catch (error) {
    const notFound = parseNotFoundReceipt(error);
    if (
      httpStatus(error) === 404 &&
      notFound?.state === 'not_found' &&
      notFound.deliveryId === claim.message.id &&
      notFound.runtimeIdentity === capabilities.runtimeIdentity &&
      notFound.acceptedAt === null &&
      notFound.completedAt === null
    ) {
      return {
        kind: 'retry',
        reason: 'receipt_not_found',
        error: 'Same-runtime VM receipt lookup confirms the prompt was not accepted',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
      };
    }
    return {
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      error: errorMessage(error),
      runtimeIdentity: capabilities.runtimeIdentity,
      capabilities,
      receipt: null,
    };
  }
}

function parseNotFoundReceipt(error: unknown): VmPromptDeliveryReceipt | null {
  if (!(error instanceof NodeAgentHttpError)) return null;
  try {
    return v.parse(ReceiptSchema, JSON.parse(error.responseBody));
  } catch {
    return null;
  }
}
