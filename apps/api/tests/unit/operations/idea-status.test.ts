/**
 * Every precedence rule in `deriveIdeaStatus`, as a table.
 *
 * The cases are named after what a person would see, because that is what the rules are for.
 * Two of them exist specifically to fail if a rule is deleted rather than merely reordered:
 * the weak-link case (a chat that only read the idea must not move it) and the
 * merge-already-answered case (the question is asked once, not on every page load).
 */
import type { IdeaPullRequest } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  deriveIdeaStatus,
  type IdeaStatusInput,
  type IdeaStatusLinkedSession,
  isLinkedWorkActive,
} from '../../../src/operations/idea-status';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

function session(overrides: Partial<IdeaStatusLinkedSession> = {}): IdeaStatusLinkedSession {
  return {
    sessionId: 'sess-1',
    topic: 'Retry failed webhook deliveries',
    relations: ['works_on'],
    strong: true,
    sessionStatus: 'stopped',
    taskId: 'task-1',
    taskStatus: 'completed',
    taskErrorMessage: null,
    agentLabel: 'Opus 5.5',
    lastActivityAt: minutesAgo(10),
    needsInput: null,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<IdeaPullRequest> = {}): IdeaPullRequest {
  return {
    url: 'https://github.com/acme/payments/pull/482',
    number: 482,
    state: 'open',
    isDraft: false,
    title: 'Retry failed webhook deliveries',
    checksState: 'success',
    mergedAt: null,
    updatedAt: '2026-10-23T11:58:00.000Z',
    stale: false,
    ...overrides,
  };
}

function input(overrides: Partial<IdeaStatusInput> = {}): IdeaStatusInput {
  return {
    ideaStatus: 'draft',
    ideaUpdatedAt: '2026-10-20T09:00:00.000Z',
    sessions: [],
    pullRequests: [],
    ...overrides,
  };
}

describe('deriveIdeaStatus precedence', () => {
  it('a completed idea is done, whatever its work says', () => {
    const result = deriveIdeaStatus(
      input({
        ideaStatus: 'completed',
        sessions: [session({ taskStatus: 'in_progress', sessionStatus: 'active' })],
        pullRequests: [pullRequest()],
      })
    );
    expect(result.state).toBe('done');
    expect(result.needsYou).toBeNull();
    expect(result.source.origin).toBe('person');
  });

  it('a cancelled idea is parked', () => {
    expect(deriveIdeaStatus(input({ ideaStatus: 'cancelled' })).state).toBe('parked');
  });

  it('an unanswered question outranks running work', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({ sessionId: 'running', taskStatus: 'in_progress' }),
          session({
            sessionId: 'asking',
            taskStatus: 'in_progress',
            needsInput: { question: 'Should retries stop at 3 days?', askedAt: minutesAgo(2) },
          }),
        ],
        pullRequests: [pullRequest()],
      })
    );
    expect(result.state).toBe('question');
    expect(result.needsYou).toBe('question');
    expect(result.session?.sessionId).toBe('asking');
    expect(result.note).toBe('Should retries stop at 3 days?');
    expect(result.source.origin).toBe('agent');
  });

  it('the newest question wins, because that is the one on screen', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({
            sessionId: 'older',
            needsInput: { question: 'older question', askedAt: minutesAgo(30) },
          }),
          session({
            sessionId: 'newer',
            needsInput: { question: 'newer question', askedAt: minutesAgo(1) },
          }),
        ],
      })
    );
    expect(result.session?.sessionId).toBe('newer');
  });

  it('the latest work failing with nothing active is stuck, and carries the reason', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({ sessionId: 'old', taskStatus: 'completed', lastActivityAt: minutesAgo(90) }),
          session({
            sessionId: 'failed',
            taskStatus: 'failed',
            taskErrorMessage: 'pnpm test failed: 3 suites red',
            lastActivityAt: minutesAgo(5),
          }),
        ],
      })
    );
    expect(result.state).toBe('stuck');
    expect(result.needsYou).toBe('stuck');
    expect(result.session?.sessionId).toBe('failed');
    expect(result.note).toBe('pnpm test failed: 3 suites red');
  });

  it('a failure behind running work is in progress, not stuck', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({
            sessionId: 'failed',
            taskStatus: 'failed',
            lastActivityAt: minutesAgo(40),
          }),
          session({
            sessionId: 'retry',
            taskStatus: 'in_progress',
            lastActivityAt: minutesAgo(1),
          }),
        ],
      })
    );
    expect(result.state).toBe('working');
    expect(result.session?.sessionId).toBe('retry');
  });

  it('a cancelled chat is not stuck — it was stopped on purpose', () => {
    const result = deriveIdeaStatus(input({ sessions: [session({ taskStatus: 'cancelled' })] }));
    expect(result.state).toBe('not-started');
  });

  it('running work is in progress and names who is working', () => {
    const result = deriveIdeaStatus(
      input({ sessions: [session({ taskStatus: 'in_progress', agentLabel: 'Opus 5.5' })] })
    );
    expect(result.state).toBe('working');
    expect(result.session?.agentLabel).toBe('Opus 5.5');
    expect(result.source.origin).toBe('chat');
  });

  it('a sleeping chat still counts as in progress: it has not finished', () => {
    expect(deriveIdeaStatus(input({ sessions: [session({ taskStatus: 'sleeping' })] })).state).toBe(
      'working'
    );
  });

  it('a task-less chat that is still open counts as in progress', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [session({ taskId: null, taskStatus: null, sessionStatus: 'active' })],
      })
    );
    expect(result.state).toBe('working');
  });

  it('an open pull request with nothing running is in review, from GitHub', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [session({ taskStatus: 'completed' })],
        pullRequests: [pullRequest()],
      })
    );
    expect(result.state).toBe('review');
    expect(result.needsYou).toBeNull();
    expect(result.pullRequest?.number).toBe(482);
    expect(result.source.origin).toBe('github');
    expect(result.source.observedAt).toBe('2026-10-23T11:58:00.000Z');
  });

  it('running work outranks an open pull request', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [session({ taskStatus: 'in_progress' })],
        pullRequests: [pullRequest()],
      })
    );
    expect(result.state).toBe('working');
  });

  it('a ready pull request is shown rather than a draft one', () => {
    const result = deriveIdeaStatus(
      input({
        pullRequests: [
          pullRequest({ number: 1, isDraft: true, url: 'https://x/pull/1' }),
          pullRequest({ number: 2, isDraft: false, url: 'https://x/pull/2' }),
        ],
      })
    );
    expect(result.pullRequest?.number).toBe(2);
  });

  it('a merged pull request asks whether the idea is done', () => {
    const result = deriveIdeaStatus(
      input({
        pullRequests: [pullRequest({ state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' })],
      })
    );
    expect(result.state).toBe('merged');
    expect(result.needsYou).toBe('merged');
    expect(result.source.observedAt).toBe('2026-10-23T08:00:00.000Z');
  });

  it('an open pull request outranks a merged one', () => {
    const result = deriveIdeaStatus(
      input({
        pullRequests: [
          pullRequest({ number: 1, state: 'merged', mergedAt: '2026-10-22T08:00:00.000Z' }),
          pullRequest({ number: 2, state: 'open', url: 'https://x/pull/2' }),
        ],
      })
    );
    expect(result.state).toBe('review');
    expect(result.pullRequest?.number).toBe(2);
  });

  it('the newest merge is the one that asks', () => {
    const result = deriveIdeaStatus(
      input({
        pullRequests: [
          pullRequest({ number: 1, state: 'merged', mergedAt: '2026-10-20T08:00:00.000Z' }),
          pullRequest({
            number: 9,
            state: 'merged',
            mergedAt: '2026-10-23T08:00:00.000Z',
            url: 'https://x/pull/9',
          }),
        ],
      })
    );
    expect(result.pullRequest?.number).toBe(9);
  });

  it('an idea with nothing linked has not started, and says so has no source', () => {
    const result = deriveIdeaStatus(input());
    expect(result.state).toBe('not-started');
    expect(result.source.origin).toBe('none');
    expect(result.needsYou).toBeNull();
  });

  it('a closed-unmerged pull request does not claim review or merged', () => {
    const result = deriveIdeaStatus(
      input({ pullRequests: [pullRequest({ state: 'closed', checksState: null })] })
    );
    expect(result.state).toBe('not-started');
  });

  it('carries a stale flag through, so the page can say the state may be out of date', () => {
    const result = deriveIdeaStatus(input({ pullRequests: [pullRequest({ stale: true })] }));
    expect(result.source.stale).toBe(true);
  });

  it('truncates a very long failure message rather than shipping the whole log', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [session({ taskStatus: 'failed', taskErrorMessage: 'x'.repeat(5_000) })],
      })
    );
    expect(result.note).toHaveLength(280);
    expect(result.note?.endsWith('…')).toBe(true);
  });
});

