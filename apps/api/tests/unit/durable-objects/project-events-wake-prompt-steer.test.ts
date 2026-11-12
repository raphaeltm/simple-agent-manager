import { buildWakePromptInput } from '@simple-agent-manager/project-data/internal/do/project-events-wake-prompt';
import type { ProjectEventSubscriptionRecord } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

function subscription(requested: string): ProjectEventSubscriptionRecord {
  return {
    id: 'sub-1',
    filter: { source: 'github' },
    deliveryPreference: {
      requested,
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: 'chat-1', taskId: 'task-1', runtimeId: null, agentId: null },
    },
  } as unknown as ProjectEventSubscriptionRecord;
}

function build(requested: string) {
  return buildWakePromptInput({
    batchId: 'batch-1',
    subscription: subscription(requested),
    sourceTaskGuard: { taskId: 'task-1' } as never,
    eventIds: ['evt-1'],
    now: 1,
    ttlMs: 60_000,
    maxMessages: 100,
  });
}

describe('event wake delivery intent', () => {
  it('runtime_steer wakes steer the running turn without becoming urgent', () => {
    const input = build('runtime_steer');
    expect(input).toMatchObject({ deliveryIntent: 'steer', messageClass: 'deliver' });
    expect(input.metadata).toMatchObject({ runtimeSteer: true });
    expect(input.deliveryContent).toContain('does not stop your work');
  });

  it.each([
    ['existing_session_prompt', 'queue', 'deliver'],
    ['runtime_interrupt', 'queue', 'interrupt'],
  ])('%s keeps its existing intent and class', (requested, intent, messageClass) => {
    expect(build(requested)).toMatchObject({ deliveryIntent: intent, messageClass });
  });
});
