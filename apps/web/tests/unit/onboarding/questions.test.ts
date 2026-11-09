import { describe, expect, it } from 'vitest';

import {
  openQuestions,
  presetAnswers,
  type SetupContext,
} from '../../../src/components/onboarding/choose-path/questions';

const none: SetupContext = {
  instantEnabled: false,
  platformCompute: false,
  artifactsEnabled: false,
  hasCloud: false,
  hasGitHub: false,
};

const choiceIds = (context: SetupContext, id: 'runtime' | 'repo') =>
  openQuestions(context)
    .find((q) => q.id === id)
    ?.choices.map((c) => c.id) ?? null;

describe('onboarding decision tree', () => {
  it('asks nothing on an installation with only one way to run and one place for code', () => {
    expect(openQuestions(none)).toEqual([]);
    expect(presetAnswers(none)).toEqual({ runtime: 'byoc', repo: 'github' });
  });

  it('offers Instant only where the installation runs it', () => {
    expect(choiceIds({ ...none, instantEnabled: true }, 'runtime')).toEqual(['instant', 'byoc']);
    expect(choiceIds(none, 'runtime')).toBeNull();
  });

  it("offers the installation's machines only where a platform cloud account exists", () => {
    expect(choiceIds({ ...none, platformCompute: true }, 'runtime')).toEqual(['platform', 'byoc']);
    expect(choiceIds({ ...none, instantEnabled: true, platformCompute: true }, 'runtime')).toEqual([
      'instant',
      'platform',
      'byoc',
    ]);
  });

  it('does not ask where agents run once the user connected their own cloud', () => {
    const context = { ...none, instantEnabled: true, platformCompute: true, hasCloud: true };
    expect(choiceIds(context, 'runtime')).toBeNull();
    expect(presetAnswers(context).runtime).toBe('byoc');
  });

  it('offers SAM-hosted repositories only where Artifacts is enabled', () => {
    expect(choiceIds({ ...none, artifactsEnabled: true }, 'repo')).toEqual(['hosted', 'github']);
    expect(choiceIds(none, 'repo')).toBeNull();
  });

  it('still asks where code lives when GitHub is connected but SAM can host it', () => {
    const question = openQuestions({ ...none, artifactsEnabled: true, hasGitHub: true }).find(
      (q) => q.id === 'repo'
    );
    expect(question?.choices.find((c) => c.id === 'github')?.label).toBe(
      'In my GitHub repositories'
    );
  });

  it('asks where agents work before where code lives', () => {
    const context = { ...none, instantEnabled: true, artifactsEnabled: true };
    expect(openQuestions(context).map((q) => q.id)).toEqual(['runtime', 'repo']);
  });

  it('gives every choice a label, a description and an icon', () => {
    const context = {
      ...none,
      instantEnabled: true,
      platformCompute: true,
      artifactsEnabled: true,
    };
    for (const question of openQuestions(context))
      for (const choice of question.choices) {
        expect(choice.label.trim()).not.toBe('');
        expect(choice.description.trim()).not.toBe('');
        expect(choice.icon).toBeTruthy();
      }
  });
});
