import {
  type AcpInteractionAnswerDecision,
  isJsonRecord,
  validateAcpFormAnswer,
  validateAcpFormSchema,
} from '@simple-agent-manager/shared';

import type { AcpInteractionConfig } from '../services/acp-interaction-config';
import { sha256 } from './interaction-store-model';

function formLimits(config: AcpInteractionConfig) {
  return {
    schemaMaxBytes: config.formSchemaMaxBytes,
    propertiesMax: config.formSchemaMaxProperties,
    enumMax: config.formSchemaMaxEnum,
    answerMaxBytes: config.answerMaxBytes,
    stringMaxBytes: config.answerStringMaxBytes,
    keyMaxChars: config.optionIdMaxChars,
    labelMaxChars: config.optionNameMaxChars,
  };
}

export function validFormCreateDetail(detailValue: unknown, config: AcpInteractionConfig): boolean {
  const detail = isJsonRecord(detailValue) ? detailValue : null;
  return !!detail &&
    Object.keys(detail).every((key) => ['message', 'schema', 'toolCallId'].includes(key)) &&
    typeof detail.message === 'string' &&
    new TextEncoder().encode(detail.message).byteLength <= config.requestMaxBytes &&
    (detail.toolCallId === undefined || typeof detail.toolCallId === 'string') &&
    validateAcpFormSchema(detail.schema, formLimits(config));
}

export async function validFormAnswerDecision(
  schema: unknown,
  decision: AcpInteractionAnswerDecision,
  config: AcpInteractionConfig
): Promise<'valid' | 'schema_unavailable' | 'invalid_answer'> {
  const limits = formLimits(config);
  if (!validateAcpFormSchema(schema, limits)) return 'schema_unavailable';
  if (decision.kind !== 'accepted') {
    return ['declined', 'cancelled'].includes(decision.kind) &&
      decision.content === undefined && decision.optionId === undefined &&
      decision.encryptedAnswer === undefined ? 'valid' : 'invalid_answer';
  }
  if (!validateAcpFormAnswer(schema, decision.content, limits) ||
      decision.optionId !== undefined || decision.encryptedAnswer !== undefined) {
    return 'invalid_answer';
  }
  const sortedContent = Object.fromEntries(Object.entries(decision.content).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return await sha256(JSON.stringify(sortedContent)) === decision.answerHash ? 'valid' : 'invalid_answer';
}

export async function protectedFormReceiptHash(
  secret: string,
  interactionId: string,
  bodyHash: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`acp-form-receipt:${interactionId}:${bodyHash}`));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
