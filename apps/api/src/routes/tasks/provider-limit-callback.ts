import type * as v from 'valibot';

import type { Task } from '../../db/schema';
import type { Env } from '../../env';
import { type UpdateTaskStatusSchema } from '../../schemas';
import {
  clearProviderLimitWaitAfterSuccess,
  parkTaskForProviderLimit,
  repairProviderLimitIntents,
} from '../../services/provider-limit-parking';
import { parseProviderLimitWait } from '../../services/provider-limit-policy';

/** Called only behind authenticated workspace and stale-callback fences. */
export async function handleProviderLimitCallback(
  env: Env,
  task: Task,
  body: v.InferOutput<typeof UpdateTaskStatusSchema>,
  beforeMutation: () => Promise<unknown>
): Promise<Task | null> {
  if (!task.workspaceId) return null;
  if (
    body.promptSucceeded === true &&
    body.executionStep === 'awaiting_followup' &&
    !body.errorMessage &&
    !body.toStatus &&
    task.providerLimitWaitJson
  ) {
    await beforeMutation();
    await clearProviderLimitWaitAfterSuccess(env, task.id, task.workspaceId, {
      agentSessionId: body.providerLimitAgentSessionId,
      credentialGeneration: body.providerLimitCredentialGeneration,
      promptAttemptId: body.providerLimitPromptAttemptId,
      startedAt: body.promptStartedAt,
    });
  }
  if (
    body.toStatus !== 'failed' &&
    body.errorMessage !== 'provider_limit_reached' &&
    !(
      body.errorMessage === 'agent_prompt_failed' &&
      task.admissionState === 'provider_limit_blocked'
    )
  )
    return null;
  if (body.providerLimitAgentSessionId) {
    const active = await env.DATABASE.prepare(
      "SELECT id,agent_credential_generation,agent_credential_source FROM agent_sessions WHERE workspace_id=? AND status='running' LIMIT 2"
    )
      .bind(task.workspaceId)
      .all<{
        id: string;
        agent_credential_generation: number;
        agent_credential_source: string | null;
      }>();
    if (
      active.results.length !== 1 ||
      active.results[0]?.id !== body.providerLimitAgentSessionId ||
      active.results[0]?.agent_credential_generation !== body.providerLimitCredentialGeneration
    )
      return task;
    if (active.results[0]?.agent_credential_source === 'platform') return null;
  }
  if (
    body.errorMessage === 'agent_prompt_failed' &&
    task.admissionState === 'provider_limit_blocked'
  ) {
    const wait = parseProviderLimitWait(task.providerLimitWaitJson);
    if (wait?.phase === 'blocked')
      await repairProviderLimitIntents(env, task, wait, beforeMutation);
    return task;
  }
  // Current agents explicitly classify quotas; generic inference is legacy-only.
  if (body.providerLimitAgentSessionId && body.errorMessage !== 'provider_limit_reached')
    return null;
  const parked = await parkTaskForProviderLimit(env, task, {
    errorMessage: body.errorMessage,
    resetsAt: body.providerLimitResetsAt,
    agentSessionId: body.providerLimitAgentSessionId,
    credentialGeneration: body.providerLimitCredentialGeneration,
    promptAttemptId: body.providerLimitPromptAttemptId,
    beforeMutation,
  });
  return parked ?? (body.providerLimitAgentSessionId ? task : null);
}
