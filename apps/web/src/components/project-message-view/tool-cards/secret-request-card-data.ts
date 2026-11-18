import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { REQUEST_SECRET_TOOL } from '@simple-agent-manager/shared';

import { isJsonRecord } from '../../../lib/runtime-validation';
import { normalizeToolName, parseResultPayload } from './document-card-data';

/**
 * The agent secret request tool (base name, separator-agnostic) whose result renders as a
 * SecretRequestCard. Listed in the shared TYPED_CHAT_CARD_TOOLS, which also types the API matcher
 * that keeps the request ID when chat history is loaded in compact mode.
 */
export const SECRET_REQUEST_CARD_TOOL = REQUEST_SECRET_TOOL;

/** True when the tool call is a `request_secret` call, under any agent's naming. */
export function isSecretRequestCardTool(item: ToolCallItem): boolean {
  return normalizeToolName(item.toolName ?? item.title) === SECRET_REQUEST_CARD_TOOL;
}

/**
 * The request ID from a `request_secret` result (`{ secretRequest: { id, … }, … }`), or
 * undefined while the call runs or when it failed. Only the ID is taken from the transcript: the
 * card reads the name, reason and status from the server record.
 */
export function extractSecretRequestId(item: ToolCallItem): string | undefined {
  const result = parseResultPayload(item.rawOutput ?? item.content);
  const request = result && isJsonRecord(result.secretRequest) ? result.secretRequest : undefined;
  const id = request?.id;
  return typeof id === 'string' && id ? id : undefined;
}
