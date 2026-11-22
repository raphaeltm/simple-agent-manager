# Finish migrating off the Workers AI models retired 2026-11-20

## Problem

Cloudflare retired 24 Workers AI models on 2026-11-20 (requests return HTTP 410 / error 5028,
https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/).
`DEFAULT_DEBUG_AGENT_MODEL` was still `@cf/zai-org/glm-5.2`, so every automated incident-triage
diagnosis failed (production incident 980e41c4, `lastFailureReason` "Debugging model request failed
with HTTP 410", 2026-11-22; staging since 2026-11-20). PR #2860 moved only `SAM_MODEL`.
Idea 01M77CKWZAGYYQF6AZCW1GS07P. Supersedes `tasks/backlog/2026-11-20-staging-debug-agent-model-410.md`.

## Research findings

- Live catalog read 2026-11-22 (`/ai/models/search`, production and staging accounts, 52 models):
  `qwen3-30b-a3b-fp8`, `glm-5.3-flash`, `glm-5.2` are gone. `@cf/deepseek-ai/deepseek-v4.1-flash-1017`
  is live: function_calling true, context 1,048,576, reasoning efforts none/low/high/max (default
  high), $0.30 in / $1.20 out / $0.006 cached per M. Gemma 4 26B, Llama 4 Scout, Qwen 2.5 Coder live.
- Live experiment (debug-agent request shape, 2 tools, multi-turn, max_tokens 4096) on DeepSeek:
  every effort completed the tool loop without replaying `reasoning_content`. `low`: 2 tool rounds,
  ~1.1k output tokens; `high`: 3 rounds ~1.5k; `none`: 1 round; omitted (high): ~1.8k, 2.4k chars
  of reasoning. Chose `low`: tool investigation kept, reasoning cannot crowd out the per-turn cap.
- Debug agent sends a raw OpenAI-compatible body (`debug-agent-tools.ts:complete`), so effort goes
  in as `reasoning_effort`, per model, in `debugAgentModelControls()`.
- `AI_PROXY_DEFAULT_MODEL` var = retired qwen3; code default `DEFAULT_AI_PROXY_MODEL` = Llama 4 Scout
  (`toolCallSupport: limited`). Production KV override = Gemma 4 26B; staging KV = Claude Haiku 4.5;
  staging2 has no KV override (so it fell through to the retired var). Not in the deploy env
  forwarding list, so no GitHub Environment override path exists.
- Three inline readers of the var (`ai-proxy-model-resolution.ts`, `admin-ai-proxy.ts` x2,
  `runtime-agent-key.ts`) mixed `||` and `??`.
- Stored data (prod `sam-prod`, staging `sam-staging`, staging2 `sam2-staging2`; agent_settings,
  agent_profiles, skills, projects, platform_settings, users, triggers, all TEXT columns): one
  production agent profile uses `opencode-go/glm-5.2` (OpenCode gateway, not Workers AI: unaffected).
  No other references.
- GitHub Environment variables (staging, staging2, production) and repository variables: no
  `DEBUG_AGENT_MODEL` / `AI_PROXY_DEFAULT_MODEL` / `SAM_MODEL` override.

## Checklist

- [x] `DEFAULT_DEBUG_AGENT_MODEL` -> DeepSeek V4.1 Flash; explicit `reasoning_effort: 'low'` via `debugAgentModelControls()`
- [x] `DEFAULT_AI_PROXY_MODEL` -> Gemma 4 26B (registry `isDefault` moved with it); remove the `[vars]` entry; record in `OMITTED_WORKER_VAR_DEFAULTS` with a read-path probe
- [x] One resolver `resolveEnvDefaultAIProxyModel()` for all var readers
- [x] Review fix: model controls key on `target.model` (an admin OpenAI-compatible endpoint can substitute the model); test in `llm-endpoint.test.ts`
- [x] Prune qwen3-30b, glm-5.3-flash, glm-5.2 from `PLATFORM_AI_MODELS`; full 2026-11-20 list in the retired-model regression test; debug default added to the cross-file default test
- [x] Remove dead `glm-5.3-flash` operator branch and `glm-5.2` task-title branch (+ its test)
- [x] Update `.env.example`, `env.ts` comment, configuration + reporting-issues docs
- [x] Stored-data check (above) and GitHub Environment override check (above)
- [x] Staging: real feedback-triage diagnosis with no 410 (diagnosis 01M80NTEBWGKY6BR845VTFR2GQ, DeepSeek, 2 turns). sam-mode request: staging's KV pins Claude Haiku, so the changed default path is checked in production (below) and by the omitted-var proof test
- [x] Review fix (Codex P2): an admin KV default whose model is no longer in `PLATFORM_AI_MODELS` is ignored by one reader, `readAdminDefaultAIProxyModel()`, used by the proxy, the agent-key route and the admin GET; route tests through the real proxy prove the retired row falls back and a registry row still wins. Prod KV (Gemma) and staging KV (Haiku) hold live models today, so this protects self-hosted installs that saved Qwen 3 30B or GLM
- [x] Review fix: `ai-proxy-model-tiers.test.ts` read the default from the retired constant value (Llama 4 Scout); it now reads `DEFAULT_AI_PROXY_MODEL`
- [ ] After production deploy: next hourly triage diagnoses a signature with no 410, and one sam-mode request succeeds

## Acceptance criteria

- [x] Staging `POST /api/admin/observability/feedback-triage` produces a diagnosis (no HTTP 410): groupsFound 1, ideasCreated 1, groupsFailed 0
- [ ] A sam-mode AI proxy request succeeds in production after the deploy (staging KV pins Claude Haiku; no workspace was provisioned for this)
- [x] Unit: retired IDs cannot return; debug request carries model + `reasoning_effort: low`; override model gets no effort; omitted-var proof covers `AI_PROXY_DEFAULT_MODEL`
- [ ] Production: no "HTTP 410" `lastFailureReason` on incident rows updated after the deploy

## Post-merge verification ownership

The two unchecked production items are verified after the merge by the finishing task
01M80YTZ92X6WJYN772D9PTWH9, which reports the result to its parent and records it on PR #2972 and
on idea 01M77CKWZAGYYQF6AZCW1GS07P. The idea stays open until both are confirmed, so archiving
this file does not drop the tracking. If production still shows HTTP 410, that task files a new
backlog task rather than editing this archive.

## Staging evidence (2026-11-22)

- Deploy run 44980924533 (commit 9e5ba2bff) succeeded, smoke tests included. The deployed `sam-api-staging` has no `AI_PROXY_DEFAULT_MODEL` or `DEBUG_AGENT_MODEL` binding.
- Triage with no recent errors returned groupsFound 0. After one labelled probe client error was posted through `POST /api/client-errors`, triage returned groupsFound 1, ideasCreated 1, groupsFailed 0.
- The resulting `debug_diagnoses` row: model DeepSeek V4.1 Flash, 2 turns, 2,725 input / 1,500 output tokens. Its triage row has no failure reason.
- `GET /api/admin/ai-proxy/config` returned 200. It offers Workers AI models Llama 4 Scout, Qwen 2.5 Coder, Gemma 4 26B and DeepSeek V4.1 Flash, and no retired ID.
- Test artifact: the probe signature d022a34c and its idea in the staging Operations project.
