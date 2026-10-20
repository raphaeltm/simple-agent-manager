import { describe, expect, it } from 'vitest';

import { preservesNoMerge, projectPageChecks } from '../playwright/staging-sam-behavior-checks';

describe('staging project page claim checks', () => {
  it.each([
    'You have two projects on this page:',
    'You have 2 accessible projects on this page:',
    'This first page contains two projects; more projects remain.',
    'Here is a partial list of projects.',
  ])('accepts an explicitly bounded page: %s', (output) => {
    expect(projectPageChecks(output)).toEqual({
      disclosesPartialPage: true,
      noFalseTotal: true,
    });
  });
  it.each([
    'You have two projects.',
    'You have 2 accessible projects.',
    'You have only two projects.',
    'There are a total of two projects.',
    'There are 2 projects in total.',
    'There are two projects overall.',
    'On this page are two entries. You have two projects.',
    'You have two projects on this page; only two projects exist.',
  ])('rejects an unqualified total even alongside page wording: %s', (output) => {
    expect(projectPageChecks(output).noFalseTotal).toBe(false);
  });
  it('does not treat a bare count as pagination disclosure', () => {
    expect(projectPageChecks('Here are two projects.').disclosesPartialPage).toBe(false);
  });
});

describe('staging no-merge constraint check', () => {
  it.each([
    'Use a draft PR and do not merge.',
    "Don't merge the PR.",
    'Don’t merge the PR.',
    'You must not merge the changes.',
    'Never merge this draft.',
    'No merging is authorized.',
    'The draft PR must not be merged.',
    'This PR should never be merged.',
    'The PR must not\nbe merged.',
    'Any proposed code changes must be submitted via a draft PR and must not be merged.',
  ])('accepts explicit active or passive prohibition: %s', (output) => {
    expect(preservesNoMerge(output)).toBe(true);
  });

  it.each([
    'Submit a draft PR.',
    'The PR must be merged.',
    'Merge the PR after reviewing it.',
    'Do not delete the branch; merge the PR.',
    'The changes must not be reviewed before merging.',
    'No decision about merging has been made.',
    'The PR is mergeable.',
    'It must not be mergeable.',
  ])('rejects absent prohibition or negation of another action: %s', (output) => {
    expect(preservesNoMerge(output)).toBe(false);
  });
});
