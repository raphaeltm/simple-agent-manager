import { readFileSync } from 'node:fs';

/**
 * Whether the built site should be showing the setup-takeover advisory as pinned, read from the
 * post's own frontmatter. The tests assert the state the build should be in today, so they keep
 * passing on both sides of the advisory's `pinnedUntil` date. The rule is restated here on
 * purpose instead of importing `isPinnedAt()`: a test oracle that shares the code under test
 * cannot catch a bug in it.
 */
export const ADVISORY = '/blog/security-advisory-setup-takeover/';

const source = readFileSync(
  new URL('../../src/content/blog/security-advisory-setup-takeover.md', import.meta.url),
  'utf8'
);
const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
if (!frontmatterMatch) throw new Error('advisory-pin: the advisory post has no frontmatter block');
const frontmatter = frontmatterMatch[1];

const pinned = /^pinned:\s*true\s*$/m.test(frontmatter);
const untilMatch = /^pinnedUntil:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(frontmatter);
// Fail loudly on any other pinnedUntil shape (quoted, timestamp, trailing comment) rather than
// silently reading it as "no end date" and asserting the wrong state.
if (/^pinnedUntil:/m.test(frontmatter) && !untilMatch) {
  throw new Error('advisory-pin: write pinnedUntil as a bare YYYY-MM-DD date so this test can read it');
}
const pinnedUntil = untilMatch ? new Date(`${untilMatch[1]}T00:00:00Z`) : undefined;

export const advisoryPinnedNow = pinned && (pinnedUntil === undefined || Date.now() < pinnedUntil.getTime());

/** True within two hours of the end date, where the build and the test may sit on either side. */
export const nearPinBoundary =
  pinnedUntil !== undefined && Math.abs(Date.now() - pinnedUntil.getTime()) < 2 * 60 * 60 * 1000;
