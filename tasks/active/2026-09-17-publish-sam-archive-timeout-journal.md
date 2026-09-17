# Publish SAM's archive timeout journal

## Problem

Publish one public daily journal entry about the most technically meaningful
work from the previous 24 hours. It must be written by SAM for readers who do
not know the system's architecture and cover only features, technology, and
code.

## Research findings

- PR #2094 fixed an archive-drain stall in compact R2 conversation archives.
  The old read path supplied one deadline to all chunks in a conversation, so
  several individually successful reads could exhaust the total time limit.
- An exhausted deadline made sealing fail and opened a per-project circuit
  breaker. That correctly stopped further risky archive work, but also stopped
  the project's archive drain until an operator intervened.
- The repair passes the configured R2 timeout to each compact chunk read. The
  same per-chunk model was already used by the write path.
- The configured sweep ceiling was temporarily reduced from 5,000 to 3,000
  messages while the repair is deployed and verified, limiting which old
  conversations the background worker starts.
- `apps/www/src/content/CLAUDE.md` requires valid frontmatter, an accurate
  technical account, a concise title and excerpt, and a local production build.
- A Mermaid diagram materially clarifies the background worker, Durable Object,
  R2, and circuit-breaker sequence. The existing browser matrix validates real
  published diagrams on desktop and mobile.

## Implementation checklist

- [x] Add a SAM-authored `devlog` post in `apps/www/src/content/blog/` with the
  requested bot-journal opening and valid frontmatter.
- [x] Explain the former shared deadline and the new per-chunk timeout in plain
  language, while naming the relevant Cloudflare technologies in context.
- [x] Include an accurate Mermaid diagram of the archival read and safety flow.
- [x] Add the post to the real-page Mermaid browser regression matrix.
- [ ] Run narrow marketing-site lint, typecheck, test, build, link, and
  desktop/mobile Mermaid browser validation.
- [ ] Complete documentation/content, constitution, and task-completion review.

## Acceptance criteria

- [ ] The post is public, non-draft, authored by SAM, and starts by identifying
  SAM as a bot keeping a daily journal.
- [ ] It only covers technical work and is understandable without prior SAM
  architecture knowledge.
- [ ] It accurately distinguishes the per-chunk read timeout from the
  temporary sweep-size limit.
- [ ] Its Mermaid diagram renders and has no horizontal overflow on desktop and
  mobile.
- [ ] Narrow marketing validation and required reviews pass.
- [ ] The change is published by a merged PR and its production deploy succeeds.

## References

- `15454cc700cddfc69d188b8054a1516b298fb67f` (PR #2094)
- `apps/api/src/durable-objects/project-data/compact-archive.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/wrangler.toml`
- `apps/api/tests/unit/durable-objects/project-data-compact-archive.test.ts`
- `apps/www/src/content/CLAUDE.md`
- `apps/www/tests/playwright/blog-mermaid.spec.ts`
