import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AcpConversationItemView } from '../../../src/components/project-message-view/AcpConversationItemView';
import { chatMessagesToConversationItems } from '../../../src/components/project-message-view/types';
import type { ChatMessageResponse } from '../../../src/lib/api';

/**
 * A reply sent from the inbox is an ordinary user message in the agent's chat. The server writes
 * `source: 'inbox_reply'`, the item's ref and its title into the delivery metadata (`sendChat`),
 * and the transcript shows a "Re:" chip that opens the item.
 */

function userRow(
  id: string,
  toolMetadata: Record<string, unknown> | null,
  role: ChatMessageResponse['role'] = 'user'
): ChatMessageResponse {
  return {
    id,
    sessionId: 'session-1',
    role,
    content: `Message ${id}`,
    toolMetadata,
    createdAt: 1000,
  };
}

const inboxReply = (extra: Record<string, unknown> = {}) => ({
  kind: 'durable_prompt_delivery',
  deliveryId: 'delivery-1',
  source: 'inbox_reply',
  userId: 'owner-1',
  inboxRef: 'ask:01Q',
  ...extra,
});

let location = '';
function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

function renderRows(rows: ChatMessageResponse[]) {
  const items = chatMessagesToConversationItems(rows);
  return render(
    <MemoryRouter initialEntries={['/projects/p1/chat/session-1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {items.map((item) => (
                <AcpConversationItemView
                  key={item.id}
                  item={item}
                  projectId="p1"
                  serverTextToSpeech={false}
                />
              ))}
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('inbox reply "Re:" chip', () => {
  it('names the item and opens it in the project inbox', () => {
    renderRows([userRow('r', inboxReply({ inboxTitle: 'Should the retry cap be per project?' }))]);
    // Liveness: the reply itself is an ordinary bubble.
    expect(screen.getByText('Message r')).toBeInTheDocument();
    const chip = screen.getByRole('link', { name: /Re: Should the retry cap be per project\?/ });
    fireEvent.click(chip);
    expect(location).toBe('/projects/p1/inbox?item=ask%3A01Q');
  });

  it('falls back when no title was recorded (replies sent before titles were)', () => {
    renderRows([userRow('r', inboxReply())]);
    expect(screen.getByTestId('inbox-reply-chip')).toHaveTextContent('Re: an inbox item');
  });

  it('shows no chip on ordinary follow-ups, agent rows, or an inbox reply without a ref', () => {
    renderRows([
      userRow('typed', { kind: 'durable_prompt_delivery', source: 'user_followup' }),
      userRow('noref', inboxReply({ inboxRef: '' })),
      userRow('agent', inboxReply(), 'assistant'),
    ]);
    expect(screen.getByText('Message typed')).toBeInTheDocument();
    expect(screen.getByText('Message noref')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-reply-chip')).toBeNull();
  });
});
