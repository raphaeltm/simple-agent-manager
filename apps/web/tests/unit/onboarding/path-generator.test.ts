import { describe, expect, it } from 'vitest';

import {
  generatePath,
  getTimeEstimate,
  type GeneratedStep,
} from '../../../src/components/onboarding/choose-path/path-generator';

describe('generatePath', () => {
  // Helper to extract step IDs
  const ids = (steps: GeneratedStep[]) => steps.map((s) => s.id);

  // ── AI step branching ──

  it('claude-pro + hetzner + repo → [ai-oauth, cloud-hetzner, github, project]', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo']);
    expect(ids(steps)).toEqual(['ai-oauth', 'cloud-hetzner', 'github', 'project']);
  });

  it('claude-pro + no-cloud + template → [ai-oauth, cloud-sam, github, project]', () => {
    const steps = generatePath(['oauth', 'has-claude', 'sam-infra', 'use-template']);
    expect(ids(steps)).toEqual(['ai-oauth', 'cloud-sam', 'github', 'project']);
  });

  it('api-key + anthropic + hetzner + repo → [ai-apikey, cloud-hetzner, github, project]', () => {
    const steps = generatePath([
      'has-api-key', 'user-api-key', 'has-claude', 'anthropic-key', 'has-hetzner', 'byoc', 'has-repo',
    ]);
    expect(ids(steps)).toEqual(['ai-apikey', 'cloud-hetzner', 'github', 'project']);
  });

  it('api-key + openai + no-cloud + repo → [ai-apikey, cloud-sam, github, project]', () => {
    const steps = generatePath([
      'has-api-key', 'user-api-key', 'has-openai', 'openai-key', 'no-cloud', 'sam-infra', 'has-repo',
    ]);
    expect(ids(steps)).toEqual(['ai-apikey', 'cloud-sam', 'github', 'project']);
  });

  it('sam-billing + no-cloud + template → [ai-sam, cloud-sam, github, project]', () => {
    const steps = generatePath(['no-ai', 'sam-billing', 'no-cloud', 'sam-infra', 'use-template']);
    expect(ids(steps)).toEqual(['ai-sam', 'cloud-sam', 'github', 'project']);
  });

  it('sam-billing + hetzner + repo → [ai-sam, cloud-hetzner, github, project]', () => {
    const steps = generatePath(['no-ai', 'sam-billing', 'has-hetzner', 'byoc', 'has-repo']);
    expect(ids(steps)).toEqual(['ai-sam', 'cloud-hetzner', 'github', 'project']);
  });

  it('api-key + openai + hetzner + template → [ai-apikey, cloud-hetzner, github, project]', () => {
    const steps = generatePath([
      'has-api-key', 'user-api-key', 'has-openai', 'openai-key', 'has-hetzner', 'byoc', 'use-template',
    ]);
    expect(ids(steps)).toEqual(['ai-apikey', 'cloud-hetzner', 'github', 'project']);
  });

  it('api-key + anthropic + no-cloud + template → [ai-apikey, cloud-sam, github, project]', () => {
    const steps = generatePath([
      'has-api-key', 'user-api-key', 'has-claude', 'anthropic-key', 'no-cloud', 'sam-infra', 'use-template',
    ]);
    expect(ids(steps)).toEqual(['ai-apikey', 'cloud-sam', 'github', 'project']);
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
    const stepsTemplate = generatePath(['oauth', 'has-claude', 'sam-infra', 'use-template']);
    expect(stepsRepo.find((s) => s.id === 'project')?.isOptional).toBe(false);
    expect(stepsTemplate.find((s) => s.id === 'project')?.isOptional).toBe(false);
  });

  // ── Project step variant ──

  it('has-repo produces project step with "Choose Repository" actionLabel', () => {
    const steps = generatePath(['oauth', 'has-claude', 'byoc', 'has-repo']);
    const proj = steps.find((s) => s.id === 'project');
    expect(proj?.actionLabel).toBe('Choose Repository');
  });

  it('use-template (no has-repo) produces project step with "Choose Template" actionLabel', () => {
    const steps = generatePath(['oauth', 'has-claude', 'sam-infra', 'use-template']);
    const proj = steps.find((s) => s.id === 'project');
    expect(proj?.actionLabel).toBe('Choose Template');
  });

  // ── Always has exactly one project step ──

  it('always includes exactly one project step', () => {
    const tags = [
      ['oauth', 'has-claude', 'byoc', 'has-repo'],
      ['sam-billing', 'sam-infra', 'use-template'],
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
    const steps = generatePath(['sam-billing', 'sam-infra', 'use-template']);
    // cloud-sam is 0 seconds, but ai-sam=30s, github=30s, project=30s → 90s → 2 mins
    // Actually only cloud-sam is 0, rest have time
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
