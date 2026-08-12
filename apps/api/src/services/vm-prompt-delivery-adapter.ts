import {
  buildVmPromptDeliveryCapabilitiesPath,
  buildVmPromptDeliveryReceiptPath,
  VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
  type VmPromptDeliveryCapabilities,
  type VmPromptDeliveryReceipt,
  type VmPromptDeliveryResponse,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type {
  PromptDeliveryClaim,
  PromptDeliveryResult,
} from '../durable-objects/project-data/prompt-delivery';
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { NodeAgentHttpError, nodeAgentRequest, sendPromptToAgentOnNode } from './node-agent';
import * as projectDataService from './project-data';
import { ensureSessionRecovery } from './session-recovery';
import { markSessionSnapshotAwakeInPlace } from './session-snapshots';

const log = createModuleLogger('vm_prompt_delivery_adapter');

const RuntimeIdentitySchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256));

const CapabilitiesSchema = v.object({
  protocolVersion: v.number(),
  runtimeIdentity: RuntimeIdentitySchema,
  promptReceipts: v.object({
    supported: v.boolean(),
    lookup: v.boolean(),
    states: v.array(v.picklist(['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'])),
  }),
  checkpointRollover: v.object({
    supported: v.boolean(),
    automatic: v.boolean(),
    states: v.array(v.string()),
    defaultGraceMs: v.number(),
    maxGraceMs: v.number(),
    operationTimeoutMs: v.number(),
  }),
});

const ReceiptSchema = v.object({
  deliveryId: v.string(),
  state: v.picklist(['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous']),
  runtimeIdentity: RuntimeIdentitySchema,
  acceptedAt: v.nullable(v.number()),
  completedAt: v.nullable(v.number()),
});

const SubmitResponseSchema = v.object({
  status: v.picklist(['accepted', 'duplicate', 'not_ready', 'conflict']),
  sessionId: v.string(),
  receipt: ReceiptSchema,
});

