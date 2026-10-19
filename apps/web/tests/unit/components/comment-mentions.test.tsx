/**
 * @mentions of project members in session comments.
 *
 * Every test drives the real composer the way a person does — typing into the field,
 * choosing from the palette with the keyboard or the pointer, submitting the form — and
 * asserts what reaches `onSubmit`/`onReply`, which is exactly what the API call receives.
 */
import type { CommentMention, ProjectMembersResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getProjectMembers: vi.fn() }));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProjectMembers: mocks.getProjectMembers,
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' } }),
}));

// The mic is irrelevant here and would otherwise need MediaRecorder stubs.
vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => (
    <button type="button" aria-label="Start voice input">
      mic
    </button>
  ),
}));

import {
  filterMentionCandidates,
  findMentionSpans,
  retainedMentions,
  toMentionCandidates,
} from '../../../src/components/project-message-view/comments/comment-mentions';
import type { UiCommentThread } from '../../../src/components/project-message-view/comments/comment-utils';
import { CommentComposer } from '../../../src/components/project-message-view/comments/CommentComposer';
import {
  CommentThread,
  CommentThreadList,
} from '../../../src/components/project-message-view/comments/CommentThread';
import type { ProjectMemberSummary } from '../../../src/hooks/useProjectMembers';
import { renderWithQuery } from '../../test-utils/query-test-utils';

function member(
  userId: string,
  name: string | null,
  email: string,
  overrides: Partial<ProjectMembersResponse['members'][number]> = {}
): ProjectMembersResponse['members'][number] {
  return {
    projectId: 'proj-1',
    userId,
    role: 'maintainer',
    status: 'active',
    invitedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    user: { id: userId, name, email, image: null, avatarUrl: null },
    ...overrides,
  };
}

const MEMBERS: ProjectMembersResponse = {
  members: [
    member('user-ada', 'Ada Lovelace', 'ada@example.com'),
    member('user-grace', 'Grace Hopper', 'grace@example.com'),
    member('user-alan', 'Alan Turing', 'turing@example.com'),
    member('user-gone', 'Gonzo Removed', 'gonzo@example.com', { status: 'removed' }),
    member('user-zed', null, 'zed@example.com'),
  ],
  inviteLinks: [],
  accessRequests: [],
};

function renderComposer(props: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  const view = renderWithQuery(
    <CommentComposer
      mentionProjectId="proj-1"
      canSendToAgent
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />
  );
  const textarea = screen.getByLabelText(
    props.placeholder ?? 'Add a comment…'
  ) as HTMLTextAreaElement;
  return { ...view, onSubmit, onCancel, textarea };
}

/** Types `value` the way a user does: the caret ends up after the last character. */
function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

/** The palette's options by accessible name, without the email that follows the name. */
function optionNames(): string[] {
  const listbox = screen.queryByRole('listbox', { name: 'Mention a teammate' });
  if (!listbox) return [];
  return within(listbox)
    .getAllByRole('option')
    .map((option) => (option.getAttribute('aria-label') ?? '').split(', ')[0] ?? '');
}

