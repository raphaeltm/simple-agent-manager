/** Durable, idempotent loss notices survive provider deletion and ProjectData outages. */
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectData from '../../services/project-data';
import { RetirementSourceSchema, verifyRetirementSource } from './stranded-source-preservation';

export async function repairStrandedRetirementNotices(
  env: Env,
  nodeLimit: number,
  sourceLimit: number
): Promise<void> {
  const nodes = await env.DATABASE.prepare(
    `SELECT id,user_id,runtime_termination_confirmed_at
    FROM nodes WHERE cleanup_retirement_sources_json IS NOT NULL
      AND runtime_termination_confirmed_at IS NOT NULL
    ORDER BY updated_at,id LIMIT ?`
  )
    .bind(nodeLimit)
    .all<{ id: string; user_id: string; runtime_termination_confirmed_at: string }>();
  let remaining = sourceLimit;
  for (const node of nodes.results) {
    // Invalidate every affected wake in one D1 write BEFORE any fallible DO call.
    await env.DATABASE.prepare(
      `UPDATE session_snapshots
      SET status='expired', sleep_status='failed', recovery_status='failed',
        recovery_error='Workspace disk was not preserved before automatic VM retirement',
        sleeping_at=COALESCE(sleeping_at, ?), expires_at=?, sleep_after=NULL,
        sleep_claim_id=NULL, sleep_claimed_at=NULL, updated_at=?
      WHERE node_id=? AND user_id=? AND COALESCE(recovery_status,'') NOT IN ('waking','restored') AND id IN (
        SELECT json_extract(source.value,'$.snapshotId') FROM nodes n,
          json_each(n.cleanup_retirement_sources_json) source WHERE n.id=?
            AND COALESCE(json_extract(source.value,'$.preservationPending'),0)=0
            AND n.runtime_incarnation_id IS json_extract(source.value,'$.runtimeIncarnationId')
            AND session_snapshots.workspace_id IS json_extract(source.value,'$.workspaceId')
            AND session_snapshots.snapshot_generation IS json_extract(source.value,'$.snapshotGeneration'))`
    )
      .bind(
        node.runtime_termination_confirmed_at,
        node.runtime_termination_confirmed_at,
        node.runtime_termination_confirmed_at,
        node.id,
        node.user_id,
        node.id
      )
      .run();
    if (remaining <= 0) break;
    const sources = await env.DATABASE.prepare(
      `SELECT source.value AS source FROM nodes n,
      json_each(n.cleanup_retirement_sources_json) source WHERE n.id=?
        AND n.runtime_incarnation_id IS json_extract(source.value,'$.runtimeIncarnationId') LIMIT ?`
    )
      .bind(node.id, remaining)
      .all<{ source: string }>();
    for (const { source } of sources.results) {
      remaining--;
      const parsed = v.parse(RetirementSourceSchema, JSON.parse(source) as unknown);
      try {
        const current = await env.DATABASE.prepare(
          `SELECT id FROM nodes n WHERE n.id=? AND n.user_id=?
          AND n.runtime_incarnation_id IS ? AND n.runtime_termination_confirmed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM session_snapshots s WHERE s.id=?
            AND (s.workspace_id IS NOT ? OR s.snapshot_generation IS NOT ? OR s.node_id IS NOT n.id OR s.recovery_status IN ('waking','restored')))`
        )
          .bind(
            node.id,
            node.user_id,
            parsed.runtimeIncarnationId,
            parsed.snapshotId,
            parsed.workspaceId,
            parsed.snapshotGeneration
          )
          .first();
        // A replacement generation supersedes the old notice; never fail its session.
        let preserved = !current;
        if (current && parsed.preservationPending) {
          preserved = await verifyRetirementSource(env, node, parsed);
          if (!preserved && parsed.snapshotId) {
            await env.DATABASE.prepare(
              `UPDATE session_snapshots SET status='expired',sleep_status='failed',
              recovery_status='failed',recovery_error='Workspace disk was not preserved before automatic VM retirement',
              sleeping_at=COALESCE(sleeping_at,?),expires_at=?,sleep_after=NULL,sleep_claim_id=NULL,sleep_claimed_at=NULL
              WHERE id=? AND node_id=? AND user_id=? AND COALESCE(recovery_status,'') NOT IN ('waking','restored') AND workspace_id IS ? AND snapshot_generation IS ?
              AND EXISTS (SELECT 1 FROM nodes n WHERE n.id=session_snapshots.node_id AND n.runtime_incarnation_id IS ?
                AND n.runtime_termination_confirmed_at IS NOT NULL)`
            )
              .bind(
                node.runtime_termination_confirmed_at,
                node.runtime_termination_confirmed_at,
                parsed.snapshotId,
                node.id,
                node.user_id,
                parsed.workspaceId,
                parsed.snapshotGeneration,
                parsed.runtimeIncarnationId
              )
              .run();
          }
        }
        if (!preserved && parsed.projectId && parsed.chatSessionId && parsed.workspaceId)
          await projectData.failSession(
            env,
            parsed.projectId,
            parsed.chatSessionId,
            'Workspace disk was not preserved before automatic VM retirement',
            { workspaceId: parsed.workspaceId }
          );
        // Remove only delivered notices; leave failed ones for the next cron.
        await env.DATABASE.prepare(
          `UPDATE nodes SET cleanup_retirement_sources_json=(
          SELECT CASE WHEN COUNT(*)=0 THEN NULL ELSE json_group_array(json(source.value)) END
          FROM json_each(nodes.cleanup_retirement_sources_json) source WHERE source.value != ?)
          WHERE id=? AND user_id=? AND runtime_termination_confirmed_at IS NOT NULL AND runtime_incarnation_id IS ?`
        )
          .bind(source, node.id, node.user_id, parsed.runtimeIncarnationId)
          .run();
      } catch (error) {
        log.warn('node_cleanup.stranded_retirement_notice_retry', {
          nodeId: node.id,
          error: String(error),
        });
        // Rotate a failed source behind its siblings so an unavailable session
        // cannot consume the entire source budget on every tick.
        await env.DATABASE.prepare(
          `UPDATE nodes SET cleanup_retirement_sources_json=json_insert((
          SELECT json_group_array(json(source.value)) FROM json_each(nodes.cleanup_retirement_sources_json) source
          WHERE source.value != ?),'$[#]',json(?)) WHERE id=? AND user_id=? AND runtime_incarnation_id IS ?
            AND EXISTS (SELECT 1 FROM json_each(nodes.cleanup_retirement_sources_json) item WHERE item.value=?)`
        )
          .bind(source, source, node.id, node.user_id, parsed.runtimeIncarnationId, source)
          .run();
      }
    }
    // Empty source manifests do not need a subsequent repair pass.
    await env.DATABASE.prepare(
      `UPDATE nodes SET cleanup_retirement_sources_json=NULL
      WHERE id=? AND cleanup_retirement_sources_json='[]'`
    )
      .bind(node.id)
      .run();
    await env.DATABASE.prepare(
      'UPDATE nodes SET updated_at=? WHERE id=? AND cleanup_retirement_sources_json IS NOT NULL'
    )
      .bind(new Date().toISOString(), node.id)
      .run();
  }
}
