import type { ToolCallItem } from '@simple-agent-manager/acp-client';

import { isJsonRecord } from '../../../lib/runtime-validation';
import { normalizeToolName, parseResultPayload } from './document-card-data';

/**
 * The Operations tool (base name, separator-agnostic) whose result renders as an
 * ApprovalCard. Keep in sync with APPROVAL_CARD_TOOL in
 * packages/project-data/src/do/row-schemas/messages.ts, which keeps the
 * approval ID when chat history is loaded in compact mode.
 */
export const APPROVAL_CARD_TOOL = 'ops_request_action';

/** True when the tool call is an Operations approval request, under any agent's naming. */
export function isApprovalCardTool(item: ToolCallItem): boolean {
  return normalizeToolName(item.toolName ?? item.title) === APPROVAL_CARD_TOOL;
}

/**
 * The approval ID from an `ops_request_action` result (`{ approval: { id, … } }`), or
 * undefined when the call has not finished or failed. Only the ID is taken from the
 * transcript: the card reads everything it shows from the server's approval record.
 */
export function extractApprovalId(item: ToolCallItem): string | undefined {
  const result = parseResultPayload(item.rawOutput ?? item.content);
  const approval = result && isJsonRecord(result.approval) ? result.approval : undefined;
  const id = approval?.id;
  return typeof id === 'string' && id ? id : undefined;
}
