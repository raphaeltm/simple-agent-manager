/**
 * Cached slash commands — persists agent-reported commands per project.
 *
 * Used by the SlashCommandPalette to show known commands before an ACP session starts.
 */

export interface CachedCommand {
  agentType: string;
  name: string;
  description: string;
  updatedAt: number;
}

/**
 * Replace all cached commands for a given agent type with a fresh set.
 * Uses DELETE + INSERT inside a transaction for atomicity.
 */
export function saveCachedCommands(
  sql: SqlStorage,
  agentType: string,
  commands: Array<{ name: string; description: string }>,
): void {
  sql.exec('DELETE FROM cached_commands WHERE agent_type = ?', agentType);
  const now = Date.now();
  for (const cmd of commands) {
    sql.exec(
      'INSERT INTO cached_commands (agent_type, name, description, updated_at) VALUES (?, ?, ?, ?)',
      agentType,
      cmd.name,
      cmd.description,
      now,
    );
  }
}

/**
 * Get all cached commands, optionally filtered by agent type.
 */
export function getCachedCommands(
  sql: SqlStorage,
  agentType?: string,
): CachedCommand[] {
  const rows = agentType
    ? sql.exec('SELECT agent_type, name, description, updated_at FROM cached_commands WHERE agent_type = ? ORDER BY name', agentType).toArray()
    : sql.exec('SELECT agent_type, name, description, updated_at FROM cached_commands ORDER BY name').toArray();
  return rows.map((row) => ({
    agentType: row.agent_type as string,
    name: row.name as string,
    description: row.description as string,
    updatedAt: row.updated_at as number,
  }));
}
