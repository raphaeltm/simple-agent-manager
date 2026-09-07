# Publish SAM's Archive Drain Journal

## Problem statement

SAM's public daily journal should describe a technically meaningful feature shipped in the prior 24 hours. The new archive drain is worth explaining because it turns a carefully tested archive mechanism into a bounded background process, while adding safeguards against hidden configuration overrides and safe handling for conversations that cannot move yet.

The post must be written by SAM in a first-person bot voice, state that it is a daily journal, and use simple language for readers who do not know SAM's architecture. It may cover only features, technology, and code.

## Research findings

- PR #2027 / commit `3ceafa1df` made the ProjectData archive sweep run automatically every 15 minutes with a 30-second work budget. It keeps the seven-day grace period, per-tick session and message limits, and a largest-first selection order.
- The archive coordinator records a move in D1, asks the source ProjectData Durable Object to prepare it, copies and verifies the transcript in archive storage, writes recovery evidence, then publishes the confirmed location. A failed or incomplete move does not become the official location.
- The production sweep had appeared enabled in `wrangler.toml`, but a GitHub Environment variable overrode its value to `false`. The deployment tooling now reports a conflicting non-secret override, and the production override was removed before merge.
- A pre-copy eligibility refusal formerly left a conversation marked as moving. `prepareArchiveSourceIntentOrRefuse()` now returns a typed refusal before any source write, so `refusePreCopyMigration()` restores the original location and holds that candidate out temporarily rather than retrying it endlessly.
- The preceding post, `sams-journal-the-archive-learned-to-move-slowly.md`, covered the cautious first rollout and Cloudflare SQL parameter-limit repair. This post must be a distinct follow-up about the scheduled drain and its operational safety controls.
- A Mermaid diagram would materially clarify the process. The current public renderer has a related zero-size viewBox defect because it initializes pan/zoom before its surface is in the DOM; include the small repair and a browser regression test so this post's diagram is visible.

## Implementation checklist

- [x] Activate this task on the output branch.
- [x] Write one public blog post in `apps/www/src/content/blog/` with valid frontmatter and SAM's bot-journal voice.
- [x] Explain the archive scheduler, deploy-time configuration override check, and safe pre-copy refusal in plain language.
- [x] Include an accurate Mermaid diagram of the archive control flow.
- [x] Fix the Mermaid viewer's zero-size viewBox defect and add a desktop/mobile browser regression test that proves an SVG is visible.
- [x] Validate content links, the site build, and the rendered post at desktop and mobile viewports.
- [x] Complete documentation/content, UI/UX, constitution, test, and task-completion review before opening the PR.

## Acceptance criteria

- [x] The post covers only technical work and is approachable to a lay reader.
- [x] The post accurately describes code shipped in PR #2027 without duplicating the preceding archive journal.
- [x] The post identifies SAM as a bot keeping a daily journal.
- [x] The Mermaid diagram renders with a non-zero SVG viewBox on desktop and mobile, including an existing post that uses Mermaid.
- [x] Narrow marketing-site checks pass: lint, typecheck, test, build, link check, and relevant Playwright browser checks.
- [ ] The change is published by a merged PR and its production deployment completes successfully.

## References

- `tasks/archive/2026-09-06-archive-drain-enable-unfence-and-throughput.md`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `scripts/deploy/sync-wrangler-config.ts`
- `apps/www/src/scripts/blog-mermaid.ts`
- `tasks/backlog/2026-09-05-fix-blog-mermaid-blank-canvas.md`

## Validation and review evidence

- `pnpm --filter @simple-agent-manager/www lint` — passed.
- `pnpm --filter @simple-agent-manager/www typecheck` — passed with the existing four-error Astro baseline and no warnings.
- `pnpm --filter @simple-agent-manager/www test` — passed (2 files, 2 tests).
- `PUBLIC_BASE_DOMAIN=localhost pnpm --filter @simple-agent-manager/www build` — passed and generated the new journal route.
- `pnpm --filter @simple-agent-manager/www check:links` — passed (0 broken internal links).
- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4321 pnpm exec playwright test tests/playwright/blog-mermaid.spec.ts` — passed (4 cases): existing and new archive posts on Desktop Chrome and Mobile Chrome. The test checks visible non-zero SVG viewBoxes, no overflow, zoom, reset, fullscreen, and close.
- Task-completion review: all research findings and checked implementation items have substantive changes in the PR. The only remaining acceptance item is publication, intentionally held until the PR merges and its production deployment succeeds.
- Documentation/content, constitution, test-engineering, and public-site UX reviews passed. The change introduces no API, environment, database, or deployment interface, and no new configurable business value.
