/**
 * Which pull request the chat header points at.
 *
 * The behavioural tests in `tests/unit/components/chat/session-linked-work.test.tsx` cover the
 * cases a user meets; these cover the branches of the resolver itself, including the one no
 * fixture there reaches (a parseable number that is not in the link store).
 */
import type { LinkedPullRequest } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  pullRequestNumberFromUrl,
  resolvePrimaryPullRequest,
} from '../../../../src/components/project-message-view/useSessionLinkedWork';

const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;

function linked(overrides: Partial<LinkedPullRequest> & { number: number }): LinkedPullRequest {
  return {
    url: url(overrides.number),
    source: 'explicit_link',
    state: null,
    bySessionId: null,
    ...overrides,
  };
}

const OPEN_STATE = {
  state: 'open' as const,
  isDraft: false,
  title: 'A pull request',
  checksState: null,
  mergedAt: null,
  updatedAt: null,
  stale: false,
};

describe('pullRequestNumberFromUrl', () => {
  it('reads the number from a GitHub pull-request URL, with or without a trailing slash', () => {
    expect(pullRequestNumberFromUrl(url(2425))).toBe(2425);
    expect(pullRequestNumberFromUrl(`${url(7)}/`)).toBe(7);
  });

  it('returns null for anything it does not recognise, rather than guessing', () => {
    for (const value of [
      null,
      undefined,
      '',
      'https://github.com/owner/repo',
      // A GitLab merge request: a URL SAM links to but does not parse.
      'https://gitlab.com/owner/repo/-/merge_requests/7',
      // The shape in older fixtures and some hand-written task rows.
      'https://github.com/test/pr/1',
      url(0),
      'https://github.com/owner/repo/pull/-3',
      `https://github.com/owner/repo/pull/${Number.MAX_SAFE_INTEGER}0`,
    ]) {
      expect(pullRequestNumberFromUrl(value)).toBeNull();
    }
  });
});

describe('resolvePrimaryPullRequest', () => {
  it('prefers the linked row for the task output URL, so the state comes with it', () => {
    const resolved = resolvePrimaryPullRequest(url(2425), [
      linked({ number: 1 }),
      linked({ number: 2425, source: 'pr_association', state: OPEN_STATE }),
    ]);
    expect(resolved).toEqual({ url: url(2425), number: 2425, state: OPEN_STATE });
  });

  it('matches on the number, not on the source label', () => {
    // The server collapses duplicates to whichever source it saw first, so the surviving row
    // for the task's own pull request is not reliably labelled `task_output`.
    const resolved = resolvePrimaryPullRequest(url(9), [
      linked({ number: 9, source: 'explicit_link', state: OPEN_STATE }),
    ]);
    expect(resolved?.state).toBe(OPEN_STATE);
  });

  it('still links a parseable pull request the link store does not know', () => {
    // An older task, or a URL outside the project repository the server refuses to canonicalise.
    expect(resolvePrimaryPullRequest(url(42), [linked({ number: 7 })])).toEqual({
      url: url(42),
      number: 42,
      state: null,
    });
  });

  it('still links a URL it cannot parse, with no invented number', () => {
    const gitlab = 'https://gitlab.com/owner/repo/-/merge_requests/7';
    expect(resolvePrimaryPullRequest(gitlab, [])).toEqual({
      url: gitlab,
      number: null,
      state: null,
    });
  });

  it('falls back to the first linked pull request when the task records none', () => {
    const resolved = resolvePrimaryPullRequest(null, [
      linked({ number: 3, state: OPEN_STATE }),
      linked({ number: 4 }),
    ]);
    expect(resolved).toEqual({ url: url(3), number: 3, state: OPEN_STATE });
  });

  it('resolves to nothing when there is no URL and nothing linked', () => {
    expect(resolvePrimaryPullRequest(null, [])).toBeNull();
    expect(resolvePrimaryPullRequest(undefined, [])).toBeNull();
    expect(resolvePrimaryPullRequest('', [])).toBeNull();
  });
});
