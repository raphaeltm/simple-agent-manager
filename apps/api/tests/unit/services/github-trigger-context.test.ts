import { describe, expect, it } from 'vitest';

import { buildGitHubContext } from '../../../src/services/github-trigger-context';
import { parseWebhookPayload } from '../../../src/services/github-trigger-filter';

describe('stable GitHub trigger context', () => {
  const context = (event: string, payload: Record<string, unknown>) =>
    buildGitHubContext(
      parseWebhookPayload(event, payload),
      { id: 't', name: 'T', description: null, triggerCount: 0 },
      { id: 'p', name: 'P' },
      'e',
      1
    ).github;
  it('preserves exact comment identity and PR subject metadata', () => {
    expect(
      context('issue_comment', {
        issue: {
          number: 42,
          title: 'T',
          html_url: 'https://github.com/o/r/issues/42',
          pull_request: { html_url: 'https://github.com/o/r/pull/42' },
        },
        comment: {
          id: 123,
          html_url: 'https://github.com/o/r/pull/42#issuecomment-123',
          body: 'untrusted',
          author_association: 'MEMBER',
        },
      })
    ).toMatchObject({
      number: '42',
      commentId: '123',
      commentUrl: 'https://github.com/o/r/pull/42#issuecomment-123',
      isPullRequest: 'true',
      url: 'https://github.com/o/r/pull/42',
      authorAssociation: 'MEMBER',
      comment: 'untrusted',
    });
  });
  it('submitted review and inline burst share PR number and retain their own identities', () => {
    const pull_request = { number: 42, title: 'PR', html_url: 'https://github.com/o/r/pull/42' };
    expect(
      context('pull_request_review', {
        pull_request,
        review: { id: 9, body: 'fix', state: 'changes_requested', html_url: 'review-url' },
      })
    ).toMatchObject({
      number: '42',
      commentId: '9',
      comment: 'fix',
      reviewState: 'changes_requested',
      commentUrl: 'review-url',
      isPullRequest: 'true',
    });
    expect(
      context('pull_request_review_comment', {
        pull_request,
        comment: { id: 10, body: 'line fix', path: 'src/a.ts', line: 7 },
      })
    ).toMatchObject({
      number: '42',
      commentId: '10',
      path: 'src/a.ts',
      line: '7',
      reviewState: '',
      isPullRequest: 'true',
    });
    expect(
      context('pull_request_review_comment', {
        pull_request,
        comment: { original_line: 4, line: null },
      })
    ).toMatchObject({ line: '4' });
  });
  it('does not report subject URLs as comment URLs outside comment events', () => {
    expect(
      context('issues', { issue: { number: 1, title: 'Issue', html_url: 'issue-url' } })
    ).toMatchObject({ url: 'issue-url', commentId: '', commentUrl: '' });
  });
  it('malformed metadata cannot throw or create false association', () => {
    expect(
      context('issue_comment', {
        issue: { pull_request: null },
        comment: { id: '123', user: null, author_association: null },
      })
    ).toMatchObject({ commentId: '', isPullRequest: 'false', authorAssociation: '' });
  });
});
