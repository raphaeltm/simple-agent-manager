import type { ToolCallItem } from '@simple-agent-manager/acp-client';

import { isJsonRecord } from '../../../lib/runtime-validation';
import { normalizeToolName, parseResultPayload } from './document-card-data';

/**
 * The agent question tool (base name, separator-agnostic) whose result renders as a
 * HumanInputCard. Listed in the shared TYPED_CHAT_CARD_TOOLS, which also types the API matcher
 * that keeps the marker reference when chat history is loaded in compact mode.
 */
export const HUMAN_INPUT_CARD_TOOL = 'request_human_input';

/** True when the tool call is a `request_human_input` call, under any agent's naming. */
export function isHumanInputCardTool(item: ToolCallItem): boolean {
  return normalizeToolName(item.toolName ?? item.title) === HUMAN_INPUT_CARD_TOOL;
}

export interface HumanInputRequestRef {
  /** Attention marker ID. */
  id: string;
  sessionId: string;
}

/**
 * The question reference from a `request_human_input` result
 * (`{ humanInputRequest: { id, sessionId }, … }`), or undefined when the call has not finished,
 * failed, or predates the structured result. Only the IDs are taken from the transcript: the
 * card reads the question, options and answer state from the server's attention marker.
 */
export function extractHumanInputRequest(item: ToolCallItem): HumanInputRequestRef | undefined {
  const result = parseResultPayload(item.rawOutput ?? item.content);
  const request =
    result && isJsonRecord(result.humanInputRequest) ? result.humanInputRequest : undefined;
  const id = request?.id;
  const sessionId = request?.sessionId;
  return typeof id === 'string' && id && typeof sessionId === 'string' && sessionId
    ? { id, sessionId }
    : undefined;
}