describe('weak links never move an idea', () => {
  // The program's strength rules: a chat that only read, viewed or discussed an idea has a
  // weak link to it. Deleting the `strong` filter in `deriveIdeaStatus` makes every one of
  // these go red, which is the point.
  it('a weakly linked running chat does not make the idea in progress', () => {
    const result = deriveIdeaStatus(
      input({ sessions: [session({ relations: ['read'], strong: false, taskStatus: 'in_progress' })] })
    );
    expect(result.state).toBe('not-started');
  });

  it('a weakly linked question does not make the idea wait for you', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({
            relations: ['discusses'],
            strong: false,
            needsInput: { question: 'unrelated question', askedAt: minutesAgo(1) },
          }),
        ],
      })
    );
    expect(result.state).toBe('not-started');
    expect(result.note).toBeNull();
  });

  it('a weakly linked failure does not make the idea stuck', () => {
    const result = deriveIdeaStatus(
      input({ sessions: [session({ relations: ['read'], strong: false, taskStatus: 'failed' })] })
    );
    expect(result.state).toBe('not-started');
  });

  it('a strong link beside a weak one still decides', () => {
    const result = deriveIdeaStatus(
      input({
        sessions: [
          session({ sessionId: 'weak', strong: false, taskStatus: 'failed' }),
          session({ sessionId: 'strong', strong: true, taskStatus: 'in_progress' }),
        ],
      })
    );
    expect(result.state).toBe('working');
    expect(result.session?.sessionId).toBe('strong');
  });
});

