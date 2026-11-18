# Agent model calls: let agents call Cloudflare-hosted models, with per-project access and budget

## Problem

Raphaël (2026-10-22, conversation task `01M5JBHKNC833EZC0HQW1SNM16`, design idea `01M5JBWGEP7MBHNXZ19450MV4B`)
wants coding agents to call any model in Cloudflare's managed-inference catalog (Workers AI models
Cloudflare runs itself: GLM, Gemma, gpt-oss-120b, Whisper, Clef, Clairic, …). Third-party proxied
models are excluded. Users choose which models agents may call. The choice is a project setting that a
profile or skill can override, and the most specific level wins. A budget caps spend. Cheap
classifier, decision (Clef family) and extraction (Clairic) models are on by default. Which model to
use when is left to the user's own steering docs.

He authorized implement → staging → production, and required several UI/UX iterations with agent
reviews before staging: "make sure that the user experience is really fucking solid", especially the
selection UIs.

## Research findings

### Cloudflare catalog (verified live 2026-10-22, staging account)
- `GET /accounts/{id}/ai/models/search?per_page=100` returns 73 models in one page. All are `source: 1`,
  `@cf/*`, with no third-party models. `result_info.total_count` (326) is misleading: page 2+ is empty.
  The fetch must loop until a short page, but must not trust `total_count`.
- Entry: `name` (model id), `description`, `task.name`, and `properties[]`. Properties include
  `price: [{unit, price, currency}]`, `context_window`, `beta`, `partner`, `terms`, `info`, `vision`,
  `reasoning`, `function_calling`, `lora`, `require_workers_paid`, `async_queue` and `realtime`.
- Price units: per M input / output / cached-input tokens; per audio minute (and websocket);
  per 1k characters; per 512×512 tile; per step; per inference request. Some models have no price,
  and some show `0 USD per step`.
- Clef / Clef-flash / Clef-omni / Clairic report `task.name = "Text Generation"`, so SAM needs a
  category override (decision / extraction) by id prefix.
- Task names: Text Generation 39, Text-to-Image 10, Text Embeddings 7, ASR 5, TTS 4,
  Text Classification 2, Image-to-Text 2, Translation 2, Image Classification 1, "Dumb Pipe" 1.
- `GET /accounts/{id}/ai/models/schema?model=` returns `{input, output}` JSON Schema (clef ≈ 5 KB).
  Output schema carries `contentType`.
- Binding alternative: the `Ai` binding exposes `models(params)` (workers-types `index.d.ts:11282`),
  so the catalog can be listed without new token permissions. The documented self-host token has no
  "Workers AI" permission (`apps/www/.../guides/self-hosting.mdx:44-58`).

### SAM code
- **MCP tools.** The definitions are untyped objects in `apps/api/src/routes/mcp/tool-definitions-*.ts`,
  combined into `MCP_TOOLS` (`tool-definitions.ts:63-87`). Dispatch is a 146-case switch in
  `routes/mcp/index.ts:299-675` (708 lines, over the rule 18 limit). The handler signature is
  `(requestId, args, tokenData: McpTokenData, env) => Promise<JsonRpcResponse>`. Results are
  `jsonRpcSuccess(id, {content:[{type:'text', text}]})` (`_helpers.ts:36-52`). There are no
  conditional tools, so gating happens in the handler. Tests: `tests/unit/routes/mcp.test.ts:770-832`
  (name list and schema check) and the workerd vertical slice `tests/workers/mcp-trigger-tools.test.ts`
  (`storeMcpToken` + `SELF.fetch`). `vitest.workers.config.ts` has no AI binding.
- **Token context.** `McpTokenData` (`services/mcp-token.ts:35-52`) carries taskId ('' for direct
  chat), contextType, projectId, userId, workspaceId and agentSessionId?.
- **Profile and skill of a running agent.** `resolveWorkspaceRuntimeAssetContext`
  (`services/workspace-runtime-assets.ts:194-244`) checks the agent session, then the task row, then
  the workspace hint, and validates project ownership. `tasks.agent_profile_hint` holds the resolved
  profile id and `tasks.skill_id` the skill.
