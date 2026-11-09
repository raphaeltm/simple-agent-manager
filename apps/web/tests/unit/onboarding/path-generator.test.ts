import { describe, expect, it } from 'vitest';

import {
  type ExistingSetup,
  generatePath,
} from '../../../src/components/onboarding/choose-path/path-generator';

const fresh: ExistingSetup = {
  hasAgent: false,
  hasCloud: false,
  hasGitHub: false,
  hasProject: false,
};
const ids = (...args: Parameters<typeof generatePath>) => generatePath(...args).map((s) => s.id);

describe('generatePath', () => {
  it.each([
    ['Instant + SAM-hosted', { runtime: 'instant', repo: 'hosted' }, ['agent', 'project']],
    ['Instant + GitHub', { runtime: 'instant', repo: 'github' }, ['agent', 'github', 'project']],
    ['platform + GitHub', { runtime: 'platform', repo: 'github' }, ['agent', 'github', 'project']],
    ['own cloud + SAM-hosted', { runtime: 'byoc', repo: 'hosted' }, ['agent', 'cloud', 'project']],
    [
      'own cloud + GitHub',
      { runtime: 'byoc', repo: 'github' },
      ['agent', 'cloud', 'github', 'project'],
    ],
  ] as const)('%s → %j', (_label, answers, expected) => {
    expect(ids(answers, fresh)).toEqual(expected);
  });

  it('leaves out every step the user already covered', () => {
    expect(
      ids(
        { runtime: 'byoc', repo: 'github' },
        { hasAgent: true, hasCloud: true, hasGitHub: true, hasProject: false }
      )
    ).toEqual(['project']);
    expect(
      ids(
        { runtime: 'byoc', repo: 'github' },
        { hasAgent: true, hasCloud: true, hasGitHub: true, hasProject: true }
      )
    ).toEqual([]);
  });

  it('never asks for a cloud account when agents run on Instant or platform machines', () => {
    expect(ids({ runtime: 'instant', repo: 'hosted' }, fresh)).not.toContain('cloud');
    expect(ids({ runtime: 'platform', repo: 'hosted' }, fresh)).not.toContain('cloud');
  });

  it('gives every step a rail label and SAM line', () => {
    for (const step of generatePath({ runtime: 'byoc', repo: 'github' }, fresh)) {
      expect(step.label.trim()).not.toBe('');
      expect(step.title.trim()).not.toBe('');
      expect(step.description.trim()).not.toBe('');
    }
  });
});
