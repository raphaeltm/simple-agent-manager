import { describe, expect, it } from 'vitest';

import {
  type GeneratedStep,
  generatePath,
  getTimeEstimate,
} from '../../../src/components/onboarding/choose-path/path-generator';

describe('generatePath', () => {
  // Helper to extract step IDs
  const ids = (steps: GeneratedStep[]) => steps.map((s) => s.id);

  // ── AI step branching ──
  // Each case is (label, input tags, expected step ids). Parametrized so the
  // branch matrix reads as a table rather than eight near-identical blocks.
  it.each([
    ['claude-pro + hetzner + repo', ['oauth', 'has-claude', 'byoc', 'has-repo'], ['ai-oauth', 'cloud-hetzner', 'github', 'project']],
    ['claude-pro + no-cloud + no-repo', ['oauth', 'has-claude', 'sam-infra', 'no-repo'], ['ai-oauth', 'cloud-sam', 'github', 'project']],
    ['api-key + anthropic + hetzner + repo', ['has-api-key', 'user-api-key', 'has-claude', 'anthropic-key', 'has-hetzner', 'byoc', 'has-repo'], ['ai-apikey', 'cloud-hetzner', 'github', 'project']],
    ['api-key + openai + no-cloud + repo', ['has-api-key', 'user-api-key', 'has-openai', 'openai-key', 'no-cloud', 'sam-infra', 'has-repo'], ['ai-apikey', 'cloud-sam', 'github', 'project']],
    ['sam-billing + no-cloud + no-repo', ['no-ai', 'sam-billing', 'no-cloud', 'sam-infra', 'no-repo'], ['ai-sam', 'cloud-sam', 'github', 'project']],
    ['sam-billing + hetzner + repo', ['no-ai', 'sam-billing', 'has-hetzner', 'byoc', 'has-repo'], ['ai-sam', 'cloud-hetzner', 'github', 'project']],
    ['api-key + openai + hetzner + no-repo', ['has-api-key', 'user-api-key', 'has-openai', 'openai-key', 'has-hetzner', 'byoc', 'no-repo'], ['ai-apikey', 'cloud-hetzner', 'github', 'project']],
    ['api-key + anthropic + no-cloud + no-repo', ['has-api-key', 'user-api-key', 'has-claude', 'anthropic-key', 'no-cloud', 'sam-infra', 'no-repo'], ['ai-apikey', 'cloud-sam', 'github', 'project']],
  ])('%s → %j', (_label, tags, expected) => {
    expect(ids(generatePath(tags))).toEqual(expected);
  });

  // ── Edge cases: no AI step produced ──

  it('empty tags → no AI step, only [cloud-sam, github, project]', () => {
    const steps = generatePath([]);
    expect(ids(steps)).toEqual(['cloud-sam', 'github', 'project']);
  });

  it('oauth without has-claude → no AI step produced', () => {
    const steps = generatePath(['oauth', 'byoc', 'has-repo']);
    expect(ids(steps)).not.toContain('ai-oauth');
    expect(ids(steps)).not.toContain('ai-apikey');
    expect(ids(steps)).not.toContain('ai-sam');
  });

  it('has-claude without oauth → no AI-oauth step (falls through to no AI step)', () => {
    const steps = generatePath(['has-claude', 'byoc', 'has-repo']);
    expect(ids(steps)).not.toContain('ai-oauth');
  });

  // ── isOptional behavior ──

  it('existing-agent tag marks AI step as isOptional', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo', 'existing-agent']);
    const aiStep = steps.find((s) => s.id === 'ai-oauth');
    expect(aiStep?.isOptional).toBe(true);
  });

  it('existing-agent tag marks ai-sam step as isOptional', () => {
    const steps = generatePath(['no-ai', 'sam-billing', 'sam-infra', 'no-repo', 'existing-agent']);
    const aiStep = steps.find((s) => s.id === 'ai-sam');
    expect(aiStep?.isOptional).toBe(true);
  });

  it('ai-sam step is NOT optional without existing-agent tag', () => {
    const steps = generatePath(['no-ai', 'sam-billing', 'sam-infra', 'no-repo']);
    const aiStep = steps.find((s) => s.id === 'ai-sam');
    expect(aiStep?.isOptional).toBe(false);
  });

  it('existing-agent tag marks ai-apikey step as isOptional', () => {
    const steps = generatePath(['user-api-key', 'has-claude', 'byoc', 'has-repo', 'existing-agent']);
    const aiStep = steps.find((s) => s.id === 'ai-apikey');
    expect(aiStep?.isOptional).toBe(true);
  });

  it('existing-cloud tag marks cloud-hetzner step as isOptional', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo', 'existing-cloud']);
    const cloudStep = steps.find((s) => s.id === 'cloud-hetzner');
    expect(cloudStep?.isOptional).toBe(true);
  });

  it('existing-github tag marks github step as isOptional', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo', 'existing-github']);
    const ghStep = steps.find((s) => s.id === 'github');
    expect(ghStep?.isOptional).toBe(true);
  });

  it('cloud-sam step is optional only when existing-cloud tag is present', () => {
    const stepsNew = generatePath(['sam-billing', 'sam-infra', 'has-repo']);
    expect(stepsNew.find((s) => s.id === 'cloud-sam')?.isOptional).toBe(false);

    const stepsExisting = generatePath(['sam-billing', 'sam-infra', 'has-repo', 'existing-cloud']);
    expect(stepsExisting.find((s) => s.id === 'cloud-sam')?.isOptional).toBe(true);
  });

  it('project step is never isOptional', () => {
    const stepsRepo = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo']);
    const stepsTemplate = generatePath(['oauth', 'has-claude', 'sam-infra', 'no-repo']);
    expect(stepsRepo.find((s) => s.id === 'project')?.isOptional).toBe(false);
    expect(stepsTemplate.find((s) => s.id === 'project')?.isOptional).toBe(false);
  });

  // ── Project step variant ──

  it('has-repo produces project step with "Choose Repository" actionLabel', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo']);
    const proj = steps.find((s) => s.id === 'project');
    expect(proj?.actionLabel).toBe('Choose Repository');
  });

  it('no-repo produces project step with "Choose Repository" actionLabel', () => {
    const steps = generatePath(['oauth', 'has-claude', 'sam-infra', 'no-repo']);
    const proj = steps.find((s) => s.id === 'project');
    expect(proj?.actionLabel).toBe('Choose Repository');
  });

  // ── Always has exactly one project step ──

  it('always includes exactly one project step', () => {
    const tags = [
      ['oauth', 'has-claude', 'byoc', 'has-repo'],
      ['sam-billing', 'sam-infra', 'no-repo'],
      ['user-api-key', 'byoc', 'has-repo'],
      [],
    ];
    for (const t of tags) {
      const steps = generatePath(t);
      const projectSteps = steps.filter((s) => s.id === 'project');
      expect(projectSteps).toHaveLength(1);
    }
  });
});