- **Profiles and skills** share base field plumbing in `services/profile-fields.ts`
  (`BaseProfileRow`, `toBaseProfileFields`, `baseProfileInsertValues`, `BASE_PROFILE_UPDATE_FIELDS`).
  Writes need `project:update` (owner/admin) and are validated with Valibot (`schemas/agent-profiles.ts`,
  `schemas/skills.ts`). Shared types: `packages/shared/src/types/agent-settings.ts` (`AgentProfile`
  180, Create 211, Update 237, `AgentSkill` 314, Create 323, Update 330).
- **Project PATCH gotcha.** `PATCH /api/projects/:id` re-checks GitHub installation ownership
  (`routes/projects/project-update.ts:242-251`), so a non-owner admin can get a 404. A dedicated
  `/api/projects/:id/agent-models` route avoids this.
- **Admin settings registry** (`services/admin-settings-registry.ts`). Types are boolean, integer,
  string, string-list and enum; there is no decimal, so money is stored in integer cents or µUSD.
  The category list is a closed union that is copied into `apps/web/src/lib/api/admin-settings.ts:6-13`.
  The admin UI renders settings automatically. `admin-settings-foundation.test.ts:48-49` hard-codes the
  registry length (44). `pnpm quality:runtime-tunables` forbids new scalar Env vars.
  Settings resolve through `resolveAdminSetting(env, name)` with a 60s isolate cache.
- **Budget primitives.** `AiTokenBudgetCounter` DO counters are daily and token-based. No per-project
  spend is recorded anywhere. Rule 69 requires the cap in the final atomic write, tested with a real
  DB race (`tests/helpers/sqlite-d1.ts`).
- **Workers AI calls.** `fetchWorkersAIChatCompletion` (`ai-proxy-shared.ts:456`) goes through the
  gateway with `CF_API_TOKEN` (`/workers-ai/v1/chat/completions`). Binding calls (`env.AI.run`)
  bypass the gateway. A raw-model gateway path is `…/workers-ai/{model}`, falling back to REST
  `…/ai/run/{model}`.
- **Workspace file transfer** (`routes/mcp/library-tools.ts:116-226`): `resolveWorkspaceVmUrl`,
  `downloadFromWorkspace` and `uploadToWorkspace`, signed with a terminal JWT through
  `fetchNodeAgent`. `upload_to_library` already pulls workspace files server-side, so binary model
  inputs and outputs can move without passing through the LLM.
- **Web.** `ProjectSettings.tsx` (503 lines; the Agents tab is `ProjectSettingsAgents`, :219).
  `ProfileFormDialog.tsx` (728 lines, accordion `Section`s). `SkillFormDialog.tsx` (229 lines, flat
  form). The closest inherit/custom pattern is the GitHub CLI policy select in ProfileFormDialog
  (571-623). The best search + multi-select template is `components/compute-pool/MachinePicker.tsx`.
  There is no Switch or Checkbox primitive in `packages/ui`. TanStack Query options live in
  `lib/query-options/<domain>.ts` with keys `['auth', scope, domain, op, …]`, and API modules in
  `lib/api/<domain>.ts`.
- **Docs.** `apps/www/.../guides/agents.md` (MCP tools table :363-404, profiles :174-206),
  `concepts.mdx`, `guides/admin-settings.md`, `reference/configuration.md` and
  `guides/recent-product-changes.md`. A new guide page needs an `astro.config.ts` sidebar entry.

### Design decisions
1. **Storage.** Nullable JSON array columns `agent_models_json` on `projects`, `agent_profiles` and
   `skills`. NULL means inherit (for a project: SAM defaults), `[]` means no models. Budget is
   `projects.agent_models_monthly_budget_cents` (NULL means the platform default). Additive
   migration 0204, ALTER TABLE ADD COLUMN only.
2. **Resolution.** skill → profile → project → SAM defaults, the first non-NULL wins. The result is
   intersected with the live catalog, so unknown or retired ids drop out.
3. **Defaults.** Category-based: decision (`@cf/cloudflare/clef*`), extraction
   (`@cf/cloudflare/clairic*`), classification (Text/Image Classification). Admin-editable
   string-list setting.
4. **Budget.** Per project per UTC month, in integer micro-USD. Usage tables
   `agent_model_monthly_usage` (reserved/spent/calls per project-month) and
   `agent_model_usage_by_model`. Each call does an atomic conditional reserve (`UPDATE … WHERE spent +
   reserved + ? <= limit`), the call, then a settle with a cost computed from catalog prices and the
   reported usage. Unpriced models are charged a configurable per-call estimate.
