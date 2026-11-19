import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: vi.fn().mockResolvedValue({ members: [] }),
}));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-rae', name: 'Rae Reader', email: 'rae@example.com' } }),
}));

import { toInboxItem } from '../../../src/components/project-message-view/comments/comment-inbox';
import type { UiMessageCommentThread } from '../../../src/components/project-message-view/comments/comment-utils';
import { buildCommentedMessageDescriber } from '../../../src/components/project-message-view/comments/commented-message-label';
import { CommentInboxRow } from '../../../src/components/project-message-view/comments/CommentInboxRow';
import {
  type CommentActions,
  DesktopCommentRail,
  MessageCommentActionRow,
} from '../../../src/components/project-message-view/comments/MessageCommentPanels';
import type { DisplayItem } from '../../../src/components/project-message-view/tool-call-groups';
import { renderWithQuery } from '../../test-utils/query-test-utils';

// Production message ids are UUIDs: nothing a person can use, so no surface may show one.
const AGENT_ID = '3f9a2e71-8b77-4ae0-9c3e-0d1f2a3b4c5d';
const OWNER_ID = '6b1c4d2e-1111-4a2b-8c3d-9e8f7a6b5c4d';
const TEAMMATE_ID = 'a0b1c2d3-2222-4e5f-8a9b-0c1d2e3f4a5b';
const UNLOADED_ID = 'ffffffff-3333-4bbb-8ccc-dddddddddddd';
const MINUTE = 60_000;

function items(now: number): DisplayItem[] {
  return [
    { kind: 'user_message', id: OWNER_ID, text: 'Plan it', timestamp: now - 3 * 60 * MINUTE },
    {
      kind: 'agent_message',
      id: AGENT_ID,
      text: 'Here is the plan',
      streaming: false,
      timestamp: now - 5 * MINUTE,
    },
    {
      kind: 'user_message',
      id: TEAMMATE_ID,
      text: 'Add a test',
      timestamp: now - 2 * MINUTE,
      attribution: { kind: 'shared_access', senderName: 'Grace Grantee' },
    },
  ];
}

function thread(messageId: string, quote: string | null = null): UiMessageCommentThread {
  return {
    id: `thread-${messageId}`,
    clientId: null,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    anchor: { kind: 'message', messageId, quote },
    author: { id: 'user-rae', name: 'Rae Reader', email: null, avatarUrl: null, kind: 'human' },
    body: 'This misses the rollback step.',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
  };
}

const ACTIONS: CommentActions = {
  mentionProjectId: 'proj-1',
  createThread: vi.fn(),
  reply: vi.fn(),
  resolve: vi.fn(),
  reopen: vi.fn(),
};

afterEach(() => {
  cleanup();
});

describe('naming the message a comment is on', () => {
  it('says whose message it is, from the viewer’s point of view', () => {
    const now = Date.now();
    const asOwner = buildCommentedMessageDescriber(items(now), {
      ownerName: 'Olivia Owner',
      viewerIsOwner: true,
    });
    const asReader = buildCommentedMessageDescriber(items(now), {
      ownerName: 'Olivia Owner',
      viewerIsOwner: false,
    });

    expect(asOwner(AGENT_ID)).toEqual({
      title: "The agent's reply",
      phrase: "the agent's reply",
      when: '5m ago',
      loaded: true,
    });
    expect(asOwner(OWNER_ID)).toMatchObject({ title: 'Your message', when: '3h ago' });
    // Someone else reading the chat never sees the owner's message called theirs.
    expect(asReader(OWNER_ID)).toMatchObject({ title: "Olivia Owner's message" });
    // A teammate's prompt is theirs for everyone, owner included.
    expect(asOwner(TEAMMATE_ID)).toMatchObject({ title: "Grace Grantee's message" });
    expect(asReader(TEAMMATE_ID)).toMatchObject({ title: "Grace Grantee's message" });
  });

  it('does not guess who wrote a message that is not loaded yet', () => {
    const describe = buildCommentedMessageDescriber(items(Date.now()), {
      ownerName: 'Olivia Owner',
      viewerIsOwner: true,
    });

    expect(describe(UNLOADED_ID)).toEqual({
      title: 'Earlier message',
      phrase: 'an earlier message',
      when: null,
      loaded: false,
    });
  });

  it('names a teammate whose name is unknown without inventing one', () => {
    const now = Date.now();
    const describe = buildCommentedMessageDescriber(
      [
        {
          kind: 'user_message',
          id: TEAMMATE_ID,
          text: 'Hi',
          timestamp: now,
          attribution: { kind: 'comment', senderName: null },
        },
      ],
      { ownerName: 'Olivia Owner', viewerIsOwner: true }
    );

    expect(describe(TEAMMATE_ID).title).toBe("A teammate's message");
  });
});

