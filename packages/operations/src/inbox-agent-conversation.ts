/** Pending state is derived from the ledger; reply bodies remain in the canonical chat. */
import * as v from 'valibot';

import type { OperationContext } from './types';

export async function inboxAgentReplyState(
  ctx: OperationContext,
  projectId: string,
  ref: string,
  visibleReplyIds: string[] = []
): Promise<{ withAgent: boolean; pendingReplyIds: string[] }> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT EXISTS (SELECT 1 FROM inbox_replies
       WHERE project_id = ? AND item_ref = ? AND agent_acted_at IS NULL) AS with_agent,
     (SELECT json_group_array(message_id) FROM inbox_replies
       WHERE project_id = ? AND item_ref = ? AND agent_acted_at IS NULL
         AND message_id IN (SELECT value FROM json_each(?))) AS pending_ids`
  )
    .bind(projectId, ref, projectId, ref, JSON.stringify(visibleReplyIds))
    .first();
  const state = v.parse(v.object({ with_agent: v.number(), pending_ids: v.string() }), row);
  return {
    withAgent: state.with_agent === 1,
    pendingReplyIds: v.parse(v.array(v.string()), JSON.parse(state.pending_ids)),
  };
}
