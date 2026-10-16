import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { recordCredentialLimitObservation } from './credential-limit-events';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import * as projectData from './project-data';
import {
  newProviderLimitWait,
  parseProviderLimitWait,
  PROVIDER_LIMIT_CONTINUATION,
  PROVIDER_LIMIT_POLICY,
  providerLimitNeedsImmediateSleep,
  type ProviderLimitWait,
} from './provider-limit-policy';
import { repairProviderLimitRejectionObservation } from './provider-limit-rejection-intent';
import { rejectedProviderWindow } from './provider-limit-window';
import { queueWorkspaceSessionSleep } from './session-sleep';
import {
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  getSessionSnapshotConfig,
} from './session-snapshot-artifacts';

const AttributionSchema = v.object({
  id: v.string(),
  agent_credential_reference: v.nullable(v.string()),
  agent_credential_generation: v.number(),
  agent_credential_source: v.nullable(v.string()),
  agent_type: v.nullable(v.string()),
  agent_provider_mode: v.nullable(v.string()),
});

const storedWaitJson =
  "CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END";
const waitIdentitySql = `json_extract(${storedWaitJson}, '$.version') = 1
  AND json_extract(${storedWaitJson}, '$.scheduleKey') = ?
  AND json_extract(${storedWaitJson}, '$.incidentId') = ?
  AND json_extract(${storedWaitJson}, '$.origin') = ?
  AND json_extract(${storedWaitJson}, '$.phase') = ?
  AND json_extract(${storedWaitJson}, '$.credentialKey') IS ?
  AND json_extract(${storedWaitJson}, '$.sourceAgentSessionId') IS ?
  AND json_extract(${storedWaitJson}, '$.sourceCredentialGeneration') IS ?`;
function waitIdentityValues(wait: ProviderLimitWait) {
  return [
    wait.scheduleKey,
    wait.incidentId,
    wait.origin,
    wait.phase,
    wait.credentialKey,
    wait.sourceAgentSessionId ?? null,
    wait.sourceCredentialGeneration ?? null,
  ];
}

/** Persist before distributed sleep/schedule calls. Re-delivery repairs those
 * idempotent intents without spending another attempt or terminalizing work. */
