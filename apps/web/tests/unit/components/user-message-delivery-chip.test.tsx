import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { userMessageDelivery } from '../../../src/components/project-message-view/message-attribution';
import { UserMessageDeliveryChip } from '../../../src/components/project-message-view/UserMessageDeliveryChip';

/** The chip a steer's transcript row renders, from the metadata the server writes. */
function chipFor(toolMetadata: Record<string, unknown>) {
  const delivery = userMessageDelivery({ role: 'user', toolMetadata });
  if (!delivery) return null;
  render(<UserMessageDeliveryChip delivery={delivery} />);
  return screen.getByTestId('user-message-delivery');
}

const steer = { kind: 'durable_prompt_delivery', deliveryIntent: 'steer' };

describe('steer delivery chip', () => {
  it.each([
    [{}, 'Steering…'],
    [{ steerOutcome: 'steered' }, 'Added to current turn'],
    [
      { steerOutcome: 'queued_fallback', steerReason: 'no_running_turn' },
      'Sent as next message · turn had ended',
    ],
    [
      { steerOutcome: 'queued_fallback', steerReason: 'session_not_awake' },
      'Sent as next message · agent was asleep',
    ],
    [
      { steerOutcome: 'queued_fallback', steerReason: 'runtime_steering_unsupported' },
      "Sent as next message · agent can't steer",
    ],
    [{ steerOutcome: 'queued_fallback', steerReason: 'something_new' }, 'Sent as next message'],
    [{ steerOutcome: 'unconfirmed' }, 'Delivery unconfirmed'],
    [{ steerOutcome: 'failed' }, 'Not delivered'],
  ])('%o reads "%s"', (outcome, label) => {
    const chip = chipFor({ ...steer, ...outcome });
    expect(chip).toHaveTextContent(label);
  });

  it('never labels an ordinary queued message or an agent row', () => {
    expect(
      userMessageDelivery({
        role: 'user',
        toolMetadata: { kind: 'durable_prompt_delivery', steerOutcome: 'failed' },
      })
    ).toBeUndefined();
    expect(userMessageDelivery({ role: 'assistant', toolMetadata: steer })).toBeUndefined();
  });
});
