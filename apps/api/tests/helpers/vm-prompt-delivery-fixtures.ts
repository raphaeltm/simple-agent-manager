import {
  VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
  type VmPromptDeliveryCapabilities,
  type VmPromptDeliveryReceipt,
  type VmPromptDeliveryResponse,
} from '@simple-agent-manager/shared';

export function versionedPromptCapabilities(runtimeIdentity: string): VmPromptDeliveryCapabilities {
  return {
    protocolVersion: VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
    runtimeIdentity,
    promptReceipts: {
      supported: true,
      lookup: true,
      states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'],
    },
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

export function missingPromptReceipt(
  deliveryId: string,
  runtimeIdentity: string
): VmPromptDeliveryReceipt {
  return {
    deliveryId,
    state: 'not_found',
    runtimeIdentity,
    acceptedAt: null,
    completedAt: null,
  };
}

export function acceptedPromptResponse(
  sessionId: string,
  deliveryId: string,
  runtimeIdentity: string,
  acceptedAt: number
): VmPromptDeliveryResponse {
  return {
    status: 'accepted',
    sessionId,
    receipt: {
      deliveryId,
      state: 'accepted',
      runtimeIdentity,
      acceptedAt,
      completedAt: null,
    },
  };
}
