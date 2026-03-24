/**
 * Represents a slash command available in the chat input.
 * Commands can originate from the ACP agent (dynamic), the client (static),
 * or a per-project cache of previously-seen agent commands.
 */
export interface SlashCommand {
  /** Command name without the leading slash (e.g., "compact") */
  name: string;
  /** Human-readable description shown in the palette */
  description: string;
  /** Where the command originated */
  source: 'agent' | 'client' | 'cached';
}
