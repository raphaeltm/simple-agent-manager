# Weekly Website Claims Audit

## Problem

Audit the SAM marketing website and public docs to ensure factual claims about agents, cloud providers, feature capabilities, comparison positioning, how-it-works flow, and roadmap status match the current codebase.

## Research findings

- Landing page claims live in `apps/www/src/components/` and feature data under `apps/www/src/data/features/`.
- Docs claims requested by the audit live in `apps/www/src/content/docs/docs/overview.mdx`, `apps/www/src/content/docs/docs/concepts.mdx`, `apps/www/src/content/docs/docs/index.mdx`, and `apps/www/src/content/docs/docs/reference/roadmap.md`.
- Supported agents still match `packages/shared/src/agents.ts` and `packages/shared/src/agent-install-manifest.json`: Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- Supported VM providers still match `packages/providers/src/index.ts`, `packages/providers/src/types.ts`, and the API schemas: Hetzner, Scaleway, GCP, Vultr, Infomaniak, DigitalOcean, and UpCloud.
- Feature claims for chat-first execution, Instant/VM workspaces, sleep/wake snapshots, project events/triggers, comments, app deployments, compute pools, notifications, usage visibility, and collaboration all have matching implementation paths.
- The role model now includes owner/admin/maintainer/viewer in `apps/api/src/middleware/project-auth.ts` and `packages/shared/src/types/project.ts`, but invite approval still promotes users as admins and the user-facing role assignment surface is not complete. The roadmap should describe the remaining planned work as role assignment rather than implying the capability foundation does not exist.
- External comparison spot check on 2026-09-29 found Devin self-serve pricing still starts at $20/month and Coder still positions itself as self-hosted, Terraform-defined workspaces.

## Checklist

- [x] Read landing page components and feature data.
- [x] Read docs overview, concepts, index, and roadmap.
- [x] Verify listed AI agents against shared agent catalog and install manifest.
- [x] Verify listed cloud providers against shared provider types, API schemas, and provider factory.
- [x] Verify feature and how-it-works claims against implementation paths.
- [x] Verify comparison table against implementation paths and current external pricing/docs.
- [x] Verify roadmap complete/planned claims against implementation paths.
- [x] Apply minimal corrections for factual drift.
- [x] Run focused validation.
- [x] Run documentation/task completion review.
- [x] Prepare PR summary table from audit findings.

## Acceptance criteria

- Public website claims are accurate against the current codebase.
- Changes are minimal and targeted to factual accuracy.
- PR description includes a summary table of audited areas and outcome.

## Validation

- `pnpm --filter @simple-agent-manager/www lint` — passed.
- `pnpm --filter @simple-agent-manager/www typecheck` — passed with the existing Astro template baseline diagnostics.
- `pnpm --filter @simple-agent-manager/www build` — passed.
- `pnpm --filter @simple-agent-manager/www check:links` — passed, 0 broken internal doc links across 30 doc pages.

## Review

### Task Completion Validation Report

**Verdict: PASS**

| Check | Status | Issues |
|-------|--------|--------|
| A: Research → Checklist | PASS | All research findings are covered by checklist items. |
| B: Checklist → Diff | PASS | Checked implementation items are reflected in the roadmap diff or documented validation. |
| C: Criteria → Tests | PASS | Acceptance criteria are covered by the focused marketing validation and the PR summary requirement is carried into the PR body. |
| D: UI → Backend | N/A | No new UI input or backend data path. |
| E: Multi-Resource | N/A | No resource selection logic changed. |
| F: Vertical Slice | N/A | Content-only roadmap update. |

### Documentation Sync Report

**Verdict: PASS**

The changed roadmap now matches the current project-role implementation: `owner`, `admin`, `maintainer`, and `viewer` are enforced in the shared project member type and API capability middleware, while user-facing controls to assign maintainer/viewer roles remain planned. No env var, API endpoint, schema, or link documentation updates were required.
