/**
 * The whole reason expansion state lives in the PARENT is virtualization:
 * Virtuoso unmounts rows outside its overscan window, so a card that owned its
 * own `useState` would silently collapse when the user scrolled away and back.
 *
 * These tests reproduce that unmount/remount the way the list does it — by
 * dropping the card subtree and putting it back — with the REAL hook (rule 62),
 * not a hand-held boolean.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ToolCallGroupItem } from '../../../src/components/project-message-view/tool-call-groups';
import { ToolCallGroupCard } from '../../../src/components/project-message-view/ToolCallGroupCard';
import {
  isToolCallGroupExpanded,
  useToolCallGroupExpansion,
} from '../../../src/components/project-message-view/useToolCallGroupExpansion';

const GROUP: ToolCallGroupItem = {
  kind: 'tool_call_group',
  id: 'tool-1',
  timestamp: 1_000,
  items: [
    {
      kind: 'tool_call',
      id: 'tool-1',
      toolCallId: 'tc-1',
      title: 'Bash: pnpm lint',
      status: 'completed',
      content: [],
      locations: [],
      timestamp: 1_000,
    },
  ],
};

/**
 * Stands in for the virtualized list: the parent owns the expansion state and
 * the row can be unmounted and remounted underneath it.
 *
 * `controlled: false` renders the same card WITHOUT the parent's state, which is
 * the control — it must lose its expansion across the remount, proving the
 * surviving case is the hook's doing and not something the card does by itself.
 */
function Harness({ controlled }: { controlled: boolean }) {
  const expansion = useToolCallGroupExpansion();
  const [mounted, setMounted] = useState(true);

  return (
    <div>
      <button type="button" onClick={() => setMounted((prev) => !prev)}>
        {mounted ? 'unmount row' : 'remount row'}
      </button>
      {mounted &&
        (controlled ? (
          <ToolCallGroupCard
            group={GROUP}
            expanded={isToolCallGroupExpanded(expansion, GROUP.id)}
            onToggle={expansion.toggleGroup}
          />
        ) : (
          <ToolCallGroupCard group={GROUP} />
        ))}
    </div>
  );
}

function renderHarness(controlled: boolean, initialUrl = '/') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Harness controlled={controlled} />
    </MemoryRouter>
  );
}

async function cycleRow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'unmount row' }));
  expect(screen.queryByRole('button', { name: /1 tool call/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'remount row' }));
}

describe('useToolCallGroupExpansion', () => {
  it('keeps a group expanded across an unmount and remount of its row', async () => {
    const user = userEvent.setup();
    renderHarness(true);

    await user.click(screen.getByRole('button', { name: /1 tool call/ }));
    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Bash: pnpm lint')).toBeTruthy();

    await cycleRow(user);

    // Scrolled away and back: still open, and its calls are still listed.
    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Bash: pnpm lint')).toBeTruthy();
  });

  it('collapses on remount when the card owns its own state (the control)', async () => {
    const user = userEvent.setup();
    renderHarness(false);

    await user.click(screen.getByRole('button', { name: /1 tool call/ }));
    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await cycleRow(user);

    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('seeds every group expanded from ?tools=expanded and stays collapsible', async () => {
    const user = userEvent.setup();
    renderHarness(true, '/projects/p/chat/s?tools=expanded');

    const header = screen.getByRole('button', { name: /1 tool call/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');

    // The seeded state records deviations, so collapsing must still work...
    await user.click(header);
    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    // ...and that deviation must itself survive the row being recycled.
    await cycleRow(user);
    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
