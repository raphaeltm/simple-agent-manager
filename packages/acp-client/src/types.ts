/**
 * Represents a slash command available in the chat input.
 * Commands can originate from the ACP agent (dynamic) or the client (static).
 */
export interface SlashCommand {
  /** Command name without the leading slash (e.g., "compact") */
  name: string;
  /** Human-readable description shown in the palette */
  description: string;
  /** Where the command originated */
  source: 'agent' | 'client';
}
