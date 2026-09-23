# Weekly Website Claims Audit

## Problem

Audit the SAM marketing website and public docs to ensure factual claims about agents, cloud providers, core capabilities, comparison positioning, how-it-works flow, and roadmap status still match the current codebase.

## Research findings

- Landing page claims live in `apps/www/src/components/` and feature copy in `apps/www/src/data/features.ts`.
- Public overview/concepts/roadmap claims live in:
  - `apps/www/src/content/docs/docs/overview.mdx`
  - `apps/www/src/content/docs/docs/concepts.mdx`
  - `apps/www/src/content/docs/docs/reference/roadmap.md`
  - `apps/www/src/content/docs/docs/index.mdx`
- Supported agents are defined by `packages/shared/src/agents.ts` and installation support is mirrored by `packages/shared/src/agent-install-manifest.json`.
- Cloud providers are defined by `packages/shared/src/types/user.ts`, API schemas, and `packages/providers/src/index.ts`.
- Roadmap claims were checked against implementation paths for app deployments, project collaboration, triggers, orchestration, CLI, snapshots, notifications, and provider catalogs.
- Current public comparison pricing language still matches official Devin and Factory/Ona pricing pages: self-serve paid plans start at $20/month.

## Checklist

- [x] Read landing page components and feature data.
- [x] Read docs overview, concepts, index, and roadmap.
- [x] Verify listed AI agents against shared agent catalog and install manifest.
- [x] Verify listed cloud providers against shared provider types, API schemas, and provider factory.
- [x] Verify feature and how-it-works claims against implementation paths.
- [x] Verify roadmap complete/planned/future claims against implementation paths.
- [x] Apply minimal corrections for factual drift.
- [x] Run focused validation.
- [x] Run documentation/task completion review.
- [ ] Open PR with checked/changed summary table and tag `@raphaeltm`.

## Acceptance criteria

- Public website claims are accurate against the current codebase.
- Any changes are minimal and targeted to factual accuracy.
- PR description includes a summary table of audited areas and outcome.
