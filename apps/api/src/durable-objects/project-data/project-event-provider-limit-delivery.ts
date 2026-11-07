import { credentialLimitReferenceKey } from '../../services/credential-limit-events/values';
import { parseProviderLimitWait } from '../../services/provider-limit-policy';
import { resolveProjectEventLimits } from './project-events-limits';
import { readSubscription } from './project-events-materialization-storage';
import { buildWakePromptInput } from './project-events-wake-prompt';
import { resolveMailboxMaxMessages } from './project-events-wake-targets';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

/** Runs again immediately before runtime side effects, including idle steer fallback. */
export async function providerLimitEventDeliveryGuard(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim
): Promise<PromptDeliveryResult | null> {
  if (claim.mode !== 'submit' || claim.message.sourceKind !== 'project_event_wake' || !projectId)
    return null;
  // Subscriptions retain their source task across legacy recovery. Provider state belongs
  // to the live task currently owning the target chat, whose authority was checked above.
  const task = await env.DATABASE.prepare(
    `SELECT t.provider_limit_wait_json,
      (SELECT a.agent_credential_reference FROM agent_sessions a WHERE a.workspace_id=t.workspace_id
        AND a.status='running' ORDER BY a.created_at DESC LIMIT 1) AS credential_reference
     FROM tasks t WHERE t.project_id=? AND t.chat_session_id=?
       AND t.status NOT IN ('completed','failed','cancelled')
     LIMIT 1`
  )
    .bind(projectId, claim.message.targetSessionId)
    .first<{ provider_limit_wait_json: string | null; credential_reference: string | null }>();
  const wait = parseProviderLimitWait(task?.provider_limit_wait_json);
  // Retain the parked identity as well: queued self-notices must not revive after credential changes.
  const keys = [
    ...new Set(
      [await credentialLimitReferenceKey(task?.credential_reference), wait?.credentialKey].filter(
        (key): key is string => Boolean(key)
      )
    ),
  ];
  if (keys.length) {
    const own = sql
      .exec(
        `SELECT m.id, m.event_id FROM project_event_matches m JOIN project_events e ON e.id=m.event_id
       WHERE m.project_id=? AND m.batch_id=? AND e.subject_type='credential'
         AND e.subject_id IN (?, ?) AND e.event_type LIKE 'credential.limit.%'`,
        projectId,
        claim.message.id,
        keys[0] ?? null,
        keys[1] ?? null
      )
      .toArray();
    if (own.length) {
      const ownIds = new Set(own.map((row) => row.event_id));
      const ids =
        (claim.message.metadata?.eventIds as string[] | undefined)?.filter(
          (id) => !ownIds.has(id)
        ) ?? [];
      for (const row of own)
        sql.exec(
          `UPDATE project_event_matches SET state='recorded_not_injected', reason='own credential limit event', batch_id=NULL WHERE id=?`,
          row.id
        );
      const remaining = sql
        .exec(
          'SELECT id FROM project_event_matches WHERE project_id=? AND batch_id=?',
          projectId,
          claim.message.id
        )
        .toArray();
      sql.exec(
        'UPDATE project_event_delivery_batches SET match_ids_json=?, event_count=? WHERE id=?',
        JSON.stringify(remaining.map((row) => row.id)),
        ids.length,
        claim.message.id
      );
      if (!ids.length)
        return {
          kind: 'failed',
          reason: 'terminal_target',
          error: 'Own credential limit events are recorded without prompting their session',
          runtimeIdentity: claim.message.runtimeIdentity,
          capabilities: null,
        };
      const subscriptionId = claim.message.metadata?.subscriptionId;
      if (typeof subscriptionId !== 'string' || !claim.message.sourceTaskId)
        throw new Error('Event wake subscription identity missing');
      const input = buildWakePromptInput({
        batchId: claim.message.id,
        subscription: readSubscription(sql, projectId, subscriptionId),
        sourceTaskGuard: {
          requireSourceProjectMember: true,
          taskId: claim.message.sourceTaskId,
          projectId,
          chatSessionId: claim.message.targetSessionId,
        },
        eventIds: ids,
        now: claim.message.createdAt,
        ttlMs: resolveProjectEventLimits(env).wakePromptTtlMs,
        maxMessages: resolveMailboxMaxMessages(env),
      });
      claim.message.content = input.deliveryContent ?? input.displayContent;
      claim.message.metadata = input.metadata ?? null;
      sql.exec(
        'UPDATE session_inbox SET content=?, metadata=? WHERE id=?',
        claim.message.content,
        JSON.stringify(input.metadata),
        claim.message.id
      );
      sql.exec(
        // Transcript text is immutable audit history; only delivery metadata is refined.
        `UPDATE chat_messages SET tool_metadata=json_set(tool_metadata,'$.eventIds',json(?),'$.eventCount',?) WHERE id=?`,
        JSON.stringify(ids),
        ids.length,
        claim.message.promptMessageId
      );
    }
  }
  if (wait && wait.phase !== 'released')
    return {
      kind: 'retry',
      reason: 'not_ready',
      error: 'Project events deferred until provider limit wait is released',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  return null;
}
