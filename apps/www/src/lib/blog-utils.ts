/** Blog category → CSS color mapping. Uses CSS custom properties for consistency. */
export const categoryColors: Record<string, string> = {
  announcement: 'var(--color-accent)',
  engineering: 'var(--color-success)',
  tutorial: 'var(--color-tutorial)',
  devlog: 'var(--color-warning)',
};

/** The frontmatter fields that decide whether a post is pinned. */
export interface PinFields {
  pinned?: boolean;
  /** First instant the pin no longer applies (a YAML date is midnight UTC). */
  pinnedUntil?: Date;
}

/**
 * Whether a post is pinned at `now`. The site is static, so `now` is the build time; the daily
 * scheduled run of `deploy-www.yml` rebuilds the site so an expired pin drops off within a day.
 */
export function isPinnedAt(data: PinFields, now: Date): boolean {
  return Boolean(data.pinned) && (!data.pinnedUntil || now.getTime() < data.pinnedUntil.getTime());
}

export const isSecurityPost = (tags: readonly string[]): boolean => tags.includes('security');
