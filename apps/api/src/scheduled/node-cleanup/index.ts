/**
 * Cron handler for the node cleanup sweep.
 *
 * Layered defense against orphaned nodes:
 * 1. NodeLifecycle DO alarm — transitions an idle node to `stopped` (it cannot
 *    destroy cloud infrastructure itself; credentials need worker context)
 * 2. Cron sweep — this module; performs the actual destruction and catches
 *    everything the alarm missed
 * 3. Absolute lifetime ceiling — hard cap so no auto-provisioned node is immortal
 *
 * Layers 1 and 2 both depend on the node reaching a known idle state, so a node
 * that never transitions is invisible to both. Phase 5 (`sweepIdleOrphanNodes`)
 * is the independent backstop for that case, and the absolute ceiling in phase 2
 * is the backstop for a node with a permanently stuck workspace row.
 *
 * Rules that constrain every phase: `.claude/rules/47-control-loop-io-budget.md`
 * (bounded candidate sets, background timeouts, escape paths) and
 * `.claude/rules/51-server-side-node-class-gates.md` (role + class gates).
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  sweepIdleOrphanNodes,
  sweepIncompatibleVmAgentNodes,
  sweepMaxLifetimeNodes,
  sweepStaleWarmNodes,
  sweepStoppedHandoffNodes,
  sweepTerminalCfContainers,
} from './node-phases';
import { emptyResult, type NodeCleanupResult, resolveCleanupConfig } from './shared';
import { sweepOrphanedWorkspaces, sweepStaleStoppedWorkspaces } from './workspace-phases';

export type { NodeCleanupResult } from './shared';
export { resolveCleanupConfig } from './shared';

/**
 * Run the node cleanup sweep. Called from the cron handler.
 *
 * Each phase is individually contained: a phase that throws records an error and
 * the sweep continues. This mirrors the per-sweep isolation in the cron handler
 * (see `../sweep-isolation.ts`) one level down, so a single failing phase cannot
 * suppress node reaping the way a single failing sweep once suppressed the whole
 * back half of the cron.
 */
export async function runNodeCleanupSweep(env: Env): Promise<NodeCleanupResult> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date();
  const config = resolveCleanupConfig(env);
  const result = emptyResult();

  const phases: Array<[string, () => Promise<void>]> = [
    ['cf_container_terminal', () => sweepTerminalCfContainers(env, now, config, result)],
    ['stale_warm', () => sweepStaleWarmNodes(db, env, now, config, result)],
    ['max_lifetime', () => sweepMaxLifetimeNodes(db, env, now, config, result)],
    ['stopped_handoff', () => sweepStoppedHandoffNodes(db, env, now, config, result)],
    ['orphaned_workspaces', () => sweepOrphanedWorkspaces(db, env, now, config, result)],
    ['incompatible_vm_agent', () => sweepIncompatibleVmAgentNodes(db, env, now, config, result)],
    ['idle_orphan_nodes', () => sweepIdleOrphanNodes(db, env, now, config, result)],
    ['stale_stopped_workspaces', () => sweepStaleStoppedWorkspaces(db, env, now, config, result)],
  ];

  for (const [name, run] of phases) {
    try {
      await run();
    } catch (err) {
      result.errors++;
      log.error('node_cleanup.phase_failed', {
        phase: name,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  return result;
}
