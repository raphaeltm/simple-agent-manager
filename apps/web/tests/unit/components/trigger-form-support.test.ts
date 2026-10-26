import { describe, expect, it } from 'vitest';

import {
  buildGitHubConfigForForm,
  buildGitHubFilters,
  joinEmailList,
  looksLikeEmail,
  splitEmailList,
} from '../../../src/components/triggers/trigger-form-support';

const BASE_INPUT = {
  actions: 'opened',
  labels: '',
  ignoreActors: 'dependabot[bot]',
  commandPrefix: '/sam',
  bodyContains: '',
  branches: '',
  ignoreDrafts: true,
};

describe('buildGitHubFilters', () => {
  it('omits commandPrefix for non-comment GitHub events', () => {
    expect(
      buildGitHubFilters({
        ...BASE_INPUT,
        eventType: 'issues',
      })
    ).toEqual({
      actions: ['opened'],
      ignoreActors: ['dependabot[bot]'],
    });
  });

  it('preserves commandPrefix for issue_comment events', () => {
    expect(
      buildGitHubFilters({
        ...BASE_INPUT,
        eventType: 'issue_comment',
        commandPrefix: '  /sam  ',
      })
    ).toEqual({
      actions: ['opened'],
      ignoreActors: ['dependabot[bot]'],
      commandPrefix: '/sam',
    });
  });
  it('drops hidden filters for push and preserves explicit false draft preference', () => {
    expect(
      buildGitHubFilters({
        ...BASE_INPUT,
        eventType: 'push',
        labels: 'bug',
        bodyContains: 'critical',
        commandPrefix: '/sam',
        branches: 'main',
      })
    ).toEqual({ ignoreActors: ['dependabot[bot]'], branches: ['main'] });
    expect(
      buildGitHubFilters({ ...BASE_INPUT, eventType: 'pull_request', ignoreDrafts: false })
    ).toEqual({ actions: ['opened'], ignoreActors: ['dependabot[bot]'], ignoreDrafts: false });
  });
});

describe('email sender list helpers', () => {
  it('splits one-per-line and comma-separated lists the same way, trimmed and non-empty-filtered', () => {
    expect(splitEmailList('a@x.test\nb@x.test')).toEqual(['a@x.test', 'b@x.test']);
    expect(splitEmailList(' a@x.test , b@x.test ')).toEqual(['a@x.test', 'b@x.test']);
    expect(splitEmailList('a@x.test,\n\nb@x.test')).toEqual(['a@x.test', 'b@x.test']);
    expect(splitEmailList('   ')).toBeUndefined();
    expect(splitEmailList('')).toBeUndefined();
  });

  it('round-trips through joinEmailList as one address per line', () => {
    expect(joinEmailList(['a@x.test', 'b@x.test'])).toBe('a@x.test\nb@x.test');
    expect(joinEmailList(undefined)).toBe('');
    expect(splitEmailList(joinEmailList(['a@x.test', 'b@x.test']))).toEqual([
      'a@x.test',
      'b@x.test',
    ]);
  });

  it('checks the client-side email shape without claiming full RFC validation', () => {
    expect(looksLikeEmail('a@x.test')).toBe(true);
    expect(looksLikeEmail('not-an-email')).toBe(false);
    expect(looksLikeEmail('missing-domain@')).toBe(false);
    expect(looksLikeEmail('a b@x.test')).toBe(false);
  });
});

describe('new structured filter scopes', () => {
  const input = {
    eventType: 'pull_request_review' as const,
    actions: 'submitted',
    labels: 'bug',
    ignoreActors: '',
    commandPrefix: '/sam',
    bodyContains: '',
    branches: '',
    ignoreDrafts: true,
    actors: 'alice',
    addedLabel: 'sam',
    authorAssociation: 'MEMBER',
    ignoreBots: true,
    commentContains: 'fix',
    isPullRequest: 'true',
    reviewStates: 'changes_requested',
  };
  it('serializes review filters and omits hidden changed-label settings', () => {
    expect(buildGitHubFilters(input)).toMatchObject({
      actors: ['alice'],
      authorAssociation: ['MEMBER'],
      ignoreBots: true,
      commentContains: 'fix',
      reviewStates: ['changes_requested'],
      commandPrefix: '/sam',
    });
    expect(buildGitHubFilters(input)).not.toHaveProperty('addedLabel');
    expect(buildGitHubFilters(input)).not.toHaveProperty('isPullRequest');
  });
  it('normalizes fixed choices and limits subject selection to issue comments', () => {
    expect(
      buildGitHubFilters({ ...input, authorAssociation: 'member, owner', reviewStates: 'APPROVED' })
    ).toMatchObject({ authorAssociation: ['MEMBER', 'OWNER'], reviewStates: ['approved'] });
    expect(
      buildGitHubFilters({ ...input, eventType: 'issue_comment', isPullRequest: 'false' })
    ).toMatchObject({ isPullRequest: false });
  });
  it('omits scoped filters for push, preserving sender restrictions', () => {
    const filters = buildGitHubFilters({ ...input, eventType: 'push' });
    expect(filters).toEqual({ actors: ['alice'], ignoreBots: true });
  });
  it('preserves untouched original filters and clears scoped ones when changing event', () => {
    const original = {
      eventType: 'pull_request_review' as const,
      filters: buildGitHubFilters(input),
    };
    expect(
      buildGitHubConfigForForm({ ...input, addedLabel: '', isPullRequest: '' }, original)
    ).toBeUndefined();
    expect(
      buildGitHubConfigForForm({ ...input, eventType: 'push', actions: '' }, original)?.filters
    ).toEqual({ actors: ['alice'], ignoreBots: true });
  });
});
