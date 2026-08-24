import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commentsForMessage,
  createOptimisticId,
  summarizeComments,
  threadStatusForAction,
  upsertThread,
} from '../../../src/components/project-message-view/comments/comment-utils';
import { CommentComposer } from '../../../src/components/project-message-view/comments/CommentComposer';
import { CommentThreadList } from '../../../src/components/project-message-view/comments/CommentThread';
import type { MessageCommentAuthor, MessageCommentThread } from '../../../src/lib/api/comments';

const author: MessageCommentAuthor = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
  kind: 'human',
};

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    id: overrides.id ?? 'comment-1',
    clientId: overrides.clientId ?? null,
    projectId: overrides.projectId ?? 'proj-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    anchor: overrides.anchor ?? {
      kind: 'message',
      messageId: 'msg-1',
      quote: 'Quoted text from a message.',
    },
    author: overrides.author ?? author,
    body: overrides.body ?? 'Original comment body.',
    createdAt: overrides.createdAt ?? Date.now() - 60_000,
    updatedAt: overrides.updatedAt ?? Date.now() - 60_000,
    status: overrides.status ?? 'open',
    replies: overrides.replies ?? [],
  };
}

describe('message comment utilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters and summarizes message-scoped threads', () => {
    const comments = [
      { ...makeThread({ id: 'c1', status: 'open' }) },
      { ...makeThread({ id: 'c2', status: 'resolved' }) },
      { ...makeThread({ id: 'c3', anchor: { kind: 'message', messageId: 'msg-2' } }) },
    ].map((thread) => ({ ...thread, replies: [] }));

    const messageComments = commentsForMessage(comments, 'msg-1');

    expect(messageComments.map((comment) => comment.id)).toEqual(['c1', 'c2']);
    expect(summarizeComments(messageComments)).toEqual({ count: 2, unresolvedCount: 1 });
  });

  it('reconciles optimistic threads by client id', () => {
    const optimistic = makeThread({
      id: 'optimistic:thread:1',
      clientId: 'client-thread-1',
      body: 'Optimistic body',
    });
    const server = makeThread({
      id: 'server-comment-1',
      clientId: 'client-thread-1',
      body: 'Server body',
    });

    const merged = upsertThread([{ ...optimistic, replies: [], syncState: 'pending' }], server);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'server-comment-1',
      body: 'Server body',
      syncState: 'synced',
    });
  });

  it('maps composer actions to visible thread status', () => {
    expect(threadStatusForAction('note')).toBe('open');
    expect(threadStatusForAction('send_to_agent')).toBe('sent');
  });

  it('uses Web Crypto values for optimistic ids when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn((values: Uint32Array) => {
      values.set([1, 35, 1295, 46655]);
      return values;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    const id = createOptimisticId('thread');

    expect(id).toMatch(/^optimistic:thread:[0-9a-z]+$/);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});

/**
 * Minimal MediaRecorder stand-in so the composer's real VoiceButton can be
 * driven end-to-end: click -> record -> stop -> POST -> transcribed text.
 */
class StubMediaRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  static isTypeSupported = () => true;

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