export async function parkTaskForProviderLimit(
  env: Env,
  task: schema.Task,
  input: {
    errorMessage: string | undefined;
    resetsAt?: number;
    agentSessionId?: string;
    credentialGeneration?: number;
    promptAttemptId?: number;
    beforeMutation: () => Promise<unknown>;
  }
): Promise<schema.Task | null> {
  if (
    !['in_progress', 'delegated', 'sleeping'].includes(task.status) ||
    !task.workspaceId ||
    !task.chatSessionId
  )
    return null;
  const code = input.errorMessage?.trim();
  if (code !== 'provider_limit_reached' && code !== 'agent_prompt_failed') return null;
  const now = Date.now();
  const raw = await env.DATABASE.prepare(
    `SELECT id, agent_credential_reference, agent_credential_generation, agent_credential_source, agent_type, agent_provider_mode
      FROM agent_sessions WHERE workspace_id = ? AND status = 'running' AND (? IS NULL OR id = ?)
      ORDER BY created_at DESC, id DESC LIMIT 2`
  )
    .bind(task.workspaceId, input.agentSessionId ?? null, input.agentSessionId ?? null)
    .all();
  // Older callbacks lack a session id. Multiple sessions are ambiguous; never
  // bind a generic failure to whichever credential happened to be newest.
  if (raw.results.length !== 1) return null;
  const activeCount = await env.DATABASE.prepare(
    "SELECT COUNT(*) AS count FROM agent_sessions WHERE workspace_id = ? AND status = 'running'"
  )
    .bind(task.workspaceId)
    .first<{ count: number }>();
  if (activeCount?.count !== 1) return null;
  const parsed = v.safeParse(AttributionSchema, raw.results[0]);
  if (!parsed.success) return null;
  const session = parsed.output;
  // SAM-managed platform quotas are outside personal/project limit recovery.
  if (session.agent_credential_source === 'platform') return null;
  if (
    input.agentSessionId &&
    (input.credentialGeneration === undefined ||
      input.credentialGeneration !== session.agent_credential_generation)
  )
    return null;
  const window = await rejectedProviderWindow(env, session.agent_credential_reference, now);
  const incidentId = `${task.workspaceId}:${session.id}:${input.promptAttemptId ?? 'legacy'}`;
  const previous = parseProviderLimitWait(task.providerLimitWaitJson);
  // Generic failures always need fresh evidence, even on an already parked
  // session. Intent repair is a separate path, not proof of a new rejection.
  if (
    code === 'agent_prompt_failed' &&
    (!window || now - window.observedAt > PROVIDER_LIMIT_POLICY.recentRejectionMs)
  )
    return null;
  let wait = previous?.incidentId === incidentId ? previous : null;
  if (!wait) {
    const snapshot = await env.DATABASE.prepare(
      'SELECT expires_at FROM session_snapshots WHERE project_id = ? AND chat_session_id = ?'
    )
      .bind(task.projectId, task.chatSessionId)
      .first<{ expires_at: string | null }>();
    const expiry = snapshot?.expires_at ? Date.parse(snapshot.expires_at) : NaN;
    const key = session.agent_credential_reference
      ? await credentialLimitReferenceKey(session.agent_credential_reference)
      : null;
    wait = newProviderLimitWait({
      taskId: task.id,
      origin: 'callback',
      incidentId,
      credentialKey: key,
      previous,
      now,
      resetsAt: Math.max(input.resetsAt ?? 0, window?.resetsAt ?? 0) || null,
      snapshotExpiresAt: Number.isFinite(expiry)
        ? expiry
        : now + getSessionSnapshotConfig(env).ttlDays * 24 * 60 * 60_000,
    });
    wait = {
      ...wait,
      sourceAgentSessionId: session.id,
      sourceCredentialGeneration: session.agent_credential_generation,
    };
    await input.beforeMutation();
    const result = await env.DATABASE.prepare(
      `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = ?, admission_reason = ?, admission_next_retry_at = ?, updated_at = ?
       WHERE id = ? AND project_id = ? AND workspace_id = ? AND status IN ('in_progress','delegated','sleeping')
         AND provider_limit_wait_json IS ?
         AND EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id = ? AND a.workspace_id = tasks.workspace_id AND a.status = 'running' AND a.agent_credential_generation = ? AND a.agent_credential_reference IS ?)
         AND (SELECT COUNT(*) FROM agent_sessions a WHERE a.workspace_id = tasks.workspace_id AND a.status = 'running') = 1 RETURNING id`
    )
      .bind(
        JSON.stringify(wait),
        `provider_limit_${wait.phase}`,
        wait.reason,
        wait.phase === 'waiting' ? new Date(wait.nextRetryAt).toISOString() : null,
        new Date(now).toISOString(),
        task.id,
        task.projectId,
        task.workspaceId,
        task.providerLimitWaitJson ?? null,
        session.id,
        session.agent_credential_generation,
        session.agent_credential_reference
      )
      .first();
    if (!result) {
      const db = drizzle(env.DATABASE, { schema });
      const current = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get();
      if (
        !current ||
        parseProviderLimitWait(current.providerLimitWaitJson)?.incidentId !== incidentId
      )
        return current ?? null;
      const persistedWait = parseProviderLimitWait(current.providerLimitWaitJson);
      if (!persistedWait) return current;
      wait = persistedWait;
    }
  }
  // Repair redeliveries only while this exact source and wait are still current.
  const authorized = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = provider_limit_wait_json
    WHERE id = ? AND workspace_id = ? AND ${waitIdentitySql}
    AND EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id = ? AND a.workspace_id = tasks.workspace_id AND a.status = 'running' AND a.agent_credential_generation = ? AND a.agent_credential_reference IS ?)
    AND (SELECT COUNT(*) FROM agent_sessions a WHERE a.workspace_id = tasks.workspace_id AND a.status = 'running') = 1 RETURNING id`
  )
    .bind(
      task.id,
      task.workspaceId,
      ...waitIdentityValues(wait),
      session.id,
      session.agent_credential_generation,
      session.agent_credential_reference
    )
    .first();
  if (!authorized) return task;
  await repairProviderLimitIntents(env, task, wait, input.beforeMutation);
  const db = drizzle(env.DATABASE, { schema });
  return (await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get()) ?? null;
}

export async function repairProviderLimitIntents(
  env: Env,
  task: Pick<schema.Task, 'id' | 'projectId' | 'userId' | 'workspaceId' | 'chatSessionId'>,
  wait: ProviderLimitWait,
  beforeMutation: () => Promise<unknown> = async () => {}
): Promise<void> {
  if (
    (wait.origin !== 'callback' && wait.phase !== 'blocked') ||
    wait.phase === 'released' ||
    !task.workspaceId ||
    !task.chatSessionId
  )
    return;
  await beforeMutation();
  const activeWait = await env.DATABASE.prepare(
    `SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND ${waitIdentitySql}`
  )
    .bind(task.id, task.workspaceId, ...waitIdentityValues(wait))
    .first();
  if (!activeWait) return;
  await repairProviderLimitRejectionObservation(env, task, wait);
  // Persist an immediate sleep intent, not direct teardown. Existing bounded
  // snapshot/idleness machinery owns the release and fallback decisions.
  const sleeping = await env.DATABASE.prepare(
    'SELECT sleeping_at FROM session_snapshots WHERE chat_session_id = ? AND project_id = ?'
  )
    .bind(task.chatSessionId, task.projectId)
    .first<{ sleeping_at: string | null }>();
  if (!sleeping?.sleeping_at)
    await queueWorkspaceSessionSleep(env, {
      workspaceId: task.workspaceId,
      userId: task.userId,
      reason: wait.reason,
      ...(providerLimitNeedsImmediateSleep(
        wait,
        Date.now(),
        parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS)
      )
        ? { sleepAfterMs: 0 }
        : {}),
    });
  await beforeMutation();
  // Deterministic message id makes an uncertain response/replayed callback safe.
  await projectData.persistMessage(
    env,
    task.projectId,
    task.chatSessionId,
    'system',
    wait.reason,
    null,
    `${wait.scheduleKey}:notice:${wait.phase}`
  );
  if (wait.phase === 'blocked') return;
  await beforeMutation();
  const scheduleResult = await projectData.createProjectSchedule(env, task.projectId, {
    userId: task.userId,
    creatorChatSessionId: task.chatSessionId,
    request: {
      action: {
        kind: 'message_session',
        sessionId: task.chatSessionId,
        prompt: PROVIDER_LIMIT_CONTINUATION,
      },
      displayTimezone: 'UTC',
      dueAt: wait.nextRetryAt,
      expiresAt: wait.deadlineAt,
      idempotencyKey: wait.scheduleKey,
      reason: wait.reason,
    },
  });
  const persisted = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = json_set(${storedWaitJson}, '$.scheduleId', ?)
     WHERE id = ? AND workspace_id IS ? AND ${waitIdentitySql}
     AND json_extract(${storedWaitJson}, '$.phase') = 'waiting'
     AND json_extract(${storedWaitJson}, '$.nextRetryAt') = ?
     AND json_extract(${storedWaitJson}, '$.deadlineAt') = ?`
  )
    .bind(
      scheduleResult.schedule.id,
      task.id,
      task.workspaceId,
      ...waitIdentityValues(wait),
      wait.nextRetryAt,
      wait.deadlineAt
    )
    .run();
  if ((persisted.meta.changes ?? 0) === 0) {
    // The task may have succeeded while schedule creation was in flight. Its
    // active-wait delivery guard also rejects any admitted but obsolete message.
    const current = await env.DATABASE.prepare(
      'SELECT provider_limit_wait_json FROM tasks WHERE id = ?'
    )
      .bind(task.id)
      .first<{ provider_limit_wait_json: string | null }>();
    const currentWait = parseProviderLimitWait(current?.provider_limit_wait_json);
    if (
      currentWait?.scheduleKey !== wait.scheduleKey ||
      currentWait.phase !== 'waiting' ||
      currentWait.nextRetryAt !== wait.nextRetryAt ||
      currentWait.deadlineAt !== wait.deadlineAt
    ) {
      await projectData.mutateProjectSchedule(env, task.projectId, {
        userId: task.userId,
        id: scheduleResult.schedule.id,
        operation: 'cancel',
        request: {
          expectedVersion: scheduleResult.schedule.version,
          reason: 'Provider wait superseded or successful turn completed',
        },
      });
    }
  }
}

