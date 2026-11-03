/**
 * How strongly a sleep must happen (policy a3780107, 2026-11-03: "as close to impossible as
 * possible for a required sleep to fail to take place").
 *
 * - `normal`: unattended idle sleep. Waits for canonical idleness (policy 0f05422d).
 * - `deadline`: the node is past its absolute lifetime. The session sleeps as soon as its turn
 *   ends, without waiting out the idle interval, but nothing is killed.
 * - `required`: a person pressed Sleep, or the node is past its absolute lifetime plus the
 *   force-sleep leeway. The agent's turn is ended first (`endAgentTurnForRequiredSleep`), and
 *   neither a running turn nor a harness lease may block the sleep.
 */
import {
  DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS,
  DEFAULT_NODE_LIFETIME_FORCE_SLEEP_AFTER_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { resolveAdminSetting } from './admin-settings-resolution';

export type SleepRequirement = 'normal' | 'deadline' | 'required';

export interface SleepRequirementNode {
  nodeCreatedAt: string | null;
  nodeRole: string | null;
  nodeClass: string | null;
  /** 1 when a task auto-provisioned this node. */
  nodeAutoProvisioned: number | boolean | null;
}

/**
 * The nodes the absolute lifetime governs. Mirrors the candidate predicate of
 * `sweepMaxLifetimeNodes` (`scheduled/node-cleanup/node-phases.ts`): workspace nodes that SAM
 * auto-provisioned and owns. A user-owned or manually created node is never forced.
 */
export function isLifetimeGovernedNode(node: SleepRequirementNode): boolean {
  return (
    node.nodeRole === 'workspace' && node.nodeClass !== 'user-owned' && !!node.nodeAutoProvisioned
  );
}

export function classifySleepRequirement(
  node: SleepRequirementNode,
  now: Date,
  config: { absoluteMaxLifetimeMs: number; forceSleepAfterMs: number; requestedByPerson: boolean }
): SleepRequirement {
  if (config.requestedByPerson) return 'required';
  if (!isLifetimeGovernedNode(node)) return 'normal';
  const createdAt = Date.parse(node.nodeCreatedAt ?? '');
  if (!Number.isFinite(createdAt)) return 'normal';
  const age = now.getTime() - createdAt;
  if (age >= config.absoluteMaxLifetimeMs + config.forceSleepAfterMs) return 'required';
  if (age >= config.absoluteMaxLifetimeMs) return 'deadline';
  return 'normal';
}

async function resolveForceSleepAfterMs(env: Env): Promise<number> {
  try {
    return Number(await resolveAdminSetting(env, 'operations.nodeLifetimeForceSleepAfterMs'));
  } catch (error) {
    // A settings outage must not stop a deadline from being enforced.
    log.warn('session_sleep_requirement.leeway_setting_unavailable', {
      error: error instanceof Error ? error.message : String(error),
      fallbackMs: DEFAULT_NODE_LIFETIME_FORCE_SLEEP_AFTER_MS,
    });
    return DEFAULT_NODE_LIFETIME_FORCE_SLEEP_AFTER_MS;
  }
}

export async function resolveSleepRequirement(
  env: Env,
  node: SleepRequirementNode,
  now: Date,
  options: { requestedByPerson: boolean }
): Promise<SleepRequirement> {
  if (options.requestedByPerson) return 'required';
  if (!isLifetimeGovernedNode(node)) return 'normal';
  const absoluteMaxLifetimeMs = parsePositiveInt(
    env.NODE_ABSOLUTE_MAX_LIFETIME_MS,
    DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS
  );
  // Read the leeway setting only for a node already past its lifetime: every other sleep
  // check stays free of the extra lookup.
  const forceSleepAfterMs =
    classifySleepRequirement(node, now, {
      absoluteMaxLifetimeMs,
      forceSleepAfterMs: Number.POSITIVE_INFINITY,
      requestedByPerson: false,
    }) === 'normal'
      ? Number.POSITIVE_INFINITY
      : await resolveForceSleepAfterMs(env);
  return classifySleepRequirement(node, now, {
    absoluteMaxLifetimeMs,
    forceSleepAfterMs,
    requestedByPerson: false,
  });
}
