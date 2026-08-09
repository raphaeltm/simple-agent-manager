import {
  buildVmPromptDeliveryCapabilitiesPath,
  buildVmPromptDeliveryReceiptPath,
  VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
  type VmPromptDeliveryCapabilities,
  type VmPromptDeliveryReceipt,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { PromptDeliveryClaim, PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { nodeAgentRequest, sendPromptToAgentOnNode } from './node-agent';

const log = createModuleLogger('vm_prompt_delivery_adapter');

const CapabilitiesSchema = v.object({
  protocolVersion: v.number(),
  stableReceipts: v.boolean(),
  receiptLookup: v.boolean(),
  runtimeIdentity: v.nullable(v.string()),
});

const ReceiptSchema = v.object({
  deliveryId: v.string(),
  state: v.picklist(['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous']),
  runtimeIdentity: v.nullable(v.string()),
  acceptedAt: v.nullable(v.number()),
  completedAt: v.nullable(v.number()),
});

const SubmitResponseSchema = v.object({
  status: v.string(),
  sessionId: v.string(),
  receipt: v.optional(ReceiptSchema),
});

export interface VmPromptDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  userId: string;
  runtimeIdentity: string;
}

type TargetResolution =
  | { kind: 'ready'; target: VmPromptDeliveryTarget }
  | { kind: 'retry'; reason: string }
  | { kind: 'failed'; reason: 'terminal_target' | 'dead_target'; error: string };

export interface VmPromptDeliveryAdapterInput {
  projectId: string;
  claim: PromptDeliveryClaim;
  allowLegacyVm: boolean;
  requestTimeoutMs: number;
}

export interface VmPromptDeliveryAdapter {
  submit(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
  reconcile(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
}

function httpStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:failed:|request failed:)\s*(\d{3})/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyCapabilities(runtimeIdentity: string): VmPromptDeliveryCapabilities {
  return {
    protocolVersion: 0,
    stableReceipts: false,
    receiptLookup: false,
    runtimeIdentity,
  };
}

export class DefaultVmPromptDeliveryAdapter implements VmPromptDeliveryAdapter {
  constructor(private readonly env: Env) {}

  async submit(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult> {
    const resolution = await this.resolveTarget(input.projectId, input.claim.message.targetSessionId);
    if (resolution.kind === 'failed') {
      return {
        kind: 'failed',
        reason: resolution.reason,
        error: resolution.error,
        runtimeIdentity: null,
        capabilities: null,
      };
    }
    if (resolution.kind === 'retry') {
      return {
        kind: 'retry',
        reason: 'not_ready',
        error: resolution.reason,
        runtimeIdentity: null,
        capabilities: null,
      };
    }
    const { target } = resolution;
    const capabilities = await this.getCapabilities(target, input.requestTimeoutMs);
    if (!capabilities) {
      return {
        kind: 'retry',
        reason: 'not_ready',
        error: 'Target VM capability probe did not complete',
        runtimeIdentity: target.runtimeIdentity,
        capabilities: null,
      };
    }
    if (!capabilities.stableReceipts && !input.allowLegacyVm) {
      return {
        kind: 'failed',
        reason: 'unsupported_capability',
        error: 'Target VM does not advertise stable prompt delivery receipts',
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
      };
    }

    try {
      const raw = await sendPromptToAgentOnNode(
        target.nodeId,
        target.workspaceId,
        target.agentSessionId,
        input.claim.message.content,
        this.env,
        target.userId,
        input.claim.message.promptMessageId,
        { requestTimeoutMs: input.requestTimeoutMs },
      );
      const parsed = v.safeParse(SubmitResponseSchema, raw);
      const receipt = parsed.success && parsed.output.receipt
        ? parsed.output.receipt
        : null;
      const promptEpoch = receipt?.acceptedAt ?? Date.now();
      return {
        kind: 'accepted',
        acpSessionId: target.agentSessionId,
        promptEpoch,
        runtimeIdentity: receipt?.runtimeIdentity ?? target.runtimeIdentity,
        capabilities,
        receipt,
      };
    } catch (error) {
      const status = httpStatus(error);
      if (status === 409) {
        return {
          kind: 'retry',
          reason: 'busy',
          error: 'Target VM is currently processing a prompt',
          runtimeIdentity: target.runtimeIdentity,
          capabilities,
        };
      }
      if (status === 404 || status === 410) {
        return {
          kind: 'failed',
          reason: 'terminal_target',
          error: errorMessage(error),
          runtimeIdentity: target.runtimeIdentity,
          capabilities,
        };
      }
      return this.reconcileAfterAmbiguousSubmit(
        target,
        input.claim,
        capabilities,
        error,
        input.requestTimeoutMs,
      );
    }
  }

  async reconcile(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult> {
    const resolution = await this.resolveTarget(input.projectId, input.claim.message.targetSessionId);
    if (resolution.kind === 'failed') {
      return {
        kind: 'failed',
        reason: resolution.reason,
        error: resolution.error,
        runtimeIdentity: null,
        capabilities: null,
      };
    }
    if (resolution.kind === 'retry') {
      return {
        kind: 'retry',
        reason: 'not_ready',
        error: resolution.reason,
        runtimeIdentity: null,
        capabilities: null,
      };
    }
    const { target } = resolution;
    const capabilities = await this.getCapabilities(target, input.requestTimeoutMs);
    if (!capabilities) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Target VM capability probe failed during receipt reconciliation',
        runtimeIdentity: target.runtimeIdentity,
        capabilities: null,
        receipt: null,
      };
    }
    if (
      input.claim.message.runtimeIdentity &&
      input.claim.message.runtimeIdentity !== target.runtimeIdentity
    ) {
      return {
        kind: 'ambiguous',
        reason: 'runtime_changed',
        error: 'Runtime identity changed before the prior delivery could be reconciled',
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
        receipt: null,
      };
    }
    if (!capabilities.stableReceipts || !capabilities.receiptLookup) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Target VM cannot reconcile the prior delivery receipt',
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
        receipt: null,
      };
    }
    return this.lookupReceiptResult(target, input.claim, capabilities, input.requestTimeoutMs);
  }

  private async resolveTarget(projectId: string, chatSessionId: string): Promise<TargetResolution> {
    const row = await this.env.DATABASE.prepare(
      `SELECT w.id AS workspace_id,
              w.user_id AS user_id,
              w.status AS workspace_status,
              w.node_id AS node_id,
              n.status AS node_status,
              n.health_status AS node_health_status,
              n.agent_version AS agent_version,
              a.id AS agent_session_id,
              a.status AS agent_session_status,
              a.updated_at AS agent_session_updated_at
       FROM workspaces w
       LEFT JOIN nodes n ON n.id = w.node_id
       LEFT JOIN agent_sessions a ON a.workspace_id = w.id
       WHERE w.project_id = ? AND w.chat_session_id = ?
       ORDER BY a.created_at DESC
       LIMIT 1`,
    ).bind(projectId, chatSessionId).first<{
      workspace_id: string;
      user_id: string;
      workspace_status: string;
      node_id: string | null;
      node_status: string | null;
      node_health_status: string | null;
      agent_version: string | null;
      agent_session_id: string | null;
      agent_session_status: string | null;
      agent_session_updated_at: string | null;
    }>();

    if (!row) {
      return { kind: 'failed', reason: 'terminal_target', error: 'Target workspace no longer exists' };
    }
    if (['stopping', 'stopped', 'deleted', 'error'].includes(row.workspace_status)) {
      return {
        kind: 'failed',
        reason: 'terminal_target',
        error: `Target workspace is ${row.workspace_status}`,
      };
    }
    if (!row.node_id) {
      return { kind: 'retry', reason: 'Target workspace has no assigned node yet' };
    }
    if (
      ['stopping', 'stopped', 'deleted', 'error'].includes(row.node_status ?? '')
      || row.node_health_status === 'unhealthy'
    ) {
      return { kind: 'failed', reason: 'dead_target', error: 'Target node is unavailable' };
    }
    const wakeableStatuses = ['running', 'recovery', 'sleeping'];
    if (
      !wakeableStatuses.includes(row.workspace_status)
      || !wakeableStatuses.includes(row.node_status ?? '')
    ) {
      return {
        kind: 'retry',
        reason: `Target runtime is not ready (${row.workspace_status}/${row.node_status ?? 'unknown'})`,
      };
    }
    if (!row.agent_session_id) {
      return { kind: 'retry', reason: 'Target agent session has not started yet' };
    }
    if (row.agent_session_status !== 'running') {
      if (['completed', 'failed', 'error', 'stopped'].includes(row.agent_session_status ?? '')) {
        return {
          kind: 'failed',
          reason: 'terminal_target',
          error: `Target agent session is ${row.agent_session_status}`,
        };
      }
      return { kind: 'retry', reason: `Target agent session is ${row.agent_session_status}` };
    }

    return {
      kind: 'ready',
      target: {
        projectId,
        chatSessionId,
        workspaceId: row.workspace_id,
        nodeId: row.node_id,
        agentSessionId: row.agent_session_id,
        userId: row.user_id,
        runtimeIdentity: [
          row.node_id,
          row.agent_session_id,
          row.agent_version ?? 'legacy',
          row.agent_session_updated_at ?? 'unknown',
        ].join(':'),
      },
    };
  }

  private async getCapabilities(
    target: VmPromptDeliveryTarget,
    requestTimeoutMs: number,
  ): Promise<VmPromptDeliveryCapabilities | null> {
    try {
      const raw = await nodeAgentRequest(
        target.nodeId,
        this.env,
        buildVmPromptDeliveryCapabilitiesPath(target.workspaceId, target.agentSessionId),
        {
          method: 'GET',
          userId: target.userId,
          workspaceId: target.workspaceId,
          requestTimeoutMs,
        },
      );
      const capabilities = v.parse(CapabilitiesSchema, raw);
      if (capabilities.protocolVersion !== VM_PROMPT_DELIVERY_PROTOCOL_VERSION) {
        return { ...capabilities, stableReceipts: false, receiptLookup: false };
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

  private async reconcileAfterAmbiguousSubmit(
    target: VmPromptDeliveryTarget,
    claim: PromptDeliveryClaim,
    capabilities: VmPromptDeliveryCapabilities,
    submitError: unknown,
    requestTimeoutMs: number,
  ): Promise<PromptDeliveryResult> {
    if (!capabilities.stableReceipts || !capabilities.receiptLookup) {
      return {
        kind: 'ambiguous',
        reason: 'lost_response',
        error: errorMessage(submitError),
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
        receipt: null,
      };
    }
    return this.lookupReceiptResult(target, claim, capabilities, requestTimeoutMs);
  }

  private async lookupReceiptResult(
    target: VmPromptDeliveryTarget,
    claim: PromptDeliveryClaim,
    capabilities: VmPromptDeliveryCapabilities,
    requestTimeoutMs: number,
  ): Promise<PromptDeliveryResult> {
    try {
      const raw = await nodeAgentRequest(
        target.nodeId,
        this.env,
        buildVmPromptDeliveryReceiptPath(
          target.workspaceId,
          target.agentSessionId,
          claim.message.id,
        ),
        {
          method: 'GET',
          userId: target.userId,
          workspaceId: target.workspaceId,
          requestTimeoutMs,
        },
      );
      const receipt: VmPromptDeliveryReceipt = v.parse(ReceiptSchema, raw);
      if (receipt.runtimeIdentity && receipt.runtimeIdentity !== target.runtimeIdentity) {
        return {
          kind: 'ambiguous',
          reason: 'runtime_changed',
          error: 'Receipt belongs to a different runtime identity',
          runtimeIdentity: target.runtimeIdentity,
          capabilities,
          receipt,
        };
      }
      if (receipt.state === 'not_found') {
        return {
          kind: 'retry',
          reason: 'receipt_not_found',
          error: 'Stable receipt confirms the prompt was not accepted',
          runtimeIdentity: target.runtimeIdentity,
          capabilities,
        };
      }
      if (receipt.state === 'ambiguous') {
        return {
          kind: 'ambiguous',
          reason: 'lost_response',
          error: 'VM receipt reports ambiguous prompt acceptance',
          runtimeIdentity: target.runtimeIdentity,
          capabilities,
          receipt,
        };
      }
      return {
        kind: 'accepted',
        acpSessionId: target.agentSessionId,
        promptEpoch: receipt.acceptedAt ?? Date.now(),
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
        receipt,
      };
    } catch (error) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: errorMessage(error),
        runtimeIdentity: target.runtimeIdentity,
        capabilities,
        receipt: null,
      };
    }
  }
}
