import { REQUEST_SECRET_TOOL } from './types/runtime-secret-requests';

/**
 * Every tool (base name, separator-agnostic) whose call renders as a typed chat card instead of
 * the generic tool card. The web registry and message converter, and the API's compact-history
 * payload matchers, all derive from this list, so a card cannot be recognised by one layer and
 * missed by another. Missing it from the web converter made Codex `request_secret` calls render
 * as raw JSON while Claude Code rendered the card (2026-11-12).
 */
export const TYPED_CHAT_CARD_TOOLS = [
  'upload_to_library',
  'replace_library_file',
  'display_from_library',
  'ops_request_action',
  'request_human_input',
  REQUEST_SECRET_TOOL,
] as const;
export type TypedChatCardTool = (typeof TYPED_CHAT_CARD_TOOLS)[number];