describe('the merged question is asked once', () => {
  const merged = pullRequest({ state: 'merged', mergedAt: '2026-10-23T08:00:00.000Z' });

  it('asks when nobody has answered', () => {
    expect(deriveIdeaStatus(input({ pullRequests: [merged] })).state).toBe('merged');
  });

  it('stops asking once a person chose "Keep open"', () => {
    const result = deriveIdeaStatus(
      input({ pullRequests: [merged], mergeAcknowledgedAt: '2026-10-23T09:00:00.000Z' })
    );
    expect(result.state).toBe('not-started');
    expect(result.needsYou).toBeNull();
  });

  it('asks again when a newer pull request merges after that answer', () => {
    const result = deriveIdeaStatus(
      input({
        mergeAcknowledgedAt: '2026-10-23T09:00:00.000Z',
        pullRequests: [
          merged,
          pullRequest({
            number: 500,
            state: 'merged',
            mergedAt: '2026-10-23T10:00:00.000Z',
            url: 'https://x/pull/500',
          }),
        ],
      })
    );
    expect(result.state).toBe('merged');
    expect(result.pullRequest?.number).toBe(500);
  });

  it('asks when the merge has no timestamp: an unknown answer is not an answer', () => {
    const result = deriveIdeaStatus(
      input({
        mergeAcknowledgedAt: '2026-10-23T09:00:00.000Z',
        pullRequests: [pullRequest({ state: 'merged', mergedAt: null })],
      })
    );
    expect(result.state).toBe('merged');
  });
});

describe('isLinkedWorkActive', () => {
  it.each([
    ['queued', true],
    ['delegated', true],
    ['in_progress', true],
    ['sleeping', true],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
    ['draft', false],
  ])('a %s task counts as active: %s', (taskStatus, expected) => {
    expect(isLinkedWorkActive(session({ taskStatus }))).toBe(expected);
  });

  it('falls back to the chat session for a chat with no task', () => {
    expect(
      isLinkedWorkActive(session({ taskId: null, taskStatus: null, sessionStatus: 'active' }))
    ).toBe(true);
    expect(
      isLinkedWorkActive(session({ taskId: null, taskStatus: null, sessionStatus: 'stopped' }))
    ).toBe(false);
  });
});