export interface VmPromptDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  userId: string;
  runtimeIdentity: string;
  runtime: string;
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
  if (error instanceof NodeAgentHttpError) return error.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:failed:|request failed:)\s*(\d{3})/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingActiveAgentSession(error: unknown): boolean {
  return (
    error instanceof NodeAgentHttpError &&
    error.statusCode === 404 &&
    error.responseBody.toLowerCase().includes('no active agent session found')
  );
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

export class DefaultVmPromptDeliveryAdapter implements VmPromptDeliveryAdapter {
  constructor(private readonly env: Env) {}

  async submit(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult> {
    const resolution = await this.resolveTarget(
      input.projectId,
      input.claim.message.targetSessionId
    );
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
        runtimeIdentity: null,
        capabilities: null,
      };
    }
    if (target.runtime === 'cf-container') {
      await this.commitContainerWake(target);
    }
    if (!capabilities.promptReceipts.supported && !input.allowLegacyVm) {
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
        capabilities.protocolVersion === VM_PROMPT_DELIVERY_PROTOCOL_VERSION
          ? {
              requestTimeoutMs: input.requestTimeoutMs,
              protocolVersion: VM_PROMPT_DELIVERY_PROTOCOL_VERSION,
              deliveryId: input.claim.message.id,
            }
          : { requestTimeoutMs: input.requestTimeoutMs }
      );
      if (capabilities.protocolVersion === 0 && input.allowLegacyVm) {
        return {
          kind: 'accepted',
          acpSessionId: target.agentSessionId,
          promptEpoch: Date.now(),
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
          receipt: null,
        };
      }
      const parsed = v.safeParse(SubmitResponseSchema, raw);
      if (!parsed.success) {
        return this.reconcileAfterAmbiguousSubmit(
          target,
          input.claim,
          capabilities,
          new Error('Target VM returned an invalid versioned prompt response'),
          input.requestTimeoutMs
        );
      }
      const response: VmPromptDeliveryResponse = parsed.output;
      const receipt = response.receipt;
      if (
        response.sessionId !== target.agentSessionId ||
        receipt.deliveryId !== input.claim.message.id ||
        receipt.runtimeIdentity !== capabilities.runtimeIdentity ||
        !['accepted', 'duplicate'].includes(response.status) ||
        !['accepted', 'in_flight', 'completed'].includes(receipt.state) ||
        receipt.acceptedAt === null
      ) {
        const runtimeChanged = receipt.runtimeIdentity !== capabilities.runtimeIdentity;
        return {
          kind: 'ambiguous',
          reason: runtimeChanged ? 'runtime_changed' : 'receipt_unavailable',
          error:
            'Target VM versioned prompt response did not match the negotiated delivery/runtime/session',
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
      const status = httpStatus(error);
      const conflict = this.parseConflictResponse(error);
      if (
        status === 409 &&
        conflict?.status === 'not_ready' &&
        conflict.sessionId === target.agentSessionId &&
        conflict.receipt.deliveryId === input.claim.message.id &&
        conflict.receipt.runtimeIdentity === capabilities.runtimeIdentity
      ) {
        return {
          kind: 'retry',
          reason: 'busy',
          error: 'Target VM is currently processing a prompt',
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
        };
      }
      if (
        status === 409 &&
        conflict?.status === 'conflict' &&
        conflict.sessionId === target.agentSessionId &&
        conflict.receipt.deliveryId === input.claim.message.id &&
        conflict.receipt.runtimeIdentity === capabilities.runtimeIdentity
      ) {
        return {
          kind: 'failed',
          reason: 'delivery_conflict',
          error: 'deliveryId already belongs to a different prompt intent',
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
        };
      }
      // During cold restore, D1 can expose the replacement agent-session row
      // just before the VM has registered its in-memory SessionHost. The VM's
      // narrow 404 means "not ready yet", not that this durable chat target is
      // permanently gone. Keep retrying until the delivery TTL; other 404s and
      // 410s still fail closed below.
      if (isMissingActiveAgentSession(error)) {
        return {
          kind: 'retry',
          reason: 'not_ready',
          error: errorMessage(error),
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
        };
      }
      if (status === 404 || status === 410) {
        return {
          kind: 'failed',
          reason: 'terminal_target',
          error: errorMessage(error),
          runtimeIdentity: capabilities.runtimeIdentity,
          capabilities,
        };
      }
      return this.reconcileAfterAmbiguousSubmit(
        target,
        input.claim,
        capabilities,
        error,
        input.requestTimeoutMs
      );
    }
  }

  async reconcile(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult> {
    const resolution = await this.resolveTarget(
      input.projectId,
      input.claim.message.targetSessionId
    );
    if (resolution.kind === 'failed') {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: `Prior delivery cannot be reconciled after target loss: ${resolution.error}`,
        runtimeIdentity: null,
        capabilities: null,
        receipt: null,
      };
    }
    if (resolution.kind === 'retry') {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: `Prior delivery cannot be reconciled while target is unavailable: ${resolution.reason}`,
        runtimeIdentity: null,
        capabilities: null,
        receipt: null,
      };
    }
    const { target } = resolution;
    const capabilities = await this.getCapabilities(target, input.requestTimeoutMs);
    if (!capabilities) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Target VM capability probe failed during receipt reconciliation',
        runtimeIdentity: null,
        capabilities: null,
        receipt: null,
      };
    }
    if (
      input.claim.message.runtimeIdentity &&
      input.claim.message.runtimeIdentity !== capabilities.runtimeIdentity
    ) {
      return {
        kind: 'ambiguous',
        reason: 'runtime_changed',
        error: 'Runtime identity changed before the prior delivery could be reconciled',
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt: null,
      };
    }
    if (!capabilities.promptReceipts.supported || !capabilities.promptReceipts.lookup) {
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Target VM cannot reconcile the prior delivery receipt',
        runtimeIdentity: capabilities.runtimeIdentity,
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
              n.runtime AS node_runtime,
              a.id AS agent_session_id,
              a.status AS agent_session_status,
              a.updated_at AS agent_session_updated_at
       FROM workspaces w
       LEFT JOIN nodes n ON n.id = w.node_id
       LEFT JOIN agent_sessions a ON a.workspace_id = w.id
       WHERE w.project_id = ? AND w.chat_session_id = ?
       ORDER BY w.updated_at DESC, a.created_at DESC
       LIMIT 1`
    )
      .bind(projectId, chatSessionId)
      .first<{
        workspace_id: string;
        user_id: string;
        workspace_status: string;
        node_id: string | null;
        node_status: string | null;
        node_health_status: string | null;
        agent_version: string | null;
        node_runtime: string | null;
        agent_session_id: string | null;
        agent_session_status: string | null;
        agent_session_updated_at: string | null;
      }>();

    if (!row) {
      const recovery = await ensureSessionRecovery(this.env, projectId, chatSessionId);
      if (recovery.status === 'waking') {
        return { kind: 'retry', reason: `Session is waking (${recovery.taskId})` };
      }
      return {
        kind: 'failed',
        reason: 'terminal_target',
        error: `Target workspace no longer exists (${recovery.reason})`,
      };
    }
    if (
      row.node_runtime !== 'cf-container' &&
      ['sleeping', 'stopping', 'stopped', 'deleted', 'error'].includes(row.workspace_status)
    ) {
      const recovery = await ensureSessionRecovery(this.env, projectId, chatSessionId);
      if (recovery.status === 'waking') {
        return { kind: 'retry', reason: `Session is waking (${recovery.taskId})` };
      }
      return {
        kind: 'failed',
        reason: 'terminal_target',
        error: `Target workspace is ${row.workspace_status} (${recovery.reason})`,
      };
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
      ['stopping', 'stopped', 'deleted', 'error'].includes(row.node_status ?? '') ||
      row.node_health_status === 'unhealthy'
    ) {
      return { kind: 'failed', reason: 'dead_target', error: 'Target node is unavailable' };
    }
    const wakeableStatuses = ['running', 'recovery', 'sleeping'];
    if (
      !wakeableStatuses.includes(row.workspace_status) ||
      !wakeableStatuses.includes(row.node_status ?? '')
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
        runtime: row.node_runtime ?? 'vm',
      },
    };
  }

  private async commitContainerWake(target: VmPromptDeliveryTarget): Promise<void> {
    const task = await this.env.DATABASE.prepare(
      `SELECT id FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(target.workspaceId)
      .first<{ id: string }>();
    if (!task) return;
    await Promise.all([
      projectDataService.wakeSession(
        this.env,
        target.projectId,
        target.chatSessionId,
        target.workspaceId,
        task.id
      ),
      markSessionSnapshotAwakeInPlace(this.env, target.chatSessionId, task.id, target.workspaceId),
    ]);
  }

  private async getCapabilities(
    target: VmPromptDeliveryTarget,
    requestTimeoutMs: number
  ): Promise<VmPromptDeliveryCapabilities | null> {
    try {
      const raw = await nodeAgentRequest(
        target.nodeId,
        this.env,
        buildVmPromptDeliveryCapabilitiesPath(target.workspaceId),
        {
          method: 'GET',
          userId: target.userId,
          workspaceId: target.workspaceId,
          requestTimeoutMs,
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

  private async reconcileAfterAmbiguousSubmit(
    target: VmPromptDeliveryTarget,
    claim: PromptDeliveryClaim,
    capabilities: VmPromptDeliveryCapabilities,
    submitError: unknown,
    requestTimeoutMs: number
  ): Promise<PromptDeliveryResult> {
    if (!capabilities.promptReceipts.supported || !capabilities.promptReceipts.lookup) {
      return {
        kind: 'ambiguous',
        reason: 'lost_response',
        error: errorMessage(submitError),
        runtimeIdentity: capabilities.runtimeIdentity,
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
    requestTimeoutMs: number
  ): Promise<PromptDeliveryResult> {
    try {
      const raw = await nodeAgentRequest(
        target.nodeId,
        this.env,
        buildVmPromptDeliveryReceiptPath(
          target.workspaceId,
          target.agentSessionId,
          claim.message.id
        ),
        {
          method: 'GET',
          userId: target.userId,
          workspaceId: target.workspaceId,
          requestTimeoutMs,
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
      const notFound = this.parseNotFoundReceipt(error);
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

  private parseConflictResponse(error: unknown): VmPromptDeliveryResponse | null {
    if (!(error instanceof NodeAgentHttpError)) return null;
    try {
      return v.parse(SubmitResponseSchema, JSON.parse(error.responseBody));
    } catch {
      return null;
    }
  }

  private parseNotFoundReceipt(error: unknown): VmPromptDeliveryReceipt | null {
    if (!(error instanceof NodeAgentHttpError)) return null;
    try {
      return v.parse(ReceiptSchema, JSON.parse(error.responseBody));
    } catch {
      return null;
    }
  }
}