describe('getTimeEstimate', () => {
  it('returns "< 1 min" for zero-duration steps', () => {
    const steps = generatePath(['sam-billing', 'sam-infra', 'no-repo']);
    // cloud-sam is "Instant" (no countable time), but ai-sam=30s, github=30s,
    // project=30s → 90s → 2 mins. Only cloud-sam contributes nothing.
    const estimate = getTimeEstimate(steps);
    expect(estimate).toMatch(/~\d+ min/);
  });

  it('returns singular "min" for exactly 1 minute', () => {
    // Construct a step set that totals exactly 60s
    const fakeSteps = [{ timeEstimate: '1 minute' }] as any[];
    expect(getTimeEstimate(fakeSteps)).toBe('~1 min');
  });

  it('returns plural "mins" for more than 1 minute', () => {
    const fakeSteps = [
      { timeEstimate: '1 minute' },
      { timeEstimate: '30 seconds' },
    ] as any[];
    expect(getTimeEstimate(fakeSteps)).toBe('~2 mins');
  });

  it('handles "0 seconds" without NaN', () => {
    const fakeSteps = [{ timeEstimate: '0 seconds' }] as any[];
    const result = getTimeEstimate(fakeSteps);
    expect(result).toBe('< 1 min');
  });

  it('excludes optional steps from the time estimate', () => {
    const fakeSteps = [
      { timeEstimate: '30 seconds', isOptional: true },
      { timeEstimate: '1 minute', isOptional: false },
    ] as any[];
    // Only the non-optional step counts: 60s → 1 min
    expect(getTimeEstimate(fakeSteps)).toBe('~1 min');
  });

  it('returns < 1 min when all steps are optional', () => {
    const fakeSteps = [
      { timeEstimate: '30 seconds', isOptional: true },
      { timeEstimate: '1 minute', isOptional: true },
    ] as any[];
    expect(getTimeEstimate(fakeSteps)).toBe('< 1 min');
  });
});
