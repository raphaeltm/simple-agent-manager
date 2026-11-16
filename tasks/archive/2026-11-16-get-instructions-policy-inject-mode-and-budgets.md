# get_instructions: per-policy inject mode and size budgets (stream B)

SAM task 01M7HX10X0732T53023VCYA1M2. Idea 01M6SPMDHY2F2BPVD933B9FYJZ (plan: library file
01M6WT2SXVVRZEBFJP2G62YV7Y), review: idea 01M7H32EK6S4E31EHWVSJSENR5 note 01M7H3Y1C4GX1V2A8ZNZ32MQXE.
Coordination channel `feature.agent-context`. Branch `sam/stream-b-agent-context-cya1m2`.

## Problem

`get_instructions` returned 129,317 characters in the SAM project on 2026-11-16 (policies 72,696,
knowledge 39,135, instructions ~6.4K). Claude Code spills it to a file. Nothing bounds its size.

Raphaël's acceptance rule: nothing leaves always-loaded context unless it certainly loads in the
right context or is enforced programmatically. So the plan's tier-overflow design (rules shown as
titles past a 24K budget) is replaced with an explicit per-policy inject mode:

- `pinned` (default for every existing and new policy): always injected in full.
- `on_demand`: always listed by title and id in a disclosed index; injected in full only when it
  ranks as relevant to the task, inside a configurable budget (rule 65).

Deploying must not change which policy text any session receives. Agents change no policy or
knowledge values.

## Research findings

- Policy injection: `apps/api/src/routes/mcp/instruction-tools.ts` (`handleGetInstructions`, 403
  lines) and `instruction-formatting.ts` (`formatPolicyDirectives`, 294 lines). No size constant.
- Policy storage: ProjectData DO SQLite `project_policies`
  (`packages/project-data/src/do/policies.ts`, row schema `do/row-schemas/policies.ts`,
  migrations in `do/migrations.ts`, last is `079-chat-session-sequence-watermark`). Migration 034
  is the additive precedent (`ALTER TABLE ... ADD COLUMN`).
- Policy writers: MCP `policy-tools.ts` (add/update), REST `routes/policies.ts` (POST/PATCH),
  /sam `durable-objects/sam-session/tools/add-policy.ts` (create only; throwaway surface per policy
  5cb362e8; it inherits the pinned default), DO `createPolicy`/`updatePolicy`.
- `updatePolicy` merges with `??` per field; the new field must too (rule 73: absence must not
  overwrite).
- Rule 73 stored-override section does not apply as written: inject mode is not an override of a
  lower layer. `NOT NULL DEFAULT 'pinned'` is the intended value for every row, and an unknown or
  missing value parses to `pinned` (fail toward full injection).
- Knowledge: ranked + per-entity capped in SQL (`getAllHighConfidenceKnowledge`), entity index
  fetched independently. Observations are capped at 1,000 chars at write time
  (`KNOWLEDGE_DEFAULTS.observationMaxLength`), so a per-observation truncation is not needed.
- Admin settings registry: `apps/api/src/services/admin-settings-registry.ts`; definitions files
  per area; `resolveAdminSettingDetailsMany` resolves several with the per-isolate cache.
- Web: `apps/web/src/pages/AgentContextPage/PoliciesTab.tsx` (401 lines). Edit/delete are not
  role-gated in the UI; REST enforces `project:update`.
- Instruction trims: `create_project_event_subscription` description already carries the CI/PR
  filter details and the reconcile-before/after steps; the always-sent CI-wait paragraph repeats
  them. The resume/renew/fallback paragraph is NOT fully in any tool description, so it stays.
  Knowledge "when to save/search" guidance is trigger guidance needed before loading a tool, so it
  stays.

## Design decisions

- Settings (admin registry, category Agents): `instructions.totalMaxChars` 60,000,
  `instructions.knowledgeMaxChars` 20,000, `instructions.onDemandPolicyMaxChars` 12,000,
  `instructions.onDemandPolicyMaxPerCategory` 5, `instructions.onDemandPolicyMinRelevance` 2.
