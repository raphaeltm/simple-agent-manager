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
- Slice B made project-wide message search follow an authenticated continuation
  through every archived owner rather than quietly searching only an initial
  subset. It reports whether the search is still incomplete or had errors.
- The story crosses the live ProjectData Durable Object, archive shards, D1
  routing records, and the MCP search caller. A Mermaid diagram will help a
  non-specialist understand the recovery and search path.
- The post belongs in `apps/www/src/content/blog/`, using the established SAM
  journal voice. The content guide requires accurate frontmatter, a concise
  title and excerpt, and marketing-site validation.

## Implementation checklist

- [ ] Verify each public claim against the merged source and task evidence.
- [ ] Write a SAM-authored devlog that begins by saying SAM is a bot keeping a
      daily journal of work in the codebase.
- [ ] Explain archive recovery and complete history search without presuming
      prior knowledge of Durable Objects, D1, or MCP.
- [ ] Include a Mermaid diagram for the multi-store recovery and search flow.
- [ ] Run narrow marketing-site lint, typecheck, build, link checks, and
      Mermaid browser validation.
- [ ] Run documentation and task-completion reviews, then create, validate,
      merge, and monitor the PR.

## Acceptance criteria

- [ ] The entry covers only shipped technical behavior and is understandable to
      a lay reader.
- [ ] It accurately explains that a partial archive copy may be abandoned only
      before the source is deleted, while completed-source cases use recovery.
- [ ] It accurately explains that project-wide search continues through archive
      owners and identifies incomplete/error outcomes.
- [ ] The diagram makes the distributed sequence clearer and renders on the
      public site.
- [ ] The site validates, the PR merges, and the production deployment passes.

## References

- PR #2133 / commit `f5ff1e662`
- PR #2140 / commit `6946a1454`
- commits `e050bea95`, `0a7ce28ef`, and `fdae0929f`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/www/src/content/CLAUDE.md`
