import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { EmailTriggerFields } from '../../../src/components/triggers/EmailTriggerFields';

function Harness() {
  const [allowedSenders, setAllowedSenders] = useState('');
  return (
    <EmailTriggerFields allowedSenders={allowedSenders} onAllowedSendersChange={setAllowedSenders} />
  );
}

describe('EmailTriggerFields', () => {
  it('accepts multiple addresses, one per line', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText('Allowed senders');
    await user.type(field, 'a@example.com{enter}b@example.com');
    expect(field).toHaveValue('a@example.com\nb@example.com');
  });

  it('is a plain textarea: nothing is dropped, filtered, or auto-lowercased client-side', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText('Allowed senders');
    await user.type(field, 'B@Example.com, c@example.com');
    expect(field).toHaveValue('B@Example.com, c@example.com');
  });
});