describe('CommentComposer', () => {
  beforeEach(() => {
    const track = { stop: vi.fn(), kind: 'audio', enabled: true };
    const stream = { getTracks: () => [track] };
    vi.stubGlobal('MediaRecorder', StubMediaRecorder);
    vi.stubGlobal('AudioContext', undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      writable: true,
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'Dictated words.' }) })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits trimmed bodies with the explicit send-to-agent action and keeps focus accessible', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(<CommentComposer quote="Quoted text" onSubmit={onSubmit} onCancel={onCancel} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    expect(screen.getByText('Quoted text')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '  Ask the agent to verify this.  ' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Send to agent' }));
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('Ask the agent to verify this.', 'send_to_agent');
    });
  });

  it('dictates into the body, appending after existing text, and submits it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Typed first.' } });

    // Drive the real mic control the way a user does, rather than calling the
    // transcription handler directly.
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => {
      expect(textarea.value).toBe('Typed first. Dictated words.');
    });

    // Submission stays gated until the mic reports idle, so wait for the gate to
    // lift rather than submitting into it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).not.toBeDisabled();
    });
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('Typed first. Dictated words.', 'note');
    });
  });

  it('does not insert a double space when the body already ends in one', async () => {
    render(<CommentComposer onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Trailing space ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => screen.getByRole('button', { name: 'Stop recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => {
      expect(textarea.value).toBe('Trailing space Dictated words.');
    });
  });

  it('holds submission until dictation finishes so speech is never dropped', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Typed.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => screen.getByRole('button', { name: 'Stop recording' }));

    // Submitting unmounts this composer, which would post the comment without
    // the words still being recorded — and without telling the user.
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent.submit(textarea.closest('form')!);
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await waitFor(() => {
      expect(textarea.value).toBe('Typed. Dictated words.');
    });

    // Once dictation lands and the mic reports idle, the full text submits.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).not.toBeDisabled();
    });
    fireEvent.submit(textarea.closest('form')!);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('Typed. Dictated words.', 'note');
    });
  });

  it('keeps typed text and recovers the mic when transcription fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' })
    );

    render(<CommentComposer onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Typed and kept.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => screen.getByRole('button', { name: 'Stop recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Transcription failed/i })).toBeTruthy();
    });

    // The failure must not eat the user's typing, strand the border tint, or
    // leave submission permanently blocked. The submit gate clears one render
    // after the mic reports 'error', so wait for it rather than sampling.
    expect(textarea.value).toBe('Typed and kept.');
    expect(textarea.style.borderColor).toBe('');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).not.toBeDisabled();
    });
  });

  it('ignores the mic while a submit is in flight', async () => {
    let release: () => void = () => {};
    const onSubmit = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (release = () => resolve())));

    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'In flight.' } });
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start voice input' })).toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start voice input' })).not.toBeDisabled();
    });
  });

  it('tints the composer border only while recording', async () => {
    render(<CommentComposer onSubmit={vi.fn()} onCancel={vi.fn()} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    expect(textarea.style.borderColor).toBe('');
    // The mic overlay sits on the native resize grip, so resizing is disabled.
    expect(textarea.style.resize).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));

    await waitFor(() => {
      expect(textarea.style.borderColor).toBe('var(--sam-color-danger)');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => {
      expect(textarea.style.borderColor).toBe('');
    });
  });

  it('supports keyboard submit and Escape cancel', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(<CommentComposer onSubmit={onSubmit} onCancel={onCancel} />);

    const textarea = screen.getByLabelText('Add a comment…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Keyboard body' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('Keyboard body', 'note');
    });

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('CommentThreadList', () => {
  it('handles reply, send-to-agent, and resolve actions', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onReopen = vi.fn().mockResolvedValue(undefined);
    const onSendToAgent = vi.fn().mockResolvedValue(undefined);

    render(
      <CommentThreadList
        comments={[{ ...makeThread(), replies: [] }]}
        onReply={onReply}
        onResolve={onResolve}
        onReopen={onReopen}
        onSendToAgent={onSendToAgent}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect(onSendToAgent).toHaveBeenCalledWith('comment-1');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const replyForm = screen.getByLabelText('Reply…').closest('form')!;
    fireEvent.change(within(replyForm).getByLabelText('Reply…'), {
      target: { value: 'Reply that should reach the agent.' },
    });
    fireEvent.click(within(replyForm).getByRole('radio', { name: 'Send to agent' }));
    fireEvent.submit(replyForm);

    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith(
        'comment-1',
        'Reply that should reach the agent.',
        'send_to_agent'
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith('comment-1');
  });

  it('represents resolved threads without hiding them and allows reopening', () => {
    const onReopen = vi.fn();

    render(
      <CommentThreadList
        comments={[{ ...makeThread({ status: 'resolved' }), replies: [] }]}
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={onReopen}
        onSendToAgent={vi.fn()}
      />
    );

    expect(screen.getByText('Resolved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show resolved thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(onReopen).toHaveBeenCalledWith('comment-1');
  });
});
