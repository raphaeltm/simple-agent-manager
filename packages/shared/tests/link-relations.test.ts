/**
 * `LINK_RELATIONS` is the runtime enumeration of the `LinkRelation` union, and `satisfies`
 * only proves that every listed member IS a relation — not that every relation is listed.
 * A member added to the union and forgotten here would silently make `isLinkRelation` reject
 * a relation the server can legitimately send, which the web normaliser then drops from a
 * link row. This is the exhaustiveness proof the enumeration's comment defers to.
 */
import { describe, expect, it } from 'vitest';

import type { LinkRelation } from '../src/types/links';
import {
  isLinkRelation,
  LINK_RELATIONS,
  STRONG_LINK_RELATIONS,
  WEAK_LINK_RELATIONS,
} from '../src/types/links';

/**
 * What this map does and does NOT buy, because the distinction is easy to get wrong.
 *
 * `pnpm typecheck` does NOT read this file: `packages/shared/tsconfig.json` excludes `tests`,
 * as `apps/api` and `apps/web` do. So the annotation below is only checked by an editor, and
 * a relation added to the union while BOTH this map and `LINK_RELATIONS` are forgotten slips
 * through every gate. That hole is tracked in
 * `tasks/backlog/2026-10-24-typecheck-test-files.md`; the same assumption is load-bearing in
 * `packages/shared/src/types/links.ts`'s own comment, so it is worth closing properly rather
 * than papering over here.
 *
 * What the assertion below DOES catch is the realistic mistake: someone adds a relation to the
 * union and to `LINK_RELATIONS` and does not come back here. Then the two lists disagree and
 * the test fails. Verified discriminating in both directions — dropping a member from
 * `LINK_RELATIONS` reddens it, and adding one without updating this map reddens it too.
 */
const EVERY_RELATION: Record<LinkRelation, true> = {
  created: true,
  discusses: true,
  edited: true,
  linked: true,
  opened: true,
  read: true,
  related: true,
  replaced: true,
  uploaded: true,
  viewed: true,
  works_on: true,
};

describe('LINK_RELATIONS', () => {
  it('lists every member of the LinkRelation union', () => {
    expect([...LINK_RELATIONS].sort()).toEqual(Object.keys(EVERY_RELATION).sort());
  });

  it('has no duplicates', () => {
    expect(new Set(LINK_RELATIONS).size).toBe(LINK_RELATIONS.length);
  });

  it('covers both strength classes, and every relation is in at most one of them', () => {
    for (const relation of [...STRONG_LINK_RELATIONS, ...WEAK_LINK_RELATIONS]) {
      expect(LINK_RELATIONS).toContain(relation);
    }
    const overlap = (STRONG_LINK_RELATIONS as readonly string[]).filter((relation) =>
      (WEAK_LINK_RELATIONS as readonly string[]).includes(relation)
    );
    expect(overlap).toEqual([]);
  });
});

describe('isLinkRelation', () => {
  it('accepts every relation', () => {
    for (const relation of LINK_RELATIONS) {
      expect(isLinkRelation(relation)).toBe(true);
    }
  });

  it('rejects anything else a JSON payload could carry', () => {
    for (const value of ['', 'WORKS_ON', 'works-on', 'nonsense', 0, null, undefined, {}, []]) {
      expect(isLinkRelation(value)).toBe(false);
    }
  });
});
