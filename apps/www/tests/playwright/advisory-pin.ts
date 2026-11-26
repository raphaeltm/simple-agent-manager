import { readFileSync } from 'node:fs';

/**
 * Whether the built site should be showing the setup-takeover advisory as pinned, read from the
 * post's own frontmatter. The tests assert the state the build should be in today, so they keep
 * passing on both sides of the advisory's `pinnedUntil` date. The rule is restated here on
 * purpose instead of importing `isPinnedAt()`: a test oracle that shares the code under test
 * cannot catch a bug in it.
 */
export const ADVISORY = '/blog/security-advisory-setup-takeover/';

const frontmatter = readFileSync(
  new URL('../../src/content/blog/security-advisory-setup-takeover.md', import.meta.url),
  'utf8'
).split('---')[1];

const pinned = /^pinned:\s*true\s*$/m.test(frontmatter);
const untilMatch = /^pinnedUntil:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(frontmatter);
const pinnedUntil = untilMatch ? new Date(`${untilMatch[1]}T00:00:00Z`) : undefined;

export const advisoryPinnedNow = pinned && (pinnedUntil === undefined || Date.now() < pinnedUntil.getTime());

/** True within two hours of the end date, where the build and the test may sit on either side. */
export const nearPinBoundary =
  pinnedUntil !== undefined && Math.abs(Date.now() - pinnedUntil.getTime()) < 2 * 60 * 60 * 1000;
