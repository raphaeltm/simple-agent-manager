# Staging debug-agent model request returns HTTP 410

## Problem

On staging (`sammy.party`), the scheduled/manual platform feedback triage fails every new
signature's diagnosis with `Debugging model request failed with HTTP 410`
(`apps/api/src/services/debug-agent-tools.ts`). The incident row records the failure and no idea
is filed, so new staging incidents never get an idea. Production showed no such failures between
2026-11-18 and 2026-11-20 (only one diagnosis was created in that window, so this is weak
evidence that production is unaffected).

## Context

Found 2026-11-20 while verifying PR #2954 (incident WATCHING disposition) on staging: a manual
`POST /api/admin/observability/feedback-triage` returned `groupsFailed: 1` with that reason.
The default model is `DEFAULT_DEBUG_AGENT_MODEL = '@cf/zai-org/glm-5.2'`; a 410 suggests a retired
model ID or a gateway route that no longer exists. Staging has no `debug*` platform setting
override; check `DEBUG_AGENT_MODEL` in the staging Worker vars and the GitHub Environment.

## Acceptance Criteria

- [x] Root cause of the 410 identified (model retired, override, or gateway).
- [ ] Staging triage creates an idea for a new signature again. (Verified under the superseding task; see its acceptance criteria.)
- [x] Production confirmed unaffected, or fixed in the same change. (Production was affected from 2026-11-22; fixed in the same change.)
- [x] If the model was retired, the catalog lifecycle rule (52) is followed.

## Resolution (2026-11-22)

Root cause: `DEFAULT_DEBUG_AGENT_MODEL` was `@cf/zai-org/glm-5.2`, which Cloudflare retired on
2026-11-20. Production failed the same way from 2026-11-22. Fixed by
`tasks/archive/2026-11-22-finish-retired-workers-ai-migration.md` (debug agent moved to DeepSeek
V4.1 Flash, retired IDs pruned under rule 52).
