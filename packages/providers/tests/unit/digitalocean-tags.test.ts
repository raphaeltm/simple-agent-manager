import { describe, expect, it } from 'vitest';

import { digitalOceanTagsToLabels, labelsToDigitalOceanTags } from '../../src/digitalocean-tags';
import { delimitedTagsToLabels, hasAmbiguousLabel, kvTagsToLabels, labelsToDelimitedTags, labelsToKvTags } from '../../src/kv-tags';

describe('DigitalOcean colon tags', () => {
  it('round-trips values by splitting only on the first colon', () => {
    expect(digitalOceanTagsToLabels(labelsToDigitalOceanTags({ env: 'prod', ref: 'abc:def' }))).toEqual({ env: 'prod', ref: 'abc:def' });
  });
  it.each([{ bad: 'space value' }, { bad: 'equals=value' }, { ['x'.repeat(256)]: 'y' }])('fails fast for unencodable labels', (labels) => expect(() => labelsToDigitalOceanTags(labels)).toThrow(/Cannot encode label/));
  it('keeps existing equals-tag behavior unchanged', () => {
    expect(labelsToKvTags({ env: 'prod' })).toEqual(['env=prod']);
    expect(kvTagsToLabels(['env=prod=blue'])).toEqual({ env: 'prod=blue' });
    expect(delimitedTagsToLabels(labelsToDelimitedTags({ a: 'b' }, ':'), ':')).toEqual({ a: 'b' });
  });
  it('drops duplicate semantic keys instead of selecting an ownership value by order', () => {
    const digitalOcean = digitalOceanTagsToLabels([
      'installation:foreign',
      'installation:ours',
      'env:prod',
    ]);
    const equals = kvTagsToLabels(['installation=ours', 'installation=foreign', 'env=prod']);
    expect(digitalOcean).not.toHaveProperty('installation');
    expect(equals).not.toHaveProperty('installation');
    expect(hasAmbiguousLabel(digitalOcean, 'installation')).toBe(true);
    expect(hasAmbiguousLabel(equals, 'installation')).toBe(true);
  });
});
