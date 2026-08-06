/**
 * Provider labels are the only link between a running cloud server and the SAM
 * deployment that owns it, so provider-side orphan reconciliation is only as
 * trustworthy as these values.
 */
import { describe, expect, it } from 'vitest';

import {
  buildNodeProviderLabels,
  normalizeEnvironmentLabelValue,
  resolveEnvironmentLabel,
} from '../../../src/services/node-provider-labels';

describe('buildNodeProviderLabels', () => {
  it('preserves the pre-existing label contract', () => {
    // These three keys were already relied upon by operators and by the Hetzner
    // label_selector queries; changing them would orphan the existing fleet.
    const labels = buildNodeProviderLabels({
      nodeId: '01KX84MCG1YN1TQVWR60B3G70A',
      isDeploymentNode: false,
      environmentLabel: 'production',
    });

    expect(labels).toEqual({
      node: '01kx84mcg1yn1tqvwr60b3g70a',
      managed: 'simple-agent-manager',
      role: 'workspace',
      env: 'production',
    });
  });

  it('marks deployment nodes distinctly', () => {
    const labels = buildNodeProviderLabels({
      nodeId: '01KX84MCG1YN1TQVWR60B3G70A',
      isDeploymentNode: true,
      environmentLabel: 'production',
    });

    expect(labels.role).toBe('deployment');
  });

  it('OMITS the env label when the environment is unknown', () => {
    // Omitting rather than defaulting is deliberate: a deployment that cannot
    // identify itself must produce servers reconciliation SKIPS, not servers it
    // might misattribute to whichever deployment happens to sweep next.
    const labels = buildNodeProviderLabels({
      nodeId: '01KX84MCG1YN1TQVWR60B3G70A',
      isDeploymentNode: false,
      environmentLabel: null,
    });

    expect(labels).not.toHaveProperty('env');
    expect(labels.managed).toBe('simple-agent-manager');
  });
});

describe('resolveEnvironmentLabel', () => {
  it('normalizes the configured environment', () => {
    expect(resolveEnvironmentLabel({ ENVIRONMENT: 'Production' })).toBe('production');
    expect(resolveEnvironmentLabel({ ENVIRONMENT: '  staging  ' })).toBe('staging');
  });

  it('returns null when unset, empty, or whitespace-only', () => {
    expect(resolveEnvironmentLabel({})).toBeNull();
    expect(resolveEnvironmentLabel({ ENVIRONMENT: '' })).toBeNull();
    expect(resolveEnvironmentLabel({ ENVIRONMENT: '   ' })).toBeNull();
  });

  it('returns null when normalization leaves nothing usable', () => {
    expect(resolveEnvironmentLabel({ ENVIRONMENT: '---' })).toBeNull();
  });
});

describe('normalizeEnvironmentLabelValue', () => {
  it('strips characters that would break provider tag encoding', () => {
    // Several providers encode labels into `key=value` or `key:value` tag strings,
    // so a raw `=` or `:` in the value would corrupt the round-trip.
    expect(normalizeEnvironmentLabelValue('prod=us:east')).toBe('prod-us-east');
    expect(normalizeEnvironmentLabelValue('my env!')).toBe('my-env-');
  });

  it('keeps characters Hetzner accepts', () => {
    expect(normalizeEnvironmentLabelValue('pr-123_test.1')).toBe('pr-123_test.1');
  });

  it('truncates to the 63-character provider limit', () => {
    expect(normalizeEnvironmentLabelValue('a'.repeat(200))).toHaveLength(63);
  });
});
