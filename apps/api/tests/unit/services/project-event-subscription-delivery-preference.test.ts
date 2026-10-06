/**
 * Unit tests for the subscription creation-time delivery preference resolver.
 *
 * Phase 1 of urgent delivery (idea 01M2EPH9WGDYFDQBZCP9QY1FDE): runtime_interrupt
 * rides the durable prompt queue with the `interrupt` mailbox class instead of
 * being recorded as never-injected.
 */
import type { ProjectEventDeliveryPreference } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { resolveDeliveryPreference } from '../../../src/services/project-event-subscriptions-access';

const target: ProjectEventDeliveryPreference['target'] = {
  sessionId: 'session-1',
  taskId: 'task-1',
  runtimeId: null,
  agentId: 'agent-1',
};

describe('resolveDeliveryPreference', () => {
  it('keeps record_only pull-only', () => {
    expect(resolveDeliveryPreference('record_only', target)).toEqual({
      requested: 'record_only',
      resolved: 'record_only',
      target,
    });
  });

  it('resolves existing_session_prompt through the durable prompt queue', () => {
    expect(resolveDeliveryPreference('existing_session_prompt', target)).toEqual({
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target,
    });
  });

  it('maps runtime_interrupt onto the prompt queue with stop-and-deliver semantics', () => {
    expect(resolveDeliveryPreference('runtime_interrupt', target)).toEqual({
      requested: 'runtime_interrupt',
      resolved: 'queued_for_prompt_delivery',
      target,
    });
  });

  it('still records unsupported injection modes as not injected', () => {
    expect(resolveDeliveryPreference('runtime_steer', target).resolved).toBe(
      'recorded_not_injected'
    );
    expect(resolveDeliveryPreference('spawn_task', target).resolved).toBe(
      'recorded_not_injected'
    );
  });
});
