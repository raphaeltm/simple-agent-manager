import { describe, expect, it } from 'vitest';

import {
  type GeneratedStep,
  generatePath,
  getTimeEstimate,
} from '../../../src/components/onboarding/choose-path/path-generator';

describe('generatePath', () => {
  // Helper to extract step IDs
  const ids = (steps: GeneratedStep[]) => steps.map((s) => s.id);

  // ── Step order & cloud branching ──
  // Each case is (label, input tags, expected step ids). The path is now fully
  // agent-neutral: ai-setup is ALWAYS emitted (agent + connection method are
  // chosen inline), the cloud step branches on `byoc`, github is always present,
  // and project is always last. Only `byoc` and `has-repo` influence the shape.
  it.each([
    ['byoc + repo', ['byoc', 'has-repo'], ['ai-setup', 'cloud-byoc', 'github', 'project']],
    ['byoc + no-repo', ['byoc'], ['ai-setup', 'cloud-byoc', 'github', 'project']],
    ['sam-managed + repo', ['has-repo'], ['ai-setup', 'cloud-sam', 'github', 'project']],
    ['sam-managed + no-repo', [], ['ai-setup', 'cloud-sam', 'github', 'project']],
  ])('%s → %j', (_label, tags, expected) => {
    expect(ids(generatePath(tags))).toEqual(expected);
  });

  // ── ai-setup is always present and agent-neutral ──

  it('always emits the ai-setup step regardless of tags', () => {
    expect(ids(generatePath([]))).toContain('ai-setup');
    expect(ids(generatePath(['byoc', 'has-repo']))).toContain('ai-setup');
  });

  it('never emits any Claude-specific or per-provider AI step id', () => {
    const steps = ids(generatePath(['byoc', 'has-repo']));
    for (const dead of ['ai-oauth', 'ai-apikey', 'ai-sam']) {
      expect(steps).not.toContain(dead);
    }
  });

  // ── Cloud branching ──

  it('byoc tag produces cloud-byoc (own cloud account)', () => {
    const steps = ids(generatePath(['byoc']));
    expect(steps).toContain('cloud-byoc');
    expect(steps).not.toContain('cloud-sam');
  });

  it('absence of byoc produces cloud-sam (SAM-managed)', () => {
    const steps = ids(generatePath([]));
    expect(steps).toContain('cloud-sam');
    expect(steps).not.toContain('cloud-byoc');
  });

  // ── isOptional behavior (existing-* pre-population) ──

  it('existing-agent tag marks ai-setup as isOptional', () => {
    const steps = generatePath(['byoc', 'has-repo', 'existing-agent']);
    expect(steps.find((s) => s.id === 'ai-setup')?.isOptional).toBe(true);
  });

  it('ai-setup is NOT optional without existing-agent tag', () => {
    const steps = generatePath(['byoc', 'has-repo']);
    expect(steps.find((s) => s.id === 'ai-setup')?.isOptional).toBe(false);
  });

  it('existing-cloud tag marks cloud-byoc step as isOptional', () => {
    const steps = generatePath(['byoc', 'has-repo', 'existing-cloud']);
    expect(steps.find((s) => s.id === 'cloud-byoc')?.isOptional).toBe(true);
  });

  it('existing-cloud tag marks cloud-sam step as isOptional', () => {
    const steps = generatePath(['has-repo', 'existing-cloud']);
    expect(steps.find((s) => s.id === 'cloud-sam')?.isOptional).toBe(true);
  });

  it('cloud step is NOT optional without existing-cloud tag', () => {
    expect(generatePath(['byoc']).find((s) => s.id === 'cloud-byoc')?.isOptional).toBe(false);
    expect(generatePath([]).find((s) => s.id === 'cloud-sam')?.isOptional).toBe(false);
  });

  it('existing-github tag marks github step as isOptional', () => {
    const steps = generatePath(['byoc', 'has-repo', 'existing-github']);
    expect(steps.find((s) => s.id === 'github')?.isOptional).toBe(true);
  });

  it('project step is never isOptional', () => {
    const stepsRepo = generatePath(['byoc', 'has-repo']);
    const stepsTemplate = generatePath(['byoc']);
    expect(stepsRepo.find((s) => s.id === 'project')?.isOptional).toBe(false);
    expect(stepsTemplate.find((s) => s.id === 'project')?.isOptional).toBe(false);
  });

  // ── Project step variant ──

  it('has-repo produces project step with "Choose Repository" actionLabel', () => {
    const steps = generatePath(['byoc', 'has-repo']);
    expect(steps.find((s) => s.id === 'project')?.actionLabel).toBe('Choose Repository');
  });

  it('no-repo produces project step with "Choose Repository" actionLabel', () => {
    const steps = generatePath(['byoc']);
    expect(steps.find((s) => s.id === 'project')?.actionLabel).toBe('Choose Repository');
  });

  it('has-repo and no-repo project variants differ in copy', () => {
    const withRepo = generatePath(['has-repo']).find((s) => s.id === 'project');
    const withoutRepo = generatePath([]).find((s) => s.id === 'project');
    expect(withRepo?.description).not.toBe(withoutRepo?.description);
  });

  // ── Project step is always present and last ──

  it('always includes exactly one project step, always last', () => {
    const tagSets = [['byoc', 'has-repo'], ['byoc'], ['has-repo'], []];
    for (const t of tagSets) {
      const steps = generatePath(t);
      const projectSteps = steps.filter((s) => s.id === 'project');
      expect(projectSteps).toHaveLength(1);
      expect(steps.at(-1)?.id).toBe('project');
    }
  });
});

describe('getTimeEstimate', () => {
  it('sums the default (SAM-managed) path: ai-setup + github + project', () => {
    // generatePath([]) → ai-setup(60s) + cloud-sam(Instant, 0) + github(30s) +
    // project(30s) = 120s → 2 mins. cloud-sam contributes nothing.
    const estimate = getTimeEstimate(generatePath([]));
    expect(estimate).toBe('~2 mins');
  });

  it('returns singular "min" for exactly 1 minute', () => {
    const fakeSteps = [{ timeEstimate: '1 minute' }] as GeneratedStep[];
    expect(getTimeEstimate(fakeSteps)).toBe('~1 min');
  });

  it('returns plural "mins" for more than 1 minute', () => {
    const fakeSteps = [
      { timeEstimate: '1 minute' },
      { timeEstimate: '30 seconds' },
    ] as GeneratedStep[];
    expect(getTimeEstimate(fakeSteps)).toBe('~2 mins');
  });

  it('handles "0 seconds" without NaN', () => {
    const fakeSteps = [{ timeEstimate: '0 seconds' }] as GeneratedStep[];
    expect(getTimeEstimate(fakeSteps)).toBe('< 1 min');
  });

  it('excludes optional steps from the time estimate', () => {
    const fakeSteps = [
      { timeEstimate: '30 seconds', isOptional: true },
      { timeEstimate: '1 minute', isOptional: false },
    ] as GeneratedStep[];
    // Only the non-optional step counts: 60s → 1 min
    expect(getTimeEstimate(fakeSteps)).toBe('~1 min');
  });

  it('returns < 1 min when all steps are optional', () => {
    const fakeSteps = [
      { timeEstimate: '30 seconds', isOptional: true },
      { timeEstimate: '1 minute', isOptional: true },
    ] as GeneratedStep[];
    expect(getTimeEstimate(fakeSteps)).toBe('< 1 min');
  });
});
