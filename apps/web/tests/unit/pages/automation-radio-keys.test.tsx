/**
 * The Automation page's chip rows and choice cards are radiogroups made of buttons, so they need
 * the WAI-ARIA radio keyboard model: one tab stop, arrows move the choice and focus.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChoiceCards } from '../../../src/pages/automation/fields';
import { Chips } from '../../../src/pages/automation/ui';

type Id = 'all' | 'scheduled' | 'reacting';

function ChipRow() {
  const [value, setValue] = useState<Id>('scheduled');
  return (
    <>
      <button type="button">Before</button>
      <Chips
        label="Show"
        value={value}
        onChange={setValue}
        options={[
          { id: 'all', label: 'All' },
          { id: 'scheduled', label: 'Scheduled' },
          { id: 'reacting', label: 'Reactions' },
        ]}
      />
    </>
  );
}

function Cards() {
  const [value, setValue] = useState<Id | null>(null);
  return (
    <ChoiceCards
      label="What should start it?"
      value={value}
      onChange={setValue}
      options={[
        { id: 'all', title: 'First' },
        { id: 'scheduled', title: 'Unavailable', disabled: true },
        { id: 'reacting', title: 'Third' },
      ]}
    />
  );
}

afterEach(cleanup);

describe('radio keyboard model', () => {
  it('makes the chip row one tab stop on the chosen chip, and arrows move the choice', async () => {
    const user = userEvent.setup();
    render(<ChipRow />);
    await user.click(screen.getByRole('button', { name: 'Before' }));
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Scheduled' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Reactions' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Reactions' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Reactions' })).toHaveFocus();
    expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  });

  it('skips disabled cards and starts on the first card when nothing is chosen', async () => {
    const user = userEvent.setup();
    render(<Cards />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'First' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Third' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Third' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Unavailable' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
});