describe('CommentComposer @mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectMembers.mockResolvedValue(MEMBERS);
  });

  it('opens a member palette on @ and filters by name, name word, or email prefix', async () => {
    const { textarea } = renderComposer();
    await waitFor(() => expect(mocks.getProjectMembers).toHaveBeenCalledWith('proj-1'));

    type(textarea, 'Thanks @');
    // Every ACTIVE member with a label, alphabetical; the removed member is never offered.
    await waitFor(() =>
      expect(optionNames()).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'zed'])
    );
    expect(textarea).toHaveAttribute('aria-expanded', 'true');

    type(textarea, 'Thanks @gr');
    expect(optionNames()).toEqual(['Grace Hopper']);

    type(textarea, 'Thanks @hop'); // a later word of the name
    expect(optionNames()).toEqual(['Grace Hopper']);

    type(textarea, 'Thanks @turing'); // the email's local part
    expect(optionNames()).toEqual(['Alan Turing']);

    type(textarea, 'Thanks @gonzo');
    expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();
    expect(textarea).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not open for an @ inside a word, such as an email address', async () => {
    const { textarea } = renderComposer();
    await waitFor(() => expect(mocks.getProjectMembers).toHaveBeenCalled());
    type(textarea, 'Write to ada@exa');
    // Liveness: the same field does open once an @ starts a word.
    expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();
    type(textarea, 'Write to ada@exa or @a');
    await waitFor(() => expect(optionNames()).toEqual(['Ada Lovelace', 'Alan Turing']));
  });

  it('picks with the keyboard, inserts @Display Name and submits the mention', async () => {
    const { textarea, onSubmit } = renderComposer();
    type(textarea, 'Hey @a');
    await waitFor(() => expect(optionNames()).toEqual(['Ada Lovelace', 'Alan Turing']));

    const [ada, alan] = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(textarea).toHaveAttribute('aria-activedescendant', ada?.id);
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea).toHaveAttribute('aria-activedescendant', alan?.id);
    expect(alan).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' }); // wraps
    expect(textarea).toHaveAttribute('aria-activedescendant', ada?.id);
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea.value).toBe('Hey @Alan Turing ');
    expect(textarea.selectionStart).toBe('Hey @Alan Turing '.length);
    expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();

    type(textarea, 'Hey @Alan Turing please check the migration');
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('Hey @Alan Turing please check the migration', 'note', [
        { userId: 'user-alan', displayName: 'Alan Turing' },
      ])
    );
  });

  it('picks with Tab or a click', async () => {
    const { textarea, onSubmit } = renderComposer();
    type(textarea, '@gr');
    await waitFor(() => expect(optionNames()).toEqual(['Grace Hopper']));
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('@Grace Hopper ');

    type(textarea, '@Grace Hopper and @ad');
    await waitFor(() => expect(optionNames()).toEqual(['Ada Lovelace']));
    fireEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));
    expect(textarea.value).toBe('@Grace Hopper and @Ada Lovelace ');

    fireEvent.submit(textarea.closest('form')!);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('@Grace Hopper and @Ada Lovelace', 'note', [
        { userId: 'user-grace', displayName: 'Grace Hopper' },
        { userId: 'user-ada', displayName: 'Ada Lovelace' },
      ])
    );
  });

  it('sends only picks whose text is still in the body; typed @names are plain text', async () => {
    const { textarea, onSubmit } = renderComposer();
    type(textarea, '@gr');
    await waitFor(() => expect(optionNames()).toEqual(['Grace Hopper']));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    type(textarea, '@Grace Hopper @ad');
    await waitFor(() => expect(optionNames()).toEqual(['Ada Lovelace']));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('@Grace Hopper @Ada Lovelace ');

    // Grace's name is deleted, and Alan is typed by hand rather than picked.
    type(textarea, '@Ada Lovelace and @Alan Turing, thoughts?');
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('@Ada Lovelace and @Alan Turing, thoughts?', 'note', [
        { userId: 'user-ada', displayName: 'Ada Lovelace' },
      ])
    );
  });

  it('Escape closes only the palette, without cancelling the composer or reaching window listeners', async () => {
    const onWindowKeyDown = vi.fn();
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      const { textarea, onCancel } = renderComposer();
      type(textarea, 'cc @g');
      await waitFor(() => expect(optionNames()).toEqual(['Grace Hopper']));

      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
      // A drawer's window-level Escape handler (useDialogFocusTrap) must not see it.
      expect(onWindowKeyDown).not.toHaveBeenCalled();

      // The dismissed token stays closed while it is typed...
      type(textarea, 'cc @gr');
      expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();
      // ...and a new @ opens the palette again.
      type(textarea, 'cc @gr and @a');
      await waitFor(() => expect(optionNames()).toEqual(['Ada Lovelace', 'Alan Turing']));

      // With the palette closed, Escape is the composer's own cancel again.
      fireEvent.keyDown(textarea, { key: 'Escape' });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onWindowKeyDown).toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
  });

  it('closes when the field loses focus and reopens when it gets it back', async () => {
    const { textarea } = renderComposer();
    type(textarea, 'cc @g');
    await waitFor(() => expect(optionNames()).toEqual(['Grace Hopper']));

    // The list floats over the page, so it must not linger once you tap elsewhere.
    fireEvent.blur(textarea);
    expect(screen.queryByRole('listbox', { name: 'Mention a teammate' })).toBeNull();
    expect(textarea).toHaveAttribute('aria-expanded', 'false');

    fireEvent.focus(textarea);
    expect(optionNames()).toEqual(['Grace Hopper']);
  });

  it('stays a plain field without a member list where mentions are unsupported', () => {
    const onSubmit = vi.fn();
    // No QueryClientProvider: a composer without mentions must not need one.
    render(<CommentComposer hideSendToAgent onSubmit={onSubmit} onCancel={vi.fn()} />);
    const textarea = screen.getByLabelText('Add a comment…');
    fireEvent.change(textarea, { target: { value: 'Note for @Ada' } });
    expect(textarea).not.toHaveAttribute('role', 'combobox');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(mocks.getProjectMembers).not.toHaveBeenCalled();
  });

  it('forwards picked mentions from a thread reply', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <CommentThreadList
        comments={[makeThread()]}
        mentionProjectId="proj-1"
        onReply={onReply}
        onResolve={vi.fn()}
        onReopen={vi.fn()}
        onSendToAgent={undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const reply = screen.getByLabelText('Reply…') as HTMLTextAreaElement;
    type(reply, '@gr');
    await waitFor(() => expect(optionNames()).toEqual(['Grace Hopper']));
    fireEvent.keyDown(reply, { key: 'Enter' });
    type(reply, '@Grace Hopper can you confirm?');
    fireEvent.submit(reply.closest('form')!);

    await waitFor(() =>
      expect(onReply).toHaveBeenCalledWith('thread-1', '@Grace Hopper can you confirm?', 'note', [
        { userId: 'user-grace', displayName: 'Grace Hopper' },
      ])
    );
  });
});

