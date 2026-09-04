import {
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  resolveProjectScalingConfig,
} from '@simple-agent-manager/shared';

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