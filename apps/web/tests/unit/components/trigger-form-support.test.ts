import { describe, expect, it } from 'vitest';

import { buildGitHubFilters } from '../../../src/components/triggers/trigger-form-support';

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
});
