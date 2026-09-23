# Switch Task Title Model To Gemma

## Problem

SAM's automatic task/chat title generation currently defaults to `@cf/zai-org/glm-5.2`.
The production Cloudflare cost audit in idea `01M2CSWVTGDXPSS3RCHY5GCQRV` found GLM-5.2 accounts for about 99.5% of Workers AI Neuron spend for this short one-shot title path. Gemma 4 26B A4B has been approved as the new default because prior production usage shows about 3.2 Neurons per request versus about 543 Neurons per request for GLM-5.2.

## Research Findings

- `DEFAULT_TASK_TITLE_MODEL` lives in `packages/shared/src/constants/ai-services.ts`.
- `getTaskTitleConfig()` in `apps/api/src/services/task-title.ts` reads `TASK_TITLE_MODEL` first, then falls back to `DEFAULT_TASK_TITLE_MODEL`, so the environment override remains supported.
- `getTaskTitleModelControls()` already contains the Gemma branch with `reasoningEffort: null` and `chatTemplateKwargs.enable_thinking = false`.
- Cloudflare's live Workers AI model docs list `@cf/google/gemma-4-26b-a4b-it`.
- Production GitHub Environment variables were checked with `per_page=100 --paginate`; there is no `TASK_TITLE_MODEL` override, so the deployed Worker should inherit the repo default after merge.
- Current docs that name the old title default are `apps/api/.env.example`, `apps/www/src/content/docs/docs/guides/idea-execution.md`, and `apps/www/src/content/docs/docs/reference/configuration.md`.

## Checklist

- [x] Change the shared default title model to `@cf/google/gemma-4-26b-a4b-it`.
- [x] Update unit tests that assert or fixture the default title model.
- [x] Keep explicit GLM-5.2 model-control coverage so the prior compatibility behavior remains documented.
- [x] Update current configuration docs and examples that name `TASK_TITLE_MODEL`.
- [x] Confirm no current title-default references still name GLM-5.2.
- [x] Run local checks for the touched packages.
- [x] Run specialist review evidence and address findings.
- [x] Deploy to staging and exercise real task/chat title generation with realistic prompts.
- [x] Create the PR with staging title examples, local evidence, specialist evidence, and the GLM thinking-token finding.
- [ ] Apply `coderabbit-review` once after other gates are green, address feedback, merge, monitor production deploy, and verify the deployed `TASK_TITLE_MODEL` binding.

## Acceptance Criteria

- The default task/chat title generation model is `@cf/google/gemma-4-26b-a4b-it`.
- `TASK_TITLE_MODEL` continues to override the default.
- The Gemma request path sends the expected thinking-disabled controls.
- Current docs and examples list Gemma as the default title model.
- Staging generates acceptable real titles and created resources are cleaned up.
- Production Worker settings after merge show the deployed `TASK_TITLE_MODEL` value resolves to Gemma or is absent with the repo default controlling behavior, and the idea is updated with the PR number and verified value.

## Validation Evidence

