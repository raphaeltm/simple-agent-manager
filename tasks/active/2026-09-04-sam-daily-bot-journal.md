# SAM daily bot journal: verified storage-relief preflight

## Problem statement

SAM's public engineering journal needs a daily post only when recent code has a clear, useful technical story. The preceding 24 hours included the merged ProjectData emergency-relief work in PR #2014. It adds a read-only preflight that creates verified, exact cleanup evidence before any archived tool payload is eligible for removal. This is distinct from the 2026-09-03 post about manual cleanup controls: the new post should explain why a database cleanup plan needs proof and may correctly conclude that it should not run.

## Research findings

- `apps/www/src/content/CLAUDE.md` defines the blog frontmatter, public-site validation commands, and journal publication conventions.
- `apps/www/src/content/blog/sams-journal-cleanup-got-a-safe-switch.md` already explains the manual, bounded cleanup path. The new post must not repeat that material.
- PR #2014 (`831d14e2a`) adds the bounded preflight in `apps/api/src/scheduled/project-data-storage-relief-preflight.ts` and verified R2 manifest helpers in `apps/api/src/durable-objects/project-data/tool-payload-cleanup-manifest.ts`.
- The production-capacity task records the key invariant: message text is never in scope. The preflight only measures and records eligible inline tool payloads; it writes/read-backs SHA-256-verified manifests before any future mutation can use them.
- The task's staging evidence found that archive bookkeeping has a per-row cost. Therefore gross bytes are not proof that removal saves space; the preflight must report a net result and permit a no-go conclusion.
- Recent task conversation evidence confirms PR #2014 merged and production deployed with preflight enabled but destructive cleanup disabled, so public copy must not imply that a production cleanup ran.
- Local browser preview exposed a Mermaid renderer lifecycle defect: `attachPanZoom()` measured its detached surface, producing a zero-sized viewBox and an invisible diagram. The post requires a Mermaid diagram, so the small fix belongs in this PR.

## Implementation checklist

- [x] Draft a SAM first-person journal post in `apps/www/src/content/blog/` with valid frontmatter and a distinct title.
- [x] Explain the preflight, verified manifests, net-space decision, and fail-closed behavior in plain language while retaining correct technical terms.
- [x] Include one Mermaid diagram because the cross-service sequence (ProjectData SQLite, D1 plan state, and R2 verification) is clearer than prose alone.
- [x] Attach rendered Mermaid surfaces before calculating their pan/zoom layout, then verify the diagram is visible in a browser preview.
- [x] Check all public claims against the merged source and avoid claims about business, private information, or an executed production cleanup.
- [x] Run the content-specific build, typecheck, lint, tests, and link checks; inspect the built post in desktop and mobile browser previews.
- [x] Correct the stale blog-frontmatter field list in `apps/www/AGENTS.md` so it matches the active content schema.
- [ ] Run required content/documentation completion reviews, then open, validate, and merge the PR.

## Acceptance criteria

- [x] The post calls its author SAM and identifies SAM as a bot keeping a daily codebase journal.
- [x] It covers only features, technology, or code and uses a simple structure for readers unfamiliar with SAM.
- [x] It accurately distinguishes read-only preflight from destructive cleanup and says message text is not targeted.
- [x] Its Mermaid diagram is valid and materially explains the verified multi-system flow.
- [x] The public site validates successfully and the post renders in the built site.
- [ ] The change is delivered in a merged PR after required reviews and checks.

## Validation evidence

- `pnpm --filter @simple-agent-manager/www lint` — passed.
- `pnpm --filter @simple-agent-manager/www typecheck` — passed with the repository's four acknowledged baseline template errors and no new errors.
- `pnpm --filter @simple-agent-manager/www test` — passed: 2 files and 2 tests.
- `pnpm --filter @simple-agent-manager/www build` — passed; generated `/blog/sams-journal-a-cleanup-plan-needs-a-dry-run/`.
- `pnpm --filter @simple-agent-manager/www check:links` — passed: 0 broken internal documentation links.
- Local Playwright preview at `/blog/sams-journal-a-cleanup-plan-needs-a-dry-run/` — desktop (1280px) and mobile (375px) both showed the required bot-journal lead, one rendered Mermaid SVG with a positive viewBox, and no horizontal overflow. Screenshots are in the gitignored `.tmp/` directory and will be attached to the PR as review evidence.

## References

- `apps/www/src/content/CLAUDE.md`
- `apps/www/src/content/blog/sams-journal-cleanup-got-a-safe-switch.md`
- `tasks/active/2026-09-03-projectdata-production-capacity-emergency.md`
- `apps/api/src/scheduled/project-data-storage-relief-preflight.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-cleanup-manifest.ts`
- PR #2014 / commit `831d14e2a05c0bed92f419646828a826f9616c73`
