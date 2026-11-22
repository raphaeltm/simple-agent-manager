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
- [ ] Staging: real feedback-triage diagnosis with no 410; one sam-mode AI proxy request
- [ ] After production deploy: read deployed vars; next hourly triage diagnoses a new signature with no 410

## Acceptance criteria

- [ ] Staging `POST /api/admin/observability/feedback-triage` produces a diagnosis (no HTTP 410)
- [ ] A sam-mode AI proxy request using the default model succeeds on staging
- [x] Unit: retired IDs cannot return; debug request carries model + `reasoning_effort: low`; override model gets no effort; omitted-var proof covers `AI_PROXY_DEFAULT_MODEL`
- [ ] Production: no "HTTP 410" `lastFailureReason` on incident rows updated after the deploy
