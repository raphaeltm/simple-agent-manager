import { delimitedTagsToLabels, labelsToDelimitedTags } from './kv-tags';
import { ProviderError } from './types';

/**
 * DigitalOcean tags forbid `=`; the allowed charset is letters, numbers, colons,
 * dashes, and underscores. SAM therefore encodes its labels as `key:value` colon
 * tags (split on the first `:`) rather than reusing the `=` encoding of Scaleway/Vultr.
 */
export const DIGITALOCEAN_TAG_SEPARATOR = ':';

/** DigitalOcean tag charset: letters, numbers, colons, dashes, underscores. */
const DIGITALOCEAN_TAG_RE = /^[A-Za-z0-9:_-]+$/;

/** DigitalOcean tag length ceiling (per the DO API). */
const DIGITALOCEAN_TAG_MAX_LENGTH = 255;

/**
 * Reserved tag key used to round-trip the EXACT SAM volume name. DO volume names are
 * lossy (lowercased + sanitized + truncated to 64 chars), so the original name is
 * preserved as `sam-name:<value>` and recovered on read.
 */
export const DIGITALOCEAN_VOLUME_NAME_TAG_KEY = 'sam-name';

/**
 * Encode a labels record as DigitalOcean `key:value` colon tags.
 *
 * SAM label keys/values are ULIDs and sanitized slugs, so they pass through cleanly.
 * Fails fast (rule 11) with a diagnostic naming the offending tag when a key/value
 * would produce a tag outside DO's charset or over the length ceiling — never silently
 * drops or corrupts a label.
 */
export function labelsToDigitalOceanTags(labels: Record<string, string>): string[] {
  const tags = labelsToDelimitedTags(labels, DIGITALOCEAN_TAG_SEPARATOR);
  for (const tag of tags) {
    if (tag.length > DIGITALOCEAN_TAG_MAX_LENGTH || !DIGITALOCEAN_TAG_RE.test(tag)) {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `Cannot encode label as a DigitalOcean tag: "${tag}" must match ${DIGITALOCEAN_TAG_RE} and be <= ${DIGITALOCEAN_TAG_MAX_LENGTH} chars`,
        { category: 'invalid_config' },
      );
    }
  }
  return tags;
}

/** Decode DigitalOcean `key:value` colon tags back into a labels record. */
export function digitalOceanTagsToLabels(tags: string[]): Record<string, string> {
  return delimitedTagsToLabels(tags, DIGITALOCEAN_TAG_SEPARATOR);
}