describe('comment surfaces show the description, never the message id', () => {
  it('labels each thread in the desktop rail by its message', () => {
    const describeMessage = buildCommentedMessageDescriber(items(Date.now()), {
      ownerName: 'Olivia Owner',
      viewerIsOwner: false,
    });
    renderWithQuery(
      <DesktopCommentRail
        comments={[thread(AGENT_ID), thread(UNLOADED_ID)]}
        draft={{ anchorId: TEAMMATE_ID }}
        loading={false}
        refreshing={false}
        error={null}
        activeMessageId={null}
        focusedCommentId={null}
        actions={ACTIONS}
        onRetry={() => undefined}
        onClearDraft={() => undefined}
        onSelectMessage={() => undefined}
        onClose={() => undefined}
        describeMessage={describeMessage}
      />
    );
    const rail = screen.getByRole('complementary', { name: 'Session comments' });

    expect(
      within(rail).getByRole('button', {
        name: "Show the agent's reply, 5m ago, in the conversation",
      })
    ).toHaveTextContent("The agent's reply · 5m ago");
    expect(
      within(rail).getByRole('button', { name: 'Show an earlier message in the conversation' })
    ).toHaveTextContent('Earlier message');
    // The open draft names the message being commented on.
    expect(within(rail).getByRole('heading', { level: 3 })).toHaveTextContent(
      "New comment on message Grace Grantee's message · 2m ago"
    );

    const named = [rail, ...within(rail).getAllByRole('button')]
      .map((node) => `${node.textContent} ${node.getAttribute('aria-label') ?? ''}`)
      .join(' ');
    for (const id of [AGENT_ID, UNLOADED_ID, TEAMMATE_ID]) expect(named).not.toContain(id);
  });

  it('gives each message’s Comment button a name without the id', () => {
    renderWithQuery(
      <MessageCommentActionRow
        comments={[]}
        expanded={false}
        canComment
        onToggle={() => undefined}
        onStartComment={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: 'Comment on this message' })).toBeVisible();
  });

  it('says whose message a thread without a quote is on in the comments list', () => {
    const item = toInboxItem(thread(OWNER_ID), {
      kind: 'session',
      sessionId: 'sess-1',
      sessionTopic: 'Plan',
      messageId: OWNER_ID,
      messageDescription: "Olivia Owner's message",
    });
    const unloaded = toInboxItem(thread(UNLOADED_ID), {
      kind: 'session',
      sessionId: 'sess-1',
      sessionTopic: 'Plan',
      messageId: UNLOADED_ID,
      messageDescription: null,
    });

    renderWithQuery(
      <>
        <CommentInboxRow item={item} viewerId="user-rae" onSelect={() => undefined} />
        <CommentInboxRow item={unloaded} viewerId="user-rae" onSelect={() => undefined} />
      </>
    );

    expect(screen.getByText("on Olivia Owner's message")).toBeInTheDocument();
    expect(screen.getByText('on a message')).toBeInTheDocument();
    expect(screen.queryByText('on your message')).toBeNull();
  });
});
