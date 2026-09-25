import {
  DEFAULT_MAX_AUTO_NODE_LIFETIME_MS,
  DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS,
  DEFAULT_NODE_CLEANUP_FAILURE_BACKOFF_MS,
  DEFAULT_NODE_CLEANUP_SWEEP_LIMIT,
  DEFAULT_NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS,
  DEFAULT_NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS,
  DEFAULT_NODE_WARM_GRACE_PERIOD_MS,
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS,
  DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
  DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from '../../services/node-agent';

export const DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT = 25;
export const DEFAULT_NODE_UNHEALTHY_DRAIN_AFTER_MS = 600_000;
export const DEFAULT_NODE_UNHEALTHY_RELEASE_AFTER_MS = 1_800_000;
export const DEFAULT_NODE_UNHEALTHY_FLEET_MAX_FRACTION = 0.5;
export const DEFAULT_NODE_UNHEALTHY_FLEET_MIN_NODES = 3;
export const DEFAULT_NODE_UNHEALTHY_RETRY_MS = 60_000;

export function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface CleanupConfig {
  gracePeriodMs: number;
  maxLifetimeMs: number;
  absoluteMaxLifetimeMs: number;
  orphanGracePeriodMs: number;
  workspaceIdleTimeoutMs: number;
  stoppedTtlMs: number;
  nodeSweepLimit: number;
  workspaceSweepLimit: number;
  cfContainerSweepLimit: number;
  failureBackoffMs: number;
  unhealthyDrainAfterMs: number;
  unhealthyReleaseAfterMs: number;
  unhealthyFleetMaxFraction: number;
  unhealthyFleetMinNodes: number;
  unhealthyRetryMs: number;
  /** VM-agent timeout for background calls — see rule 47. */
  agentTimeoutMs: number;
  stoppedHandoffSweepBudgetMs: number;
  stoppedHandoffRequestTimeoutMs: number;
}

/**
 * Warn when overrides invert the intended threshold ordering.
 *
 * The shipped defaults are monotonic (warm/workspace-idle 30m < warm-grace 35m <
 * max-lifetime 4h < absolute-ceiling 24h), but nothing stops an operator from
 * overriding one into a nonsensical relationship. That would not throw — it would
 * silently make a phase unreachable or trivially satisfiable, reproducing exactly the
 * "guard that never fires looks identical to a guard with nothing to do" failure this
 * whole change exists to fix. See `.claude/rules/53-…`.
 *
 * Deliberately a warning, not a hard failure: a misordered threshold degrades reaping
 * precision, and refusing to sweep at all would be strictly worse than sweeping with
 * odd timings.
 */
function warnOnInvertedThresholds(config: CleanupConfig, env: Env): void {
  const warmTimeoutMs = parseMs(env.NODE_WARM_TIMEOUT_MS, DEFAULT_NODE_WARM_TIMEOUT_MS);
  const problems: string[] = [];

  if (config.workspaceIdleTimeoutMs < warmTimeoutMs) {
    problems.push(
      `NODE_WORKSPACE_IDLE_TIMEOUT_MS (${config.workspaceIdleTimeoutMs}) is below NODE_WARM_TIMEOUT_MS (${warmTimeoutMs}); workspace-idle reaping may race the configured warm retention window`
    );
  }
  if (config.absoluteMaxLifetimeMs < config.maxLifetimeMs) {
    problems.push(
      `NODE_ABSOLUTE_MAX_LIFETIME_MS (${config.absoluteMaxLifetimeMs}) is below MAX_AUTO_NODE_LIFETIME_MS (${config.maxLifetimeMs}); the absolute ceiling is satisfied for every max-lifetime candidate`
    );
  }
  if (config.gracePeriodMs < warmTimeoutMs) {
    problems.push(
      `NODE_WARM_GRACE_PERIOD_MS (${config.gracePeriodMs}) is below NODE_WARM_TIMEOUT_MS (${warmTimeoutMs}); warm nodes may be swept before their warm window expires`
    );
  }

  if (problems.length > 0) {
    log.warn('node_cleanup.threshold_ordering_inverted', { problems });
  }
}

export function resolveCleanupConfig(env: Env): CleanupConfig {
  const config = buildCleanupConfig(env);
  warnOnInvertedThresholds(config, env);
  return config;
}

function buildCleanupConfig(env: Env): CleanupConfig {
  const drainAfterMs = parseMs(
    env.NODE_UNHEALTHY_DRAIN_AFTER_MS,
    DEFAULT_NODE_UNHEALTHY_DRAIN_AFTER_MS
  );
  const releaseAfterMs = parseMs(
    env.NODE_UNHEALTHY_RELEASE_AFTER_MS,
    DEFAULT_NODE_UNHEALTHY_RELEASE_AFTER_MS
  );
  const fleetFraction = Number(env.NODE_UNHEALTHY_FLEET_MAX_FRACTION);
  return {
    unhealthyDrainAfterMs: drainAfterMs,
    unhealthyReleaseAfterMs: Math.max(releaseAfterMs, drainAfterMs + 1),
    unhealthyFleetMaxFraction:
      Number.isFinite(fleetFraction) && fleetFraction > 0 && fleetFraction <= 1
        ? fleetFraction
        : DEFAULT_NODE_UNHEALTHY_FLEET_MAX_FRACTION,
    unhealthyFleetMinNodes: parsePositiveInt(
      env.NODE_UNHEALTHY_FLEET_MIN_NODES,
      DEFAULT_NODE_UNHEALTHY_FLEET_MIN_NODES
    ),
    unhealthyRetryMs: parseMs(env.NODE_UNHEALTHY_RETRY_MS, DEFAULT_NODE_UNHEALTHY_RETRY_MS),
    gracePeriodMs: parseMs(env.NODE_WARM_GRACE_PERIOD_MS, DEFAULT_NODE_WARM_GRACE_PERIOD_MS),
    maxLifetimeMs: parseMs(env.MAX_AUTO_NODE_LIFETIME_MS, DEFAULT_MAX_AUTO_NODE_LIFETIME_MS),
    absoluteMaxLifetimeMs: parseMs(
      env.NODE_ABSOLUTE_MAX_LIFETIME_MS,
      DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS
    ),
    orphanGracePeriodMs: parseMs(
      env.ORPHANED_WORKSPACE_GRACE_PERIOD_MS,
      DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS
    ),
    workspaceIdleTimeoutMs: parseMs(
      env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
      DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
    ),
    stoppedTtlMs: parseMs(env.WORKSPACE_STOPPED_TTL_MS, DEFAULT_WORKSPACE_STOPPED_TTL_MS),
    nodeSweepLimit: parsePositiveInt(
      env.NODE_CLEANUP_SWEEP_LIMIT,
      DEFAULT_NODE_CLEANUP_SWEEP_LIMIT
    ),
    workspaceSweepLimit: parsePositiveInt(
      env.WORKSPACE_CLEANUP_SWEEP_LIMIT,
      DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT
    ),
    cfContainerSweepLimit: parsePositiveInt(
      env.CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT,
      DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT
    ),
    failureBackoffMs: parseMs(
      env.NODE_CLEANUP_FAILURE_BACKOFF_MS,
      DEFAULT_NODE_CLEANUP_FAILURE_BACKOFF_MS
    ),
    agentTimeoutMs: getNodeAgentBackgroundRequestTimeoutMs(env),
    stoppedHandoffSweepBudgetMs: parseMs(
      env.NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS,
      DEFAULT_NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS
    ),
    stoppedHandoffRequestTimeoutMs: parseMs(
      env.NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS,
      DEFAULT_NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS
    ),
  };
}
