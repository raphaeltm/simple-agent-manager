import { describe, expect, it } from 'vitest';

import { digitalOceanTagsToLabels, labelsToDigitalOceanTags } from '../../src/digitalocean-tags';
import { delimitedTagsToLabels, kvTagsToLabels, labelsToDelimitedTags, labelsToKvTags } from '../../src/kv-tags';

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
});
