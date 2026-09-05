# Publish SAM's Archive-Sharding Journal

## Problem Statement

SAM's public daily journal should explain the technically meaningful work shipped during the previous 24 hours. On 2026-09-05, archive sharding moved from a production-disabled design to a deliberately limited live process after the team repaired a real Cloudflare SQL bind-parameter limit. The post must help a non-specialist understand the change without repeating the 2026-09-04 storage-preflight journal or exposing business content.

## Research Findings

- Commit `dd62fa357b63923cbe20264a38a01f208e398ae0` / PR #2022 repaired archive chunk verification that failed at Cloudflare's 100-bound-parameter ceiling. The shared read now uses the existing `D1_MAX_BOUND_PARAMETERS` limit in sub-batches while preserving ordering, completeness, and recovery checks.
- Commit `3cf3858659b6d436161535943af99e9f37c1ace1` / PR #2023 enabled exact archive read routing and the independently gated, automated archive sweep with conservative production values: a 24-hour cadence, one project, one finished session, and a seven-day grace period.
- `apps/api/src/services/project-data.ts` routes exact reads through `resolveExactReadOwner()` only when archive routing is enabled. `apps/api/src/services/project-data-archive-routing.ts` refuses to guess when a move is unfinished and permits only explicit archive-journal state transitions.
- `apps/api/src/scheduled/project-data-archive-sharding.ts` parses and bounds every scheduled-sweep setting rather than relying on unrestricted work.
- The recent journal `apps/www/src/content/blog/sams-journal-a-cleanup-plan-needs-a-dry-run.md` covers the earlier, read-only tool-payload storage preflight. This post must cover the distinct result: conservative automated movement of complete, terminal conversation transcripts.
- Recent task conversations record successful manual migrations, the live flag change, and a successful production deployment. The previous daily-journal task failed before producing a PR, so it does not create duplicate published content.

## Implementation Checklist

- [x] Write a new MDX-compatible blog post in `apps/www/src/content/blog/` using the required frontmatter and SAM's first-person bot voice.
- [x] Explain the archive process with simple language while accurately naming Cloudflare Durable Objects, D1, and the bounded scheduler.
- [x] Describe the real bind-limit repair as a safety/verification improvement, not an internal debugging diary.
- [x] Assess whether a Mermaid diagram is suitable. Omitted it because the existing blog renderer displays a blank canvas; the cross-service order is stated plainly in prose and a focused renderer bug task was filed.
- [x] Link to the prior preflight journal and relevant public repository sources.
- [ ] Validate the post with the website build and link checker, then inspect the generated page.

## Acceptance Criteria

- [x] The post contains only technical, code, or feature content.
- [x] The post states that SAM is a bot keeping a daily journal and is approachable to readers new to SAM.
- [x] All technical claims match the shipped code and PR history.
- [x] It complements rather than duplicates the 2026-09-04 storage-preflight journal.
- [x] The public-site build and link checks succeed.

## Validation Evidence

- `pnpm --filter @simple-agent-manager/www lint` — passed.
- `pnpm --filter @simple-agent-manager/www typecheck` — passed against the existing four-error Astro baseline; no new warnings.
- `pnpm --filter @simple-agent-manager/www test` — passed (2 files, 2 tests).
- `pnpm --filter @simple-agent-manager/www build` — passed; the new journal route was generated.
- `pnpm --filter @simple-agent-manager/www check:links` — passed with 0 broken internal links.
- Local Chromium review at 1280×800 and 390×844 — title and journal copy rendered clearly, with no horizontal overflow. Screenshots are in `.codex/tmp/playwright-screenshots/`.
- An attempted Mermaid diagram was removed after visual evidence showed the existing renderer collapses the SVG viewBox to 0×0. The follow-up is `tasks/backlog/2026-09-05-fix-blog-mermaid-blank-canvas.md`.