5. **Calls** go through the existing AI Gateway (policy 7b6f6fa8) via the Workers AI binding
   (`env.AI.run(model, input, {returnRawResponse, gateway})`). Calls carry gateway metadata and have a
   configurable timeout. Tests stub the binding.
6. **Binary I/O.** `{"$file": "<workspace path>"}` placeholders in input are read from the workspace
   (reusing the library-tools transfer helpers). Binary outputs and oversized JSON are written into
   the workspace (default dir `.ai-outputs/`) and returned by path.
7. **Who can edit.** Model access and budget are human-controlled (REST plus UI, `project:update`).
   The MCP profile/skill tools do not get the field.
8. **Kill switch and limits** live in the admin settings registry (new category "AI models").
9. **Catalog flags not modelled, on purpose.**
   - `require_workers_paid` (8 models, e.g. GLM 5.3, Kimi, DeepSeek v4) gets no badge or refusal. Every SAM deployment already needs the Workers Paid plan (`self-hosting.mdx`: Durable Objects and Containers), so these models are always callable, and a badge would be noise on the hosted platform.
   - `async_queue` (19 models) marks an optional batch API. Synchronous `env.AI.run` still works for those models (gpt-oss, Whisper), so nothing is refused.
   - Websocket-only realtime models are refused (`unsupported_model`).

## Implementation checklist

### Refactors (separate commits, rule 18)
- [x] Split `routes/mcp/index.ts` dispatch (move simple one-line tool cases into handler maps) so the file is < 500 lines
- [x] Extract workspace file-transfer helpers from `routes/mcp/library-tools.ts` into a shared module (library tools import them)
- [x] Move `ProjectSettingsAgents` out of `ProjectSettings.tsx`
- [x] Split `ProfileFormDialog.tsx` (extract accordion `Section` + a section) before adding a field

### Shared (`packages/shared`)
- [x] `types/agent-models.ts`: categories, catalog entry, settings/usage responses, update request
- [x] Add `agentModels: string[] | null` to AgentProfile/AgentSkill + create/update request types
- [x] Constants: defaults, id pattern, category mapping helpers, limits defaults
- [x] Pure helpers (catalog normalization, price parsing, cost estimation, resolution) with unit tests

### API (`apps/api`)
- [x] Migration 0204: columns + usage tables; Drizzle schema
- [x] Admin settings: `aiModels.*` (enabled, defaultCategories, default/max monthly budget, call timeout, max input bytes, max inline output bytes, unpriced call estimate, reservation output tokens, catalog cache TTL); new category in API + web lists; bump registry-length test; docs table
- [x] Catalog service: list (binding `env.AI.models()` with REST fallback) + normalize + KV/isolate cache; schema fetch (REST, cached), graceful when unavailable
- [x] Access resolver (skill → profile → project → defaults) via `resolveWorkspaceRuntimeAssetContext`
- [x] Budget service: reserve (atomic conditional UPDATE), settle, release; usage read
- [x] Model runner: gateway REST call, timeout, response parsing (JSON / binary), `$file` input resolution, output saving, cost settlement
- [x] MCP tools `list_ai_models`, `run_ai_model` (definitions, handlers, dispatch, onboarding guide line, mcp.test name list)
- [x] REST: `GET /api/agent-models/catalog`, `GET/PUT /api/projects/:id/agent-models` (owner/admin write)
- [x] Profile/skill create/update/read carry `agentModels` (Valibot validated, unknown ids rejected)
- [x] Tests: resolution cascade (absent/present per layer, real create paths), budget race (sqlite-d1), cost estimation per unit, catalog normalization fixture, MCP vertical slice (enabled/disabled/budget exhausted/happy path/$file/binary output), route auth (owner/admin vs maintainer/viewer vs non-member)

### Web (`apps/web`)
- [x] API module + TanStack query options/hooks for catalog + project settings
- [x] Shared picker component (search, grouped categories, toggles, price, badges, counts, reset)
- [x] Project settings → Agents tab: "AI models agents can call" section with budget + usage + picker
- [x] Profile form: AI models field (inherit project / custom)
- [x] Skill form: AI models field (inherit / custom)
- [x] Behavioral tests (picker toggling/search, inherit/custom switch sends payload, save flows)
- [x] Playwright visual audits (normal, long text, many, empty, error; mobile + desktop)
- [x] UI/UX iteration rounds with agent reviews (≥2 rounds) before staging: round 1 (2 reviewers), round 2 fixes, round 3 polish, final round-4 review (SHIP) plus follow-ups (Enter saves the limit, "N more models")

