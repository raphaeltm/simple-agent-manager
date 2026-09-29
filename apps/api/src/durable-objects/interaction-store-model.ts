import {
  type AcpInteractionAnswerDecision,
  type AcpInteractionRuntimeCreate,
  type AcpInteractionRuntimeSettle,
  type AcpInteractionSafeSummary,
} from '@simple-agent-manager/shared';

import { canonicalJson } from '../lib/canonical-json';
import type { AcpInteractionConfig } from '../services/acp-interaction-config';

export type InteractionRow = {
  interaction_id: string;
  project_id: string;
  chat_session_id: string;
  agent_session_id: string;
  kind: string;
  state: string;
  generation: string;
  runtime_identity: string;
  payload_hash: string;
  encrypted_detail: string | null;
  detail_iv: string | null;
  detail_purged_at: number | null;
  safe_summary_json: string;
  upstream_request_id: string | null;
  created_at: number;
  updated_at: number;
  deadline_at: number;
  answered_at: number | null;
  answer_key: string | null;
  answer_body_hash: string | null;
  decision_kind: string | null;
  decision_hash: string | null;
  encrypted_answer: string | null;
  answer_iv: string | null;
  encrypted_decision: string | null;
  decision_iv: string | null;
  delivery_state: string | null;
  delivery_attempts: number;
  delivery_deadline_at: number | null;
  last_delivery_error: string | null;
  attention_marker_id: string | null;
  attention_projection_state: string | null;
  terminal_at: number | null;
  purge_at: number | null;
};

export interface InteractionStoreCreateInput extends AcpInteractionRuntimeCreate {
  projectId: string;
  chatSessionId: string;
}

export interface InteractionStoreAnswerInput {
  projectId: string;
  chatSessionId: string;
  interactionId: string;
  answerKey: string;
  answerBodyHash: string;
  decision: AcpInteractionAnswerDecision;
}

export interface InteractionStoreSettleInput extends AcpInteractionRuntimeSettle {
  projectId: string;
  chatSessionId: string;
}

export type InteractionStoreCreateResult =
  | { status: 'created' | 'existing'; summary: AcpInteractionSafeSummary }
  | {
      status: 'disabled' | 'conflict' | 'too_many_pending' | 'expired' | 'invalid';
      reason: string;
    };

export type InteractionStoreAnswerResult =
  | {
      status: 'answered' | 'already_answered';
      summary: AcpInteractionSafeSummary;
      delivery: { generation: string; runtimeIdentity: string };
    }
  | {
      status: 'not_found' | 'stale' | 'conflict' | 'answer_key_conflict' | 'payload_too_large';
      reason: string;
    };

export interface InteractionStoreSnapshot {
  pending: AcpInteractionSafeSummary[];
  settled: AcpInteractionSafeSummary[];
  cursor: string | null;
}

export function nowMs(): number {
  return Date.now();
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseSummary(row: InteractionRow): AcpInteractionSafeSummary {
  const safeSummary = JSON.parse(row.safe_summary_json) as unknown;
  return {
    interactionId: row.interaction_id,
    kind: row.kind as AcpInteractionSafeSummary['kind'],
    state: row.state as AcpInteractionSafeSummary['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    answeredAt: row.answered_at,
    deliveryState: row.delivery_state as AcpInteractionSafeSummary['deliveryState'],
    attentionMarkerId: row.attention_marker_id,
    toolCallId:
      typeof safeSummary === 'object' &&
      safeSummary !== null &&
      'toolCallId' in safeSummary &&
      typeof safeSummary.toolCallId === 'string'
        ? safeSummary.toolCallId
        : null,
  };
}

export function terminalState(state: string): boolean {
  return [
    'delivery_confirmed',
    'delivery_unconfirmed',
    'interrupted',
    'expired',
    'cancelled',
  ].includes(state);
}

export function detailBoundsViolation(
  detail: unknown,
  config: AcpInteractionConfig
): string | null {
  return detailRecordBoundsViolation(asRecord(detail), config);
}

function detailRecordBoundsViolation(
  record: Record<string, unknown> | null,
  config: AcpInteractionConfig
): string | null {
  if (!record) return null;
  const optionsViolation = optionsBoundsViolation(record, config);
  if (optionsViolation) return optionsViolation;
  return schemaBoundsViolation(record, config);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionsBoundsViolation(
  record: Record<string, unknown>,
  config: AcpInteractionConfig
): string | null {
  if (Array.isArray(record.options) && record.options.length > config.optionsMaxCount) {
    return 'request options exceed configured maximum';
  }
  return null;
}

function schemaBoundsViolation(
  record: Record<string, unknown>,
  config: AcpInteractionConfig
): string | null {
  const schema = record.schema ?? record.formSchema;
  if (schema === undefined) return null;
  const schemaJson = canonicalJson(schema);
  if (new TextEncoder().encode(schemaJson).byteLength > config.formSchemaMaxBytes) {
    return 'form schema exceeds configured maximum';
  }
  return schemaObjectBoundsViolation(schema, config);
}

function schemaObjectBoundsViolation(
  schema: unknown,
  config: AcpInteractionConfig
): string | null {
  const schemaRecord = asRecord(schema);
  if (!schemaRecord) return null;
  const properties = asRecord(schemaRecord.properties);
  if (properties && Object.keys(properties).length > config.formSchemaMaxProperties) {
    return 'form schema properties exceed configured maximum';
  }
  if (hasEnumOverflow(schema, config.formSchemaMaxEnum)) return 'form schema enum exceeds configured maximum';
  return null;
}

function hasEnumOverflow(value: unknown, maxEnum: number): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasEnumOverflow(item, maxEnum));
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.length > maxEnum) return true;
  return Object.values(record).some((item) => hasEnumOverflow(item, maxEnum));
}