/** Success ends the consecutive-limit episode. A status/error callback cannot
 * accidentally clear it. Released admission metadata must not hide VM placement. */
export async function clearProviderLimitWaitAfterSuccess(
  env: Env,
  taskId: string,
  workspaceId: string,
  completion: {
    agentSessionId?: string;
    credentialGeneration?: number;
    promptAttemptId?: number;
    startedAt?: number;
  }
): Promise<void> {
  const task = await env.DATABASE.prepare(
    'SELECT project_id, user_id, provider_limit_wait_json FROM tasks WHERE id = ? AND workspace_id = ? AND status = ?'
  )
    .bind(taskId, workspaceId, 'in_progress')
    .first<{ project_id: string; user_id: string; provider_limit_wait_json: string | null }>();
  const wait = parseProviderLimitWait(task?.provider_limit_wait_json);
  if (
    !task ||
    !wait?.credentialKey ||
    wait.phase === 'blocked' ||
    !completion.agentSessionId ||
    completion.credentialGeneration === undefined ||
    completion.promptAttemptId === undefined ||
    !completion.startedAt ||
    completion.startedAt <= wait.observedAt
  )
    return;
  const identity = await env.DATABASE.prepare(
    "SELECT agent_credential_reference FROM agent_sessions WHERE id = ? AND workspace_id = ? AND status = 'running' AND agent_credential_generation = ?"
  )
    .bind(completion.agentSessionId, workspaceId, completion.credentialGeneration)
    .first<{ agent_credential_reference: string | null }>();
  if (
    !identity?.agent_credential_reference ||
    (await credentialLimitReferenceKey(identity.agent_credential_reference)) !== wait.credentialKey
  )
    return;
  const cleared = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = NULL,
      admission_state = CASE WHEN admission_state LIKE 'provider_limit_%' THEN NULL ELSE admission_state END,
      admission_reason = CASE WHEN admission_state LIKE 'provider_limit_%' THEN NULL ELSE admission_reason END,
      admission_next_retry_at = CASE WHEN admission_state LIKE 'provider_limit_%' THEN NULL ELSE admission_next_retry_at END
      WHERE id = ? AND workspace_id = ? AND status = 'in_progress' AND provider_limit_wait_json IS ?
      AND EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id = ? AND a.workspace_id = tasks.workspace_id AND a.status = 'running' AND a.agent_credential_generation = ? AND a.agent_credential_reference IS ?)
      AND (SELECT COUNT(*) FROM agent_sessions a WHERE a.workspace_id = tasks.workspace_id AND a.status = 'running') = 1 RETURNING id`
  )
    .bind(
      taskId,
      workspaceId,
      task.provider_limit_wait_json,
      completion.agentSessionId,
      completion.credentialGeneration,
      identity.agent_credential_reference
    )
    .first();
  if (!cleared) return;
  if (task && wait?.credentialKey) {
    const sessions = await env.DATABASE.prepare(
      `SELECT agent_credential_reference, agent_credential_source, agent_type, agent_provider_mode FROM agent_sessions WHERE workspace_id = ? AND status = 'running' LIMIT 2`
    )
      .bind(workspaceId)
      .all();
    const candidate =
      sessions.results.length === 1
        ? v.safeParse(
            v.object({
              agent_credential_reference: v.nullable(v.string()),
              agent_credential_source: v.nullable(v.string()),
              agent_type: v.nullable(v.string()),
              agent_provider_mode: v.nullable(v.string()),
            }),
            sessions.results[0]
          )
        : null;
    if (
      candidate?.success &&
      candidate.output.agent_credential_reference &&
      candidate.output.agent_credential_source &&
      (await credentialLimitReferenceKey(candidate.output.agent_credential_reference)) ===
        wait.credentialKey
    ) {
      await recordCredentialLimitObservation(env, {
        projectId: task.project_id,
        userId: task.user_id,
        credentialReference: candidate.output.agent_credential_reference,
        credentialSource: candidate.output.agent_credential_source,
        provider:
          candidate.output.agent_type === 'claude-code'
            ? 'anthropic'
            : candidate.output.agent_type === 'openai-codex'
              ? 'openai'
              : 'opencode',
        providerMode: candidate.output.agent_provider_mode ?? 'unknown',
        windowType: 'provider.prompt_rejection',
        source: 'task-prompt.limit_rejection',
        observedAt: completion.startedAt,
        status: 'allowed',
      });
    }
  }
  if (task && wait?.scheduleId) {
    const schedule = await projectData.getProjectSchedule(env, task.project_id, {
      userId: task.user_id,
      id: wait.scheduleId,
    });
    if (schedule?.state === 'pending' || schedule?.state === 'processing')
      await projectData.mutateProjectSchedule(env, task.project_id, {
        userId: task.user_id,
        id: wait.scheduleId,
        operation: 'cancel',
        request: {
          expectedVersion: schedule.version,
          reason: 'Provider turn succeeded before scheduled continuation',
        },
      });
  }
}
