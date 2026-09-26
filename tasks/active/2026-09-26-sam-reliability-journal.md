# Publish SAM's reliability journal

## Problem statement

Publish a daily journal entry that explains the technically meaningful work merged during the previous 24 hours. The article must be written by SAM, identify SAM as a bot keeping a journal of codebase work, and make its claims understandable to readers who do not know SAM's architecture.

## Research findings

- Commits `23b477af`, `f0ab5890`, `853b637e`, and `e5ad04fe` were merged in the 24-hour window.
- `853b637e` replaced timestamp-only transcript paging with the shared `(createdAt, sequence, id)` message cursor. It also makes the VM message reporter fit oversized entries before they enter its durable outbox and keeps batches scoped to one session.
- `23b477af` preserves a failed task's work through the sleep and snapshot lifecycle so a recoverable failure does not discard the task's workspace state.
- `e5ad04fe` adds a bounded unhealthy-node cleanup path: work is drained or preserved before an unusable cloud node is removed, and its liveness state remains truthful while that happens.
- Relevant task conversations confirm that the transcript bug involved silent loss, that an unrelated flaky storage-safety alarm delayed validation, and that the unhealthy-node work completed after the reliability fixes.
- The content rules in `apps/www/src/content/CLAUDE.md` require a valid frontmatter block, clear opening takeaway, accurate technical claims, and a local marketing-site build. `apps/www/AGENTS.md` confirms Mermaid fences are supported for diagrams.

## Implementation checklist

- [x] Write a blog post in `apps/www/src/content/blog/` with valid frontmatter and a descriptive slug.
- [x] Explain the recovery flow using simple language while naming the relevant technologies where it helps.
- [x] Include a Mermaid diagram for the failure-preservation sequence.
- [x] Verify the post against the changed source and archived task records.
- [ ] Run the narrow marketing-site build and inspect the generated page.

## Acceptance criteria

- The post is public (`draft` is absent or false), has all required frontmatter, and is attributed to SAM.
- Its opening explicitly identifies SAM as a bot keeping a daily journal of codebase work.
- It covers only features, technologies, and code from the last 24 hours.
- A lay reader can understand what changed and why it matters without prior knowledge of SAM.
- The website build succeeds.

## References

- `apps/www/src/content/CLAUDE.md`
- `apps/www/AGENTS.md`
- `tasks/archive/2026-09-25-transcript-boundary-and-reporter-payloads.md`
- `tasks/archive/2026-09-25-preserve-failed-task-work.md`
- `tasks/archive/2026-09-25-unhealthy-node-drain-and-kill.md`
