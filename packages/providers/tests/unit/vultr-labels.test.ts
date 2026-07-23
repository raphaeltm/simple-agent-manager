import { describe, expect, it } from 'vitest';

import { kvTagsToLabels, labelsToKvTags } from '../../src/kv-tags';
import { labelsToScalewayTags, scalewayTagsToLabels } from '../../src/scaleway-tags';
import { decodeVultrBlockLabel, encodeVultrBlockLabel } from '../../src/vultr-labels';

describe('kv-tags', () => {
  it('round-trips a labels record through tag strings', () => {
    const labels = { 'managed-by': 'sam', 'node-id': 'n1' };
    expect(labelsToKvTags(labels)).toEqual(['managed-by=sam', 'node-id=n1']);
    expect(kvTagsToLabels(['managed-by=sam', 'node-id=n1'])).toEqual(labels);
  });

  it('ignores malformed tag entries when decoding', () => {
    expect(kvTagsToLabels(['ok=1', 'noequals', '=leading'])).toEqual({ ok: '1' });
  });

  it('preserves = characters inside the value', () => {
    expect(kvTagsToLabels(['url=https://x/?a=b'])).toEqual({ url: 'https://x/?a=b' });
  });
});

describe('scaleway-tags re-export is unchanged', () => {
  it('exposes the original Scaleway-named helpers backed by kv-tags', () => {
    expect(labelsToScalewayTags({ a: '1' })).toEqual(['a=1']);
    expect(scalewayTagsToLabels(['a=1'])).toEqual({ a: '1' });
  });
});

describe('vultr block label encoding', () => {
  it('round-trips labels through the single Vultr label string', () => {
    const labels = { 'sam-environment': 'env-1', 'sam-volume-name': 'data' };
    const encoded = encodeVultrBlockLabel(labels);
    expect(encoded).toBe('sam-environment=env-1;sam-volume-name=data');
    expect(decodeVultrBlockLabel(encoded)).toEqual(labels);
  });

  it('decodes empty / null labels to an empty record', () => {
    expect(decodeVultrBlockLabel('')).toEqual({});
    expect(decodeVultrBlockLabel(null)).toEqual({});
    expect(decodeVultrBlockLabel(undefined)).toEqual({});
  });
});