- Total guard: if over total, trim knowledge (ranked block, never the index) then on-demand full
  text, but only when trimming can reach the budget. If pinned + fixed sections alone exceed it,
  send everything, `log.warn`, add one instructions line. Never drop silently.
- Fault isolation: budget pass failure falls back to full rendering + `log.error`.
- Phase 0 telemetry: `mcp.get_instructions.size` log on every call.

## Implementation checklist

- [x] shared: `POLICY_INJECT_MODES`, `PolicyInjectMode`, `injectMode` on policy types; shared
      policy-line renderer used by API and web (one implementation)
- [x] DO migration `080-policy-inject-mode` (additive), row schema, create/update/list carry it
- [x] Client + DO RPC signatures carry `injectMode`
- [x] MCP `add_policy`/`update_policy` accept `injectMode` (definitions + handlers); tool-group
      summaries mention it
- [x] REST POST/PATCH accept `injectMode`; Valibot schemas
- [x] Settings definitions file + registry + `AdminSettingName`
- [x] Pure selection module: rank on-demand policies, budget, per-category cap, index rendering
- [x] Knowledge size budget with disclosure in index lead-in
- [x] Total guard + warning line + log; size telemetry log
- [x] Instruction trim of CI-wait paragraph: tried, then reverted because `mcp-ci-wait-guidance.test.ts` requires the guidance in both entry points (existing guard). No instruction sentence removed.
- [x] Web Policies tab: inject-mode control + injected size per policy + summary, phone usable
- [x] Docs: `apps/www/.../architecture/overview.md`, `reference/api.md` or wherever get_instructions
      is described; admin settings docs if they list settings
- [x] Tests (below)
- [x] Playwright visual audit (375 + 1280), screenshots posted

## Tests

- Workers (real Worker + ProjectData DO, `apps/api/tests/workers/`): policies created through MCP
  `add_policy`; settings resolved through the real resolver; every policy id exactly once;
  all-pinned byte-identical to pre-change rendering at max and default budgets; determinism;
  unpinned in index; matching unpinned in full; non-matching indexed and fetchable via get_policy;
  admin-setting override changes output; pinned-over-budget warning line.
- DO: migration default pinned for existing rows; create default pinned; update without
  injectMode preserves it; explicit set both directions.
- Unit: selection ranking skew (rule 65), per-category cap with control, knowledge budget drops
  lowest-ranked first and discloses count.
- Web unit test for the control reaching `updatePolicy` with `injectMode`.

## Acceptance criteria

- [x] With every policy pinned, policyDirectives is byte-identical to today's at any budget
- [x] Every applying policy id appears exactly once (full or indexed)
- [x] Unpinned policies listed with counts and fetch instructions; relevant ones in full
- [x] Pinned-over-budget: sent in full, warning log, one instructions line
- [x] Knowledge budgeted with index kept and dropped count disclosed
- [x] Project admin can change inject mode from the Policies tab on a phone; injected size shown
- [x] No policy or knowledge value changed
- [ ] Measured sizes reported (pending staging, Phase 6): before, after all pinned, staging partial-unpin simulation

## Review outcomes (Phase 5)

- constitution-validator: no HIGH. Fixed: budget values clamped to each setting's range (default on out-of-range), constants documented, typed category tiers.
- ui-ux-specialist: no HIGH. Fixed: honest copy for inactive/expired policies, only text dimmed on inactive cards, aria-disabled (focus kept) with stable labels, optimistic accepted mode, per-project key reset, solid `sam-raised` selected state with a check icon, policy title in the group label, shorter header.
- doc-sync-validator: no HIGH. Fixed: over-budget wording, rollback wording, distinctive-word wording, idea title in relevance text, settings table row, reverted unrelated list renumbering, mission-dispatch note, stale policy instruction sentence.
- task-completion-validator: WARN. Fixed: checklist, tests for size/warn logs, fallback, on-demand trim and floor branches, range clamp; note wording. Mission dispatch still inherits every policy in full (fails toward more text; documented).
- cloudflare-specialist: no HIGH. Fixed: note wording, trim cliff (bounded passes), DO-side injectMode guard. Kept: optional content stays in the over-budget branch (coordinator's stated expectation, documented); unit mix documented.
