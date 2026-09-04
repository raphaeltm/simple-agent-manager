import {
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  resolveProjectScalingConfig,
} from '@simple-agent-manager/shared';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Read a project's configured max-triggers override (`projects.max_triggers`).
 * Returns null when the project uses the platform default.
 */
export async function loadProjectMaxTriggersOverride(
  database: D1Database,
  projectId: string
): Promise<number | null> {
  const row = await database
    .prepare('SELECT max_triggers AS maxTriggers FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ maxTriggers: number | null }>();
  return row?.maxTriggers ?? null;
}

/**
 * Resolve the maximum number of triggers a project may have.
 *
 * Precedence (highest first):
 *   1. Per-project override (`projects.max_triggers`)
 *   2. Platform env var `MAX_TRIGGERS_PER_PROJECT`
 *   3. Hardcoded default (`DEFAULT_MAX_TRIGGERS_PER_PROJECT`)
 *
 * Shared by every trigger creation path so the cap is enforced identically
 * across the REST API, the MCP `create_trigger` tool, and auto-created
 * incident triggers.
 */
export function resolveMaxTriggersPerProject(
  perProjectOverride: number | null | undefined,
  envValue: string | undefined
): number {
  return resolveProjectScalingConfig(perProjectOverride, envValue, DEFAULT_MAX_TRIGGERS_PER_PROJECT);
}