### Docs
- [x] New guide `guides/ai-models-for-agents.md` + sidebar entry
- [x] Update `guides/agents.md` (MCP tools table, profiles), `concepts.mdx`, `guides/admin-settings.md`, `reference/configuration.md`, `guides/recent-product-changes.md`

### Staging
- [x] Deploy branch, configure project models + budget via UI as smoke user (runs 39872920686, 39879400025; `staging-agent-models.spec.ts` configure mode)
- [x] Real agent session calls `list_ai_models` + `run_ai_model` (Clef-flash decision, a text model); disabled model rejected; usage updates in UI. Session `160d9aed…` covered Clef-flash, gpt-oss-20b, FLUX (saved file), ResNet-50 via `$file`, and a refusal; D1 accounting was exact; the skill cascade was checked in session `2119d4a1…`.
- [x] Clean up staging resources (3 workspaces deleted, sessions stopped, skill deleted, project settings reset)

## Acceptance criteria
- [x] Agents can list enabled models and call them through MCP; output returned; cost recorded
- [x] A model not enabled for the effective layer is refused with a message naming where to enable it
- [x] Project/profile/skill cascade: most specific non-null layer wins; NULL inherits; [] disables all
- [x] Defaults (no setting anywhere): Clef family, Clairic and classification models enabled
- [x] Budget: calls refused once the monthly project budget is used; concurrent calls cannot overspend past the cap (real DB race test)
- [x] Only Cloudflare-hosted `@cf/`/`@hf/` catalog models can be enabled or called
- [x] Project settings UI: budget + usage + model picker, solid on 375px and 1280px, reviewed by UI/UX agents in ≥2 iterations (3 iterations + final review, SHIP)
- [x] Profile and skill editors: inherit/custom model access, saved and read back
- [x] Binary inputs via workspace `$file` and binary outputs saved to the workspace
- [x] Docs updated; staging end-to-end verified with a real agent session

## References
- Idea `01M5JBWGEP7MBHNXZ19450MV4B` (design), idea `01M2TSPBDV1GDVRN9CS5A89EMH` (Jev research)
- Rules: 18, 31 (migrations), 41/50 (row fault isolation), 43, 59, 60, 62, 65, 69, 73 (stored override layer), 74

## Implementation notes (2026-10-22)

- **Catalog via the Workers AI binding.** `env.AI.models()` lists the catalog and `env.AI.run(model, input, {returnRawResponse, gateway})` makes calls. That needs no new API-token permission, and calls go through `AI_GATEWAY_ID`. Only model schemas use REST with `CF_API_TOKEN`, and that is optional.
- **Not in the "concepts" doc.** `concepts.mdx` was not changed. Profiles and skills are documented in `guides/agents.md`, which links the new guide.
- **Agents cannot change model access.** The MCP profile and skill tools allowlist their fields; tested.
- **Default call timeout is 55 s.** It sits below Codex's 60 s default MCP tool timeout.
- **Stale model ids are kept, not stripped.** Access intersects the live catalog at call time. The UI shows "No longer available" with a Remove button.
- **Model id pattern tightened.** Each segment now has to start with an alphanumeric, so `@cf/../x` is rejected. The unit-test agent found this.
- **Test fixtures updated.** The webhook-trigger test's hand-written projects table gained the 2 new columns. The cf-container contract test now reads `services/workspace-file-transfer.ts`. The project-agent-defaults test now reads `ProjectSettingsAgentsTab.tsx`.

## Staging findings (2026-10-23)
- **Fixed: the picker could start empty.** Choosing "Choose models" in a fresh skill form before the catalog and project settings had loaded opened the picker with nothing turned on. The picker now waits for the inherited selection (`selectionReady`), in 3f1743634, with a regression test that controls both loads.
- **Fixed: the section was buried.** AI Models sat below the long per-agent overrides list; it now comes second on the Agents tab (141259365).
- **Not this PR: rollout interruption.** A deploy's vm-agent container rollout (v1325) interrupted an Instant session mid-prompt. This is known (`tasks/backlog/2026-07-20-instant-ping-container-died-midsession.md`); the retry after the rollout passed.
- **Upstream behaviour, surfaced correctly.** FLUX sometimes rejects harmless prompts with `400 NSFW content detected`. The error is returned to the agent and not charged.

