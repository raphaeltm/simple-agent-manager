import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AcpConversationItemView } from '../../../src/components/project-message-view/AcpConversationItemView';
import { userMessageAttribution } from '../../../src/components/project-message-view/message-attribution';
import { chatMessagesToConversationItems } from '../../../src/components/project-message-view/types';
import type { ChatMessageResponse } from '../../../src/lib/api';

/**
 * Who sent a user-role transcript row (gap G3). The server writes the sender into the durable
 * delivery's tool metadata; the transcript must not show a teammate's words as the owner's.
 */

function userRow(id: string, toolMetadata: Record<string, unknown> | null): ChatMessageResponse {
  return {
    id,
    sessionId: 'session-1',
    role: 'user',
    content: `Message ${id}`,
    toolMetadata,
    createdAt: 1000,
  };
}

const delivery = (metadata: Record<string, unknown>) => ({
  kind: 'durable_prompt_delivery',
  deliveryId: 'delivery-1',
  ...metadata,
});

function renderRows(rows: ChatMessageResponse[]) {
  const items = chatMessagesToConversationItems(rows);
  return render(
    <>
      {items.map((item) => (
        <AcpConversationItemView key={item.id} item={item} />
      ))}
    </>
  );
}

describe('user message attribution', () => {
  it('leaves the owner’s own prompts unlabelled', () => {
    renderRows([
      userRow('typed', null),
      userRow('durable', delivery({ source: 'user_followup', userId: 'owner-1' })),
    ]);

    expect(screen.getByText('Message typed')).toBeInTheDocument();
    expect(screen.getByText('Message durable')).toBeInTheDocument();
    expect(screen.queryByTestId('user-message-attribution')).toBeNull();
  });

  it('names a teammate who sent a prompt through shared access', () => {
    renderRows([
      userRow(
        'shared',
        delivery({
          source: 'user_followup',
          userId: 'grantee-1',
          senderName: 'Ana Ruiz',
          onBehalfOfUserId: 'owner-1',
          grantId: 'grant-1',
        })
      ),
    ]);

    expect(screen.getByTestId('user-message-attribution')).toHaveTextContent(
      'Ana Ruiz · shared access'
    );
    expect(screen.getByText('Message shared')).toBeInTheDocument();
  });

  it('names who sent a teammate’s comment to the agent', () => {
    renderRows([
      userRow(
        'comment',
        delivery({
          source: 'comment_directive',
          userId: 'owner-1',
          senderName: 'Prakash',
          author: { kind: 'human', id: 'reviewer-1', displayName: 'Ben Okafor' },
        })
      ),
    ]);

    expect(screen.getByTestId('user-message-attribution')).toHaveTextContent(
      "Prakash sent Ben Okafor's comment to the agent"
    );
  });

  it('marks a prompt cancelled because its sender lost access', () => {
    renderRows([
      userRow(
        'cancelled',
        delivery({
          source: 'user_followup',
          senderName: 'Ana Ruiz',
          onBehalfOfUserId: 'owner-1',
          deliveryCancelled: 'sender_access_revoked',
        })
      ),
    ]);

    expect(screen.getByText('Not delivered — access was removed')).toBeInTheDocument();
  });

  it('says a prompt was not delivered because its sender’s access ran out', () => {
    renderRows([
      userRow(
        'expired',
        delivery({
          source: 'user_followup',
          senderName: 'Ana Ruiz',
          onBehalfOfUserId: 'owner-1',
          deliveryCancelled: 'sender_access_expired',
        })
      ),
      userRow(
        'expired-comment',
        delivery({
          source: 'comment_directive',
          senderName: 'Ana Ruiz',
          deliveryCancelled: 'sender_access_expired',
        })
      ),
    ]);

    expect(screen.getAllByText('Not delivered — access expired')).toHaveLength(2);
    expect(screen.queryByText('Not delivered — access was removed')).toBeNull();
  });

  it('does not treat an unknown or inherited reason as a cancellation', () => {
    for (const reason of ['constructor', 'toString', 'sender_unauthorized']) {
      expect(
        userMessageAttribution({
          role: 'user',
          toolMetadata: delivery({
            source: 'user_followup',
            senderName: 'Ana Ruiz',
            onBehalfOfUserId: 'owner-1',
            deliveryCancelled: reason,
          }),
        })
      ).toEqual({ kind: 'shared_access', senderName: 'Ana Ruiz' });
    }
  });

  it('ignores metadata that is not a durable delivery, and non-user rows', () => {
    expect(
      userMessageAttribution({
        role: 'user',
        toolMetadata: { source: 'user_followup', onBehalfOfUserId: 'owner-1' },
      })
    ).toBeUndefined();
    expect(
      userMessageAttribution({
        role: 'assistant',
        toolMetadata: delivery({ source: 'user_followup', onBehalfOfUserId: 'owner-1' }),
      })
    ).toBeUndefined();
    // An unnamed sender still reads as someone else, never as the viewer.
    expect(
      userMessageAttribution({
        role: 'user',
        toolMetadata: delivery({ source: 'user_followup', onBehalfOfUserId: 'owner-1' }),
      })
    ).toEqual({ kind: 'shared_access', senderName: null });
  });
});
