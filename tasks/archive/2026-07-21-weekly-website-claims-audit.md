# Weekly Website Claims Audit

## Problem

Audit the SAM marketing website and public docs claims against the current codebase. Fix only factual inaccuracies or significant drift; avoid expanding feature lists or rewriting copy for style.

## Research findings

- Landing-page components live in `apps/www/src/components/`.
- Feature-detail content is sourced from `apps/www/src/data/features.ts`.
- Docs overview/concepts content lives in `apps/www/src/content/docs/docs/overview.mdx`, `apps/www/src/content/docs/docs/index.mdx`, and `apps/www/src/content/docs/docs/concepts.mdx`.
- Roadmap content lives in `apps/www/src/components/Roadmap.astro` and `apps/www/src/content/docs/docs/reference/roadmap.md`.
- Supported agents are defined in `packages/shared/src/agents.ts` as Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp.
- Supported compute providers are defined in `packages/shared/src/types/user.ts`, API schemas, and `packages/providers/src/index.ts` as Hetzner, Scaleway, and GCP.
- The homepage How It Works and comparison table already list Hetzner, Scaleway, and GCP.
- `apps/www/src/content/docs/docs/overview.mdx` still describes Bring Your Own Cloud as Hetzner or Scaleway only, which is stale now that GCP is supported.

## Checklist

- [x] Update docs overview BYOC copy to include GCP.
- [x] Re-check website/docs provider and agent claims after the change.
- [x] Run focused validation for the docs/marketing site.
- [x] Archive this task before PR.

## Acceptance criteria

- Public docs no longer imply BYOC is limited to Hetzner and Scaleway.
- Landing-page and docs agent lists match `AGENT_CATALOG`.
- Landing-page and docs compute-provider claims match `CREDENTIAL_PROVIDERS` and provider factory support.
- PR description includes a summary table of what was checked and changed or confirmed accurate.
