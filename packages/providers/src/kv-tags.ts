/**
 * Generic `key=value` tag encoding shared by providers that store SAM labels as
 * an array of flat tag strings (Scaleway tags, Vultr instance tags, and — joined
 * into a single string — Vultr block-storage labels).
 */

/** Encode a labels record as `key=value` tag strings. */
export function labelsToKvTags(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
}

/** Decode `key=value` tag strings back into a labels record. Malformed entries are ignored. */
export function kvTagsToLabels(tags: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags) {
    const eqIndex = tag.indexOf('=');
    if (eqIndex > 0) {
      labels[tag.slice(0, eqIndex)] = tag.slice(eqIndex + 1);
    }
  }
  return labels;
}
