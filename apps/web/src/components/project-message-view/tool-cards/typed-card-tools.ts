import { APPROVAL_CARD_TOOL } from './approval-card-data';
import { DOCUMENT_CARD_TOOLS, normalizeToolName } from './document-card-data';
import { HUMAN_INPUT_CARD_TOOL } from './human-input-card-data';
import { SECRET_REQUEST_CARD_TOOL } from './secret-request-card-data';

/**
 * Every tool (base name, separator-agnostic) whose call renders as a typed chat card. This is the
 * single list: the registry refuses any tool not named here, and the message converter
 * (`chatMessagesToConversationItems`) uses it to recover a card tool's identity and result from
 * Codex's sparse rows. A card added to the registry but not here therefore cannot render at all,
 * rather than rendering for Claude Code and silently falling back to raw JSON for Codex
 * (`request_secret`, 2026-11-12).
 *
 * The API keeps the same set for compact history (`cardPayloadMatcher` in
 * apps/api/src/durable-objects/project-data/row-schemas/messages.ts); keep the two in sync.
 */
export const TYPED_CARD_TOOLS: ReadonlySet<string> = new Set([
  ...DOCUMENT_CARD_TOOLS,
  APPROVAL_CARD_TOOL,
  HUMAN_INPUT_CARD_TOOL,
  SECRET_REQUEST_CARD_TOOL,
]);

/** True when a raw tool identifier, under any agent's naming, names a typed-card tool. */
export function isTypedCardToolName(toolName: string | undefined): boolean {
  const base = normalizeToolName(toolName);
  return Boolean(base && TYPED_CARD_TOOLS.has(base));
}