- `pnpm --filter @simple-agent-manager/shared build` passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/task-title.test.ts` passed.
- `pnpm --filter @simple-agent-manager/shared test -- tests/unit/ai-model-registry.test.ts tests/model-catalog.test.ts` passed.
- `pnpm --filter @simple-agent-manager/www lint` passed.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `pnpm test` passed after rerunning alone; the first parallel run with `pnpm build` hit a transient shared `apps/www/dist` prerender race while both commands wrote the same output directory.

## Specialist Review Evidence

| Reviewer | Status | Evidence |
| --- | --- | --- |
| task-completion-validator | PASS | Checklist items through pre-PR validation map to the current diff and passing tests. Staging, PR, CodeRabbit, merge, and production verification remain tracked as later workflow items. |
| cloudflare-specialist | PASS | No D1, KV, R2, Durable Object, `wrangler.toml`, or binding-shape changes. Production Environment variables were paginated and no `TASK_TITLE_MODEL` override exists, so the code default should control after deployment. |
| env-validator | PASS | `TASK_TITLE_MODEL` remains an optional env override in `apps/api/src/env.ts`; `.env.example` and public config docs now name Gemma. No secret or `GH_*`/`GITHUB_*` mapping changed. |
| doc-sync-validator | PASS | Current public docs and examples that describe `TASK_TITLE_MODEL` were updated. The env-reference skill wrapper does not carry a separate pinned default. |
| constitution-validator | PASS | The new model ID is a configurable default constant with the existing `TASK_TITLE_MODEL` override, not an unconfigurable magic value. No new URLs, limits, or identifiers were introduced. |

## GLM Thinking-Token Billing Finding

Code inspection found no SAM-side request for GLM thinking output on title generation. For `@cf/zai-org/glm-5.2`, `getTaskTitleModelControls()` returns only `chat_template_kwargs: { enable_thinking: false }`, and `fetchWorkersAIChatCompletion()` serializes that into the Gateway body while omitting `reasoning_effort`. The local evidence cannot prove how Cloudflare bills internal model reasoning, but the high Neuron count is not caused by SAM sending an explicit thinking-enabled control or storing thinking output.

## Staging Verification Evidence

- Deploy Staging run `35153226991` deployed branch `sam/switch-sams-automatic-taskchat-0ze5e2` and passed the deployment health check.
- Verified through the real staging feature path using `SAM_PLAYWRIGHT_PRIMARY_USER` token-login against `https://api.sammy.party`.
- Ran Playwright token-login staging smoke against `https://api.sammy.party` and `https://app.sammy.party`: `pnpm --dir apps/web exec playwright test tests/playwright/staging-api-latency.spec.ts --project="Desktop (1280x800)"` passed 3/3 after installing local Playwright browser dependencies.
- Created six lightweight conversation-style task submissions in project `01KJNR9R3TEN3KX1ETE33852R8` (`Test Project 1`), waited for generated task/session titles, and deleted all six created tasks successfully.

| Prompt theme | Gemma staging title |
| --- | --- |
| Cloud credential onboarding wizard | Investigate why cloud credential wizard appears despite available Hetzner credentials |
| Cloudflare deploy error visibility | Propose plan to improve Cloudflare Worker deployment error visibility in admin UI |
| Chat title regression test | Add regression test for chat session title generation logic |
| Archived ProjectData search coverage | Investigate and document ProjectData message coverage in MCP project-awareness searches |
| Token-login smoke test | Enhance staging smoke test to verify project data load after token login |
| Queued task cleanup | Refactor task cleanup to teardown orphaned chat sessions and record single lifecycle event |

## Direct Model Comparison

The same production title-generation prompt and Workers AI Gateway request shape were run directly against GLM and Gemma for comparable prompts:

| Prompt theme | GLM-5.2 title | Gemma title |
| --- | --- | --- |
| Cloud credential onboarding wizard | Audit workspace onboarding for Hetzner credential wizard issue | Investigate cloud credential wizard trigger in onboarding flow |
| Cloudflare deploy error visibility | Improve Cloudflare Worker deploy error diagnosis in admin UI | Improve Cloudflare Worker error visibility in admin UI |
| Chat title regression test | Add regression test for chat session title generation | Add regression test for project chat session title generation logic |
| Archived ProjectData search coverage | Investigate archived ProjectData search coverage in MCP tools | Investigate archived ProjectData message inclusion in MCP session searches |
| Token-login smoke test | Tighten staging smoke test for token login to verify app entry with project data | Enhance staging smoke test to verify project data loading after token login |
| Queued task cleanup | Refactor task cleanup to tear down orphaned chat sessions | Refactor task cleanup to remove orphaned chat sessions and unify lifecycle events |

## Pull Request Evidence

- Opened PR #2093: https://github.com/raphaeltm/simple-agent-manager/pull/2093
- PR body includes local validation, staging title examples, direct GLM/Gemma comparison, specialist review evidence, and the GLM thinking-token finding.
- Updated the PR External References wording to explicitly say "Cloudflare official documentation" after the first Preflight Evidence CI run required the literal official-documentation phrasing for an external API change.

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #2093 (`Switch task title generation default to Gemma (#2093)`). Its checklist reads 9/10 — the remaining boxes are stale. The audit verified the work, not the boxes, so they were left as-is rather than ticked without per-item evidence. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
