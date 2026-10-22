import { describe, expect, it } from 'vitest';

import {
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
