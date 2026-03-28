# Update License References from MIT to AGPL-3.0

## Problem

The project license was changed from MIT to AGPL-3.0 (LICENSE file and README badge already updated), but many files across the codebase still reference "MIT". These need to be updated for consistency.

## Research Findings

### Files referencing MIT as SAM's license (need updating)

| File | Reference |
|------|-----------|
| `package.json:12` | `"license": "MIT"` |
| `README.md:125` | `[MIT](LICENSE)` |
| `apps/www/src/components/CtaFooter.astro:42,45` | Footer link + copyright line |
| `apps/www/src/components/SocialProof.astro:43` | Badge text `MIT Licensed` |
| `apps/www/src/components/Comparison.astro:19` | Comparison table `MIT license` |
| `apps/www/src/components/Features.astro:31` | Feature description `MIT licensed` |
| `specs/001-mvp/plan.md:34` | Constitution compliance note `OSS (MIT)` |
| `specs/003-browser-terminal-saas/contracts/api.yaml:11` | OpenAPI license field |
| `specs/003-browser-terminal-saas/contracts/agent.yaml:11` | OpenAPI license field |
| `.specify/memory/constitution.md:29` | Principle I `(MIT or Apache 2.0)` |
| `research/architecture-notes.md:401` | `MIT licensed` (about SAM in context) |
| `tasks/archive/2026-02-23-marketing-site-messaging-overhaul.md:35` | Historical task note |

### Files referencing MIT for third-party deps (NO change needed)

- `specs/021-task-chat-architecture/` — cenkalti/backoff is MIT licensed
- `specs/006-multi-agent-support/research.md` — Happy Coder is MIT licensed

## Implementation Checklist

- [ ] Update `package.json` license field to `AGPL-3.0-or-later`
- [ ] Update `README.md` license link text
- [ ] Update `CtaFooter.astro` footer link and copyright text
- [ ] Update `SocialProof.astro` badge text
- [ ] Update `Comparison.astro` comparison table
- [ ] Update `Features.astro` feature description
- [ ] Update `specs/001-mvp/plan.md` constitution compliance note
- [ ] Update `specs/003-browser-terminal-saas/contracts/api.yaml` OpenAPI license
- [ ] Update `specs/003-browser-terminal-saas/contracts/agent.yaml` OpenAPI license
- [ ] Update `.specify/memory/constitution.md` Principle I
- [ ] Update `research/architecture-notes.md`
- [ ] Update `tasks/archive/2026-02-23-marketing-site-messaging-overhaul.md`

## Acceptance Criteria

- [ ] No file in the repo references MIT as SAM's own license
- [ ] Third-party MIT license references are preserved unchanged
- [ ] `pnpm lint && pnpm typecheck` pass
- [ ] README badge (already AGPL) and LICENSE file (already AGPL) are consistent with all references
