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
- [x] Run narrow marketing-site lint, typecheck, test, build, link, and
  desktop/mobile Mermaid browser validation.
- [x] Complete documentation/content, constitution, and task-completion review.

## Acceptance criteria

- [x] The post is public, non-draft, authored by SAM, and starts by identifying
  SAM as a bot keeping a daily journal.
- [x] It only covers technical work and is understandable without prior SAM
  architecture knowledge.
- [x] It accurately distinguishes the per-chunk read timeout from the
  temporary sweep-size limit.
- [x] Its Mermaid diagram renders and has no horizontal overflow on desktop and
  mobile.
- [x] Narrow marketing validation and required reviews pass.
- [ ] The change is published by a merged PR and its production deploy succeeds.

## References

- `15454cc700cddfc69d188b8054a1516b298fb67f` (PR #2094)
- `apps/api/src/durable-objects/project-data/compact-archive.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/wrangler.toml`
- `apps/api/tests/unit/durable-objects/project-data-compact-archive.test.ts`
- `apps/www/src/content/CLAUDE.md`
- `apps/www/tests/playwright/blog-mermaid.spec.ts`

## Validation and review evidence

| Check | Result |
| --- | --- |
| `pnpm --filter @simple-agent-manager/www lint` | PASS |
| `pnpm --filter @simple-agent-manager/www typecheck` | PASS; five existing Astro-template errors, no new errors |
| `pnpm --filter @simple-agent-manager/www test` | PASS; 49 tests across 5 files |
| `PUBLIC_BASE_DOMAIN=localhost pnpm --filter @simple-agent-manager/www build` | PASS; generated the journal route |
| `pnpm --filter @simple-agent-manager/www check:links` | PASS; 0 broken internal links |
| `pnpm --filter @simple-agent-manager/www exec playwright test tests/playwright/blog-mermaid.spec.ts --grep 'archive timeout journal'` | PASS; 2 cases on Desktop Chrome and Mobile Chrome. The test checks a visible nonzero Mermaid viewport, zoom/reset, fullscreen, and no horizontal overflow. |
| Visual review | PASS; reviewed the generated desktop and mobile screenshots. The shortened diagram labels are readable at both sizes. |

The documentation/content review found three wording issues and they were fixed before this record: the diagram now shows the retry threshold before automatic work pauses, the timeout is described as covering one complete R2 chunk read, and the conclusion is limited to false failures from a shared deadline. The constitution review passed: this post and its route-test constant add no runtime business logic, configurable values, or deployment URLs. The task-completion re-review passed with no pre-merge implementation gaps.

The final publication criterion deliberately remains unchecked until this PR merges and its production deployment completes. Keep this task active until that evidence is available.

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #2095 (`docs: publish SAM archive timeout journal (#2095)`). Its checklist reads 11/12 — the remaining boxes are stale. The audit verified the work, not the boxes, so they were left as-is rather than ticked without per-item evidence. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