function makeThread(overrides: Partial<UiCommentThread> = {}): UiCommentThread {
  return {
    id: 'thread-1',
    clientId: null,
    projectId: 'proj-1',
    anchor: { quote: null },
    author: { id: 'user-grace', name: 'Grace Hopper', kind: 'human' },
    body: 'Body',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    syncState: 'synced',
    ...overrides,
  };
}

describe('CommentThread mention rendering', () => {
  it('highlights the structured mentions of the root comment and of each reply, as text', () => {
    renderWithQuery(
      <CommentThread
        comment={makeThread({
          body: '@Ada Lovelace can you look? cc @Grace and <b>@Ada Lovelacey</b>',
          mentions: [{ userId: 'user-ada', displayName: 'Ada Lovelace' }],
          replies: [
            {
              id: 'reply-1',
              author: { id: 'user-ada', name: 'Ada Lovelace', kind: 'human' },
              body: 'Looping in @Alan Turing.',
              createdAt: 2_000,
              mentions: [{ userId: 'user-alan', displayName: 'Alan Turing' }],
              syncState: 'synced',
            },
          ],
        })}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={vi.fn()}
      />
    );

    const highlighted = Array.from(document.querySelectorAll('[data-comment-mention]')).map(
      (node) => node.textContent
    );
    // `@Grace` was typed, not picked; `@Ada Lovelacey` is a different word.
    expect(highlighted).toEqual(['@Ada Lovelace', '@Alan Turing']);
    // Markup in a body stays text: no element is created from it.
    expect(document.querySelector('article b')).toBeNull();
    expect(
      screen.getByText((_, node) =>
        Boolean(
          node?.textContent?.startsWith('@Ada Lovelace can you look?') && node.tagName === 'P'
        )
      )
    ).toHaveTextContent('@Ada Lovelace can you look? cc @Grace and <b>@Ada Lovelacey</b>');
  });

  it('renders a comment without mentions unchanged', () => {
    renderWithQuery(
      <CommentThread
        comment={makeThread({ body: 'Plain @text only' })}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={vi.fn()}
      />
    );
    expect(document.querySelector('[data-comment-mention]')).toBeNull();
    expect(screen.getByText('Plain @text only')).toBeInTheDocument();
  });
});

describe('mention helpers', () => {
  const candidates = toMentionCandidates(
    MEMBERS.members.map((row): ProjectMemberSummary => ({
      userId: row.userId,
      name: row.user?.name ?? null,
      email: row.user?.email ?? null,
      avatarUrl: null,
      role: row.role,
      status: row.status,
    }))
  );

  it('offers active members only, labelled by name or email local part', () => {
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      'Ada Lovelace',
      'Alan Turing',
      'Grace Hopper',
      'zed',
    ]);
  });

  it('ranks whole-name prefix matches before word and email matches', () => {
    const extra = [
      ...candidates,
      { userId: 'user-tu', label: 'Tuesday Weld', email: 'weld@example.com', avatarUrl: null },
    ];
    expect(filterMentionCandidates(extra, 'tu').map((candidate) => candidate.label)).toEqual([
      'Tuesday Weld',
      'Alan Turing',
    ]);
  });

  it('finds standalone @label occurrences, preferring the longest label', () => {
    const text = '(@Ada) @Ada Lovelace, @Adam and x@Ada';
    expect(findMentionSpans(text, ['Ada', 'Ada Lovelace'])).toEqual([
      { start: 1, end: 5, label: 'Ada' },
      { start: 7, end: 20, label: 'Ada Lovelace' },
    ]);
  });

  it('keeps picks whose text survived, once per member', () => {
    const picked: CommentMention[] = [
      { userId: 'user-ada', displayName: 'Ada Lovelace' },
      { userId: 'user-ada', displayName: 'Ada Lovelace' },
      { userId: 'user-grace', displayName: 'Grace Hopper' },
    ];
    expect(retainedMentions('@Ada Lovelace twice: @Ada Lovelace', picked)).toEqual([
      { userId: 'user-ada', displayName: 'Ada Lovelace' },
    ]);
  });
});
