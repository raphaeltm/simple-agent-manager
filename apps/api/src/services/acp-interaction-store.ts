import type {
  InteractionStore,
  InteractionStoreAnswerInput,
  InteractionStoreCreateInput,
  InteractionStoreSettleInput,
} from '../durable-objects/interaction-store';
import type { Env } from '../env';

function ownerName(projectId: string, chatSessionId: string): string {
  return `${projectId}/${chatSessionId}`;
}

export function getInteractionStore(
  env: Pick<Env, 'INTERACTION_STORE'>,
  projectId: string,
  chatSessionId: string
): DurableObjectStub<InteractionStore> {
  return env.INTERACTION_STORE.get(
    env.INTERACTION_STORE.idFromName(ownerName(projectId, chatSessionId))
  ) as DurableObjectStub<InteractionStore>;
}

export function createInteraction(env: Env, input: InteractionStoreCreateInput) {
  return getInteractionStore(env, input.projectId, input.chatSessionId).create(input);
}

export function settleInteraction(env: Env, input: InteractionStoreSettleInput) {
  return getInteractionStore(env, input.projectId, input.chatSessionId).settle(input);
}

export function answerInteraction(env: Env, input: InteractionStoreAnswerInput) {
  return getInteractionStore(env, input.projectId, input.chatSessionId).answer(input);
}

export function snapshotInteractions(
  env: Env,
  projectId: string,
  chatSessionId: string,
  cursor: string | null = null
) {
  return getInteractionStore(env, projectId, chatSessionId).snapshot(cursor);
}

export function getInteractionDetail(
  env: Env,
  projectId: string,
  chatSessionId: string,
  interactionId: string
) {
  return getInteractionStore(env, projectId, chatSessionId).detail(interactionId);
}

export function purgeInteractionStore(env: Env, projectId: string, chatSessionId: string) {
  if (!env.INTERACTION_STORE) return undefined;
  return getInteractionStore(env, projectId, chatSessionId).purge();
}

export function recordInteractionDelivery(
  env: Env,
  projectId: string,
  chatSessionId: string,
  interactionId: string,
  outcome: 'confirmed' | 'unconfirmed' | 'interrupted',
  error: string | null = null
) {
  return getInteractionStore(env, projectId, chatSessionId).recordDelivery(
    interactionId,
    outcome,
    error
  );
}
