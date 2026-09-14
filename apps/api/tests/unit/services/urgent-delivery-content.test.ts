import { describe, expect, it } from 'vitest';

import { composeUrgentDeliveryContent } from '../../../src/services/urgent-delivery-content';

describe('composeUrgentDeliveryContent', () => {
  it('carries the class, sender identity, stop context, and the raw directive', () => {
    const content = composeUrgentDeliveryContent({
      messageClass: 'interrupt',
      message: 'pause the staging deploy',
      senderTaskId: 'task-42',
    });

    expect(content).toContain('[Urgent agent message — class: interrupt]');
    expect(content).toContain('from task task-42');
    expect(content).toContain('stops any in-flight turn');
    expect(content).toContain('review the transcript above');
    expect(content).toContain('Directive:\npause the staging deploy');
  });

  it('works without a sender task identity', () => {
    const content = composeUrgentDeliveryContent({
      messageClass: 'preempt_and_replan',
      message: 'replan',
      senderTaskId: null,
    });

    expect(content).toContain('[Urgent agent message — class: preempt_and_replan]');
    expect(content).not.toContain('from task');
    expect(content).toContain('Directive:\nreplan');
  });

  it('labels every urgent class it can be called with', () => {
    for (const messageClass of [
      'interrupt',
      'preempt_and_replan',
      'shutdown_with_final_prompt',
    ] as const) {
      const content = composeUrgentDeliveryContent({ messageClass, message: 'x' });
      expect(content).toContain(`class: ${messageClass}`);
    }
  });
});
