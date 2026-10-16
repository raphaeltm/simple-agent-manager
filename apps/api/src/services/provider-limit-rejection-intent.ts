import type { Task } from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { recordCredentialLimitObservation } from './credential-limit-events';
import { credentialLimitReferenceKey } from './credential-limit-events/values';
import type { ProviderLimitWait } from './provider-limit-policy';

/** A task wait is the durable outbox intent; admission reads it if this optional
 * observation is delayed or capacity-bound. Never refresh its source time. */
export async function repairProviderLimitRejectionObservation(
  env: Env,
  task: Pick<Task, 'id' | 'projectId' | 'userId' | 'workspaceId' | 'chatSessionId'>,
  wait: ProviderLimitWait
): Promise<void> {
  if (
    !wait.sourceAgentSessionId ||
    wait.sourceCredentialGeneration === undefined ||
    !wait.credentialKey
  )
    return;
  const session = await env.DATABASE.prepare(
    `SELECT agent_credential_reference,agent_credential_source,agent_type,agent_provider_mode FROM agent_sessions WHERE id=? AND workspace_id=? AND agent_credential_generation=?`
  )
    .bind(wait.sourceAgentSessionId, task.workspaceId, wait.sourceCredentialGeneration)
    .first<{
      agent_credential_reference: string | null;
      agent_credential_source: string | null;
      agent_type: string | null;
      agent_provider_mode: string | null;
    }>();
  if (
    !session?.agent_credential_reference ||
    !session.agent_credential_source ||
    (await credentialLimitReferenceKey(session.agent_credential_reference)) !== wait.credentialKey
  )
    return;
  const result = await recordCredentialLimitObservation(env, {
    projectId: task.projectId,
    userId: task.userId,
    credentialReference: session.agent_credential_reference,
    credentialSource: session.agent_credential_source,
    provider:
      session.agent_type === 'claude-code'
        ? 'anthropic'
        : session.agent_type === 'openai-codex'
          ? 'openai'
          : 'opencode',
    providerMode: session.agent_provider_mode ?? 'unknown',
    windowType: 'provider.prompt_rejection',
    source: 'task-prompt.limit_rejection',
    observedAt: wait.observedAt,
    status: 'rejected',
    resetsAt: wait.resetsAt,
    agentType: session.agent_type,
    agentSessionId: wait.sourceAgentSessionId,
    workspaceId: task.workspaceId,
    chatSessionId: task.chatSessionId,
  });
  if (result.outcome === 'ignored' && result.reason === 'capacity')
    log.warn('provider_limit.rejection_observation_pending', { taskId: task.id });
}
