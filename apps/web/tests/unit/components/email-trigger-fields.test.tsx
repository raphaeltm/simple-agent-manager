import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { EmailTriggerFields } from '../../../src/components/triggers/EmailTriggerFields';

function Harness() {
  const [allowedSenders, setAllowedSenders] = useState('');
  return (
    <EmailTriggerFields
      allowedSenders={allowedSenders}
      onAllowedSendersChange={setAllowedSenders}
    />
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

  it('announces a validation error with the field, and only while there is one', () => {
    const { rerender } = render(
      <EmailTriggerFields
        allowedSenders=""
        onAllowedSendersChange={() => undefined}
        error="Add at least one allowed sender."
      />
    );
    const field = screen.getByLabelText('Allowed senders');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Add at least one allowed sender\./);
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one allowed sender.');

    rerender(
      <EmailTriggerFields allowedSenders="a@example.com" onAllowedSendersChange={() => undefined} />
    );
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).toHaveAccessibleDescription(/One address per line/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is a plain textarea: nothing is dropped, filtered, or auto-lowercased client-side', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText('Allowed senders');
    await user.type(field, 'B@Example.com, c@example.com');
    expect(field).toHaveValue('B@Example.com, c@example.com');
  });
});
