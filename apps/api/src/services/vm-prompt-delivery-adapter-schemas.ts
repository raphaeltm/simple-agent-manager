/**
 * Wire schemas for the VM prompt delivery adapter's HTTP contract
 * (`packages/vm-agent` prompt-delivery endpoints, protocol version 1).
 * Extracted from the adapter to respect `.claude/rules/18-file-size-limits.md`.
 */
import {
  type VmPromptDeliveryCapabilities,
  type VmPromptDeliveryReceipt,
  type VmPromptDeliveryResponse,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

export const RuntimeIdentitySchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256));

export const CapabilitiesSchema = v.object({
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

export const ReceiptSchema = v.object({
  deliveryId: v.string(),
  state: v.picklist(['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous']),
  runtimeIdentity: RuntimeIdentitySchema,
  acceptedAt: v.nullable(v.number()),
  completedAt: v.nullable(v.number()),
});

export const SubmitResponseSchema = v.object({
  status: v.picklist(['accepted', 'duplicate', 'not_ready', 'conflict']),
  sessionId: v.string(),
  receipt: ReceiptSchema,
});

export type ParsedCapabilities = VmPromptDeliveryCapabilities;
export type ParsedReceipt = VmPromptDeliveryReceipt;
export type ParsedSubmitResponse = VmPromptDeliveryResponse;
