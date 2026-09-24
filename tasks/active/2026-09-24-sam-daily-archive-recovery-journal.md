# SAM daily journal — archive recovery and search

## Problem

Publish a public SAM daily technical journal using the preceding 24 hours of
commits and task conversations. It must explain a meaningful shipped technical
story in simple language for readers unfamiliar with SAM. It may discuss only
features, technology, and code.

## Research findings

- PR #2133 made ProjectData archive copies resumable and deletes the original
  transcript only after copy checkpoints and verification evidence exist.
- PR #2140 added the superadmin Admin → Storage control for an incomplete
  archive move. With an operator-supplied reason, it can discard a partial copy
  only before source deletion, return the conversation to its original store,
  and leave an audit record; it refuses moves that need copy-back instead.
- The proposed archive-search continuation work is not merged, so it cannot be
  represented as shipped in this journal.
- The shipped recovery story crosses the live ProjectData Durable Object,
  archive shards, and D1 routing records. A Mermaid diagram will help a
  non-specialist understand that recovery path.
- The post belongs in `apps/www/src/content/blog/`, using the established SAM
  journal voice. The content guide requires accurate frontmatter, a concise
  title and excerpt, and marketing-site validation.

## Implementation checklist

- [x] Verify each public claim against the merged source and task evidence.
- [x] Write a SAM-authored devlog that begins by saying SAM is a bot keeping a
      daily journal of work in the codebase.
- [x] Explain archive recovery without presuming prior knowledge of Durable
      Objects or D1.
- [x] Include a Mermaid diagram for the multi-store recovery flow.
- [x] Run narrow marketing-site lint, typecheck, build, link checks, and
      Mermaid browser validation.
- [ ] Run documentation and task-completion reviews, then create, validate,
      merge, and monitor the PR.

## Acceptance criteria

- [x] The entry covers only shipped technical behavior and is understandable to
      a lay reader.
- [x] It accurately explains that a partial archive copy may be abandoned only
      before the source is deleted, while completed-source cases use recovery.
- [x] It does not present unmerged archive-search continuation work as shipped.
- [x] The diagram makes the distributed sequence clearer and renders on the
      public site.
- [ ] The site validates, the PR merges, and the production deployment passes.

## Validation evidence

- `pnpm --filter @simple-agent-manager/www lint`, `typecheck`, `build`, and
  `check:links` passed on 2026-09-24; the link check found 0 broken internal
  documentation links.
- The focused `blog-mermaid.spec.ts` route test passed in Desktop Chrome and
  Mobile Chrome. It verified the exact page title, a visible non-zero Mermaid
  SVG, zoom/reset/full-screen controls, and no horizontal overflow. The
  captured screenshots were reviewed and showed no clipping or layout issues.
- The first documentation review caught unmerged archive-search claims. They
  were removed before the fresh review and publication.

## References

- PR #2133 / commit `f5ff1e662`
- PR #2140 / commit `6946a1454`
- commits `e050bea95`, `0a7ce28ef`, and `fdae0929f`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/www/src/content/CLAUDE.md`
