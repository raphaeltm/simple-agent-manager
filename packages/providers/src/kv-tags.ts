/**
 * Generic delimited `key<sep>value` tag encoding shared by providers that store SAM
 * labels as an array of flat tag strings:
 * - Scaleway tags and Vultr instance tags use `=` (via labelsToKvTags/kvTagsToLabels).
 * - Vultr block-storage labels join `key=value` pairs into a single string.
 * - DigitalOcean tags forbid `=`, so they use a `:` separator (see digitalocean-tags.ts).
 *
 * The separator-parameterized core lives here so every provider shares one encoder.
 */

/** Encode a labels record as `key<separator>value` tag strings. */
export function labelsToDelimitedTags(labels: Record<string, string>, separator: string): string[] {
  return Object.entries(labels).map(([key, value]) => `${key}${separator}${value}`);
}

/**
 * Decode `key<separator>value` tag strings back into a labels record.
 * Splits on the FIRST separator so values may themselves contain the separator.
 * Malformed entries (no separator, or separator at index 0) are ignored.
 */
export function delimitedTagsToLabels(tags: string[], separator: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags) {
    const sepIndex = tag.indexOf(separator);
    if (sepIndex > 0) {
      labels[tag.slice(0, sepIndex)] = tag.slice(sepIndex + separator.length);
    }
  }
  return labels;
}

/** Encode a labels record as `key=value` tag strings (Scaleway / Vultr instances). */
export function labelsToKvTags(labels: Record<string, string>): string[] {
  return labelsToDelimitedTags(labels, '=');
}

/** Decode `key=value` tag strings back into a labels record. Malformed entries are ignored. */
export function kvTagsToLabels(tags: string[]): Record<string, string> {
  return delimitedTagsToLabels(tags, '=');
}
