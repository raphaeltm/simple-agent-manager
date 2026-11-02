import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { getSelectedAgentCredentialReference } from '../../routes/credentials';
import { resolveProfileCredentialContext } from '../../services/composable-credentials/profile-context';
import { credentialLimitReferenceKey } from '../../services/credential-limit-events/values';
import * as projectData from '../../services/project-data';
import {
  newProviderLimitWait,
  parseProviderLimitWait,
  PROVIDER_LIMIT_POLICY,
} from '../../services/provider-limit-policy';
import { rejectedProviderWindow } from '../../services/provider-limit-window';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Admission holds the runner's existing alarm before provisioning. No provider
 * request, model change, credential write or alternate selection is made here. */
export async function holdTaskForProviderLimit(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  if (
    state.currentStep !== 'node_selection' &&
    (state.currentStep !== 'agent_session' || state.stepResults.agentStarted)
  )
    return false;
  const row = await rc.env.DATABASE.prepare(
    'SELECT provider_limit_wait_json, agent_profile_hint, skill_id FROM tasks WHERE id = ?'
  )
    .bind(state.taskId)
    .first<{
      provider_limit_wait_json: string | null;
      agent_profile_hint: string | null;
      skill_id: string | null;
    }>();
  const previous = parseProviderLimitWait(row?.provider_limit_wait_json);
  const now = Date.now();
  if (row?.provider_limit_wait_json && !previous) {
    await rc.assertRecoveryAuthority(state);
    await rc.env.DATABASE.prepare(
      "UPDATE tasks SET admission_state='provider_limit_blocked',admission_reason=?,admission_next_retry_at=NULL WHERE id=? AND provider_limit_wait_json IS ?"
    )
      .bind(
        'Blocked: provider recovery metadata is unavailable; review before resuming.',
        state.taskId,
        row.provider_limit_wait_json
      )
      .run();
    await rc.ctx.storage.deleteAlarm();
    return true;
  }
  if (!previous) {
    // Cheap indexed/project-bounded negative path avoids resolving/decrypting
    // credentials for normal dispatches without recent provider rejection.
    const rejected = await rc.env.DATABASE.prepare(
      `SELECT 1 FROM credential_limit_windows
      WHERE project_id = ? AND status = 'rejected' AND (resets_at > ? OR (resets_at IS NULL AND observed_at >= ?)) LIMIT 1`
    )
      .bind(state.projectId, now, now - PROVIDER_LIMIT_POLICY.recentRejectionMs)
      .first();
    // Shared credentials can reject in another project, so also check the
    // bounded global rejection marker before bypassing exact selection.
    const elsewhere =
      rejected ??
      (await rc.env.DATABASE.prepare(
        `SELECT 1 FROM credential_limit_windows
      WHERE status = 'rejected' AND (resets_at > ? OR (resets_at IS NULL AND observed_at >= ?)) LIMIT 1`
      )
        .bind(now, now - PROVIDER_LIMIT_POLICY.recentRejectionMs)
        .first());
    const intent =
      elsewhere ??
      (await rc.env.DATABASE.prepare(
        `SELECT 1 FROM tasks
      WHERE admission_state IN ('provider_limit_waiting','provider_limit_blocked')
      AND status IN ('queued','delegated','in_progress','sleeping')
      AND json_extract(CASE WHEN json_valid(provider_limit_wait_json) THEN provider_limit_wait_json ELSE '{}' END,'$.origin') = 'callback' LIMIT 1`
      ).first());
    if (!intent) return false;
  }

  // Same profile context as the agent-key callback, so admission checks the limit
  // of the account the run will actually start on (a personal profile pin included).
  const db = drizzle(rc.env.DATABASE, { schema });
  const profile = await resolveProfileCredentialContext(db, {
    userId: state.userId,
    projectId: state.projectId,
    profileId: row?.agent_profile_hint ?? state.config.agentProfileHint,
    skillId: row?.skill_id ?? null,
  });
  const reference = await getSelectedAgentCredentialReference(
    db,
    state.userId,
    state.config.agentType || rc.env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    getCredentialEncryptionKey(rc.env),
    state.projectId,
    profile
  );
  const key = reference ? await credentialLimitReferenceKey(reference) : null;
  const window = await rejectedProviderWindow(rc.env, reference, now);
  let wait = previous;
  if (previous?.credentialKey && previous.credentialKey !== key) {
    wait = {
      ...previous,
      phase: 'blocked',
      reason: 'Blocked: selected provider credential changed; review before resuming.',
    };
  } else if (previous?.phase === 'blocked') {
    await rc.ctx.storage.deleteAlarm();
    return true; // no automatic retries once blocked
  } else if (previous?.phase === 'waiting' && previous.deadlineAt < now) {
    wait = {
      ...previous,
      phase: 'blocked',
      reason:
        'Blocked: provider limit wake deadline expired. Review retained work before resuming.',
    };
  } else if (previous?.phase === 'waiting' && previous.nextRetryAt > now) {
    await rc.ctx.storage.setAlarm(previous.nextRetryAt);
    return true;
  } else if (!window) {
    if (previous && previous.phase !== 'released') {
      await rc.assertRecoveryAuthority(state);
      const released = await rc.env.DATABASE.prepare(
        `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = NULL, admission_reason = NULL, admission_next_retry_at = NULL
         WHERE id = ? AND provider_limit_wait_json IS ?`
      )
        .bind(
          JSON.stringify({ ...previous, phase: 'released' }),
          state.taskId,
          row?.provider_limit_wait_json ?? null
        )
        .run();
      if ((released.meta.changes ?? 0) === 0) {
        await rc.ctx.storage.setAlarm(now + PROVIDER_LIMIT_POLICY.resetGraceMs);
        return true;
      }
    }
    return false;
  } else {
    wait = newProviderLimitWait({
      taskId: state.taskId,
      origin: 'admission',
      incidentId: `admission:${state.taskId}:${window.observedAt}`,
      credentialKey: key,
      previous,
      now,
      resetsAt: window.resetsAt,
    });
  }
  if (!wait) return false;
  if (state.currentStep === 'agent_session' && wait.phase === 'waiting') {
    wait = {
      ...wait,
      reason: `Blocked before provider prompt: ${wait.reason} Existing runtime remains allocated until this retry; the normal compute ceiling applies.`,
    };
  }
  await rc.assertRecoveryAuthority(state);
  const persisted = await rc.env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json = ?, admission_state = ?, admission_reason = ?, admission_next_retry_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued','delegated') AND provider_limit_wait_json IS ?`
  )
    .bind(
      JSON.stringify(wait),
      `provider_limit_${wait.phase}`,
      wait.reason,
      wait.phase === 'waiting' ? new Date(wait.nextRetryAt).toISOString() : null,
      new Date(now).toISOString(),
      state.taskId,
      row?.provider_limit_wait_json ?? null
    )
    .run();
  if ((persisted.meta.changes ?? 0) === 0) {
    await rc.ctx.storage.setAlarm(now + PROVIDER_LIMIT_POLICY.resetGraceMs);
    return true;
  }
  if (state.config.chatSessionId)
    await projectData.persistMessage(
      rc.env,
      state.projectId,
      state.config.chatSessionId,
      'system',
      wait.reason,
      null,
      `${wait.scheduleKey}:notice`
    );
  if (wait.phase === 'waiting') await rc.ctx.storage.setAlarm(wait.nextRetryAt);
  else await rc.ctx.storage.deleteAlarm();
  return true;
}
