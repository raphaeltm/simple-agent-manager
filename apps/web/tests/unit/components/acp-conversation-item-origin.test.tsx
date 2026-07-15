import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AcpConversationItemView } from '../../../src/components/project-message-view/AcpConversationItemView';

function userItem(
  overrides: Partial<Extract<ConversationItem, { kind: 'user_message' }>>
): ConversationItem {
  return { kind: 'user_message', id: 'm1', text: 'hello', timestamp: 0, ...overrides };
}

describe('AcpConversationItemView — user message origin', () => {
  it('collapses an origin="system" injected message behind a disclosure', () => {
    const { container } = render(
      <AcpConversationItemView
        item={userItem({ origin: 'system', text: 'call get_instructions' })}
      />
    );
    const details = container.querySelector('details.sam-injected-message');
    expect(details).not.toBeNull();
    // Collapsed by default (no `open` attribute).
    expect((details as HTMLDetailsElement).open).toBe(false);
    // The disclosure label is shown; the injected text lives inside <details>.
    expect(screen.getByText('Show system context')).toBeInTheDocument();
    expect(screen.getByText('call get_instructions')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Show system context'));
    expect((details as HTMLDetailsElement).open).toBe(true);
  });

  it('keeps user text visible alongside collapsed injected context', () => {
    const { container } = render(
      <>
        <AcpConversationItemView item={userItem({ id: 'user', text: 'my exact task' })} />
        <AcpConversationItemView
          item={userItem({ id: 'system', origin: 'system', text: 'long injected context' })}
        />
      </>
    );
    expect(screen.getByText('my exact task')).toBeVisible();
    expect(container.querySelector('details.sam-injected-message')).not.toHaveAttribute('open');
  });

  it('renders a normal (origin="user") message as a standard bubble, not collapsed', () => {
    const { container } = render(
      <AcpConversationItemView item={userItem({ origin: 'user', text: 'my task' })} />
    );
    expect(container.querySelector('details.sam-injected-message')).toBeNull();
    expect(screen.getByText('my task')).toBeInTheDocument();
  });

  it('treats a missing origin as a normal message', () => {
    const { container } = render(<AcpConversationItemView item={userItem({ text: 'plain' })} />);
    expect(container.querySelector('details.sam-injected-message')).toBeNull();
    expect(screen.getByText('plain')).toBeInTheDocument();
  });
});
