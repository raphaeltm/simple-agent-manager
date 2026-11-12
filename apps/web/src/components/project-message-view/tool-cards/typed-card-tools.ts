import { TYPED_CHAT_CARD_TOOLS } from '@simple-agent-manager/shared';

import { normalizeToolName } from './document-card-data';

/**
 * Every tool (base name, separator-agnostic) whose call renders as a typed chat card: the shared
 * TYPED_CHAT_CARD_TOOLS list, which the API's compact-history matchers are typed against too. The
 * registry refuses any tool not named here, and the message converter uses it to recover a card
 * tool's identity and result from Codex's sparse rows. A card added to the registry but not to
 * the list therefore cannot render at all, rather than rendering for Claude Code and silently
 * falling back to raw JSON for Codex (`request_secret`, 2026-11-12).
 */
export const TYPED_CARD_TOOLS: ReadonlySet<string> = new Set<string>(TYPED_CHAT_CARD_TOOLS);

/** True when a raw tool identifier, under any agent's naming, names a typed-card tool. */
export function isTypedCardToolName(toolName: string | undefined): boolean {
  const base = normalizeToolName(toolName);
  return Boolean(base && TYPED_CARD_TOOLS.has(base));
}
