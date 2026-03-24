import type { SlashCommand } from '../types';

/**
 * Well-known slash commands for Claude Code agent.
 * These are always available in the palette, even before an ACP session starts.
 */
const CLAUDE_CODE_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compact conversation context', source: 'agent' },
  { name: 'cost', description: 'Show token usage and cost', source: 'agent' },
  { name: 'doctor', description: 'Check Claude Code setup health', source: 'agent' },
  { name: 'help', description: 'Show available commands', source: 'agent' },
  { name: 'init', description: 'Initialize CLAUDE.md project file', source: 'agent' },
  { name: 'login', description: 'Switch accounts or auth method', source: 'agent' },
  { name: 'logout', description: 'Log out of current session', source: 'agent' },
  { name: 'mcp', description: 'Manage MCP servers', source: 'agent' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files', source: 'agent' },
  { name: 'model', description: 'Switch AI model', source: 'agent' },
  { name: 'permissions', description: 'View or edit tool permissions', source: 'agent' },
  { name: 'pr-comments', description: 'View and address PR comments', source: 'agent' },
  { name: 'review', description: 'Review code changes', source: 'agent' },
  { name: 'status', description: 'Show session status', source: 'agent' },
  { name: 'vim', description: 'Toggle vim keybindings', source: 'agent' },
];

/**
 * Registry of well-known slash commands by agent type.
 * Keyed by agent ID (matching AgentInfo.id from the API).
 */
const AGENT_COMMAND_REGISTRY: Record<string, SlashCommand[]> = {
  'claude-code': CLAUDE_CODE_COMMANDS,
};

/**
 * Get the static well-known commands for a given agent type.
 * Returns an empty array for unknown agent types.
 */
export function getStaticCommands(agentType: string): SlashCommand[] {
  return AGENT_COMMAND_REGISTRY[agentType] ?? [];
}

/**
 * Get all static commands across all known agent types.
 * Useful when no specific agent type is selected yet.
 */
export function getAllStaticCommands(): SlashCommand[] {
  return Object.values(AGENT_COMMAND_REGISTRY).flat();
}
