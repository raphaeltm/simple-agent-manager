# AI-Slop Debt Burn-Down (single PR)

## Problem

PR #1784 shipped the prevention side of the quality program: deterministic ratchets that freeze runtime-boundary and formatting debt at current levels. Nothing reduces the frozen debt. SAM idea `01KZPZCG3CP9XFGH5PRXE58Q6Y` holds the full research-backed cleanup plan (built 2026-08-10 from five local research agents + direct checker runs). This task executes that plan's Phases 0-4 in one PR, driving the blocking type-boundary classes to zero, promoting the advisory gates to blocking, and clearing the production-relevant lint debt.

Raphaël's instruction: single PR; all code production dispatched to smaller models; staging verification must include dispatching a real agent and getting a good response thread; then merge.

## Research findings (evidence in idea 01KZPZCG3CP9XFGH5PRXE58Q6Y)

- Blocking baseline (`scripts/quality/type-boundary-baseline.json`): 24 `c.req.json<T>()`, 23 typed `JSON.parse as T`, 9 local record guards, 0 `as any`. Site-exact inventory calibrated to those counts.
- Report-only populations (90 `as Record<string, unknown>`, 132 `as unknown as`): full 222-site classification → only 28 genuinely fixable; 109 sanctioned DO-stub/env patterns; 50 plain TS/library friction; rest benign/test.
- Security-relevant traced gap: `services/deployment-routing.ts:334,341` casts release manifests without running the existing `DeploymentManifestSchema` (`packages/shared/src/deployment-manifest/validate.ts`); write path `compose-publish-release-callback.ts:233-264` stores VM-agent-submitted body mostly unvalidated.
- Semantic checker (`pnpm quality:runtime-boundary-semantics --details`): 45 advisory diagnostics in apps/api/src (39 blind-external-payload, 6 unvalidated-row); promotion blocked on 20% sampled FP rate — clearing true positives + discriminating sanctioned coercions unblocks it.
- Lint (fresh run): 2,510 warnings, 100% non-blocking. 84.5% of 1,655 `no-non-null-assertion` and 638/639 `no-explicit-any` are test files. Production: 256 `!` in src, 1 `any`. 61 `no-var` (apps/www) verified auto-fixable. 64 jsx-a11y (existing backlog task 2026-04-01). Dead root `.eslintrc.cjs` unloaded under ESLint 9 (`.claude/rules/48` references it). Husky already removed.
- `packages/shared` has NO validation helper module (blocks `types/task.ts:137` guard migration).
- File-size checker does not scan `scripts/` — `scripts/deploy/sync-wrangler-config.ts` (834 lines) escapes the >800 gate.
- `sam/*` rule exemptions in `packages/eslint-plugin-sam/rules.manifest.json` expire 2026-10-09; format baseline review expires 2026-11-07.

## Scope decisions

- IN: plan Phases 0-4 + `check-file-sizes.ts` scripts/ extension.
- DEFERRED with rationale: the 2,390-file mass reformat (own deadline; conflicts with every open branch; ratchet blocks regressions meanwhile) and the 154-file split program (structural refactors already tracked in `tasks/backlog/2026-04-03-split-oversized-files.md`; not boundary slop). `sync-wrangler-config.ts` gets a documented FILE SIZE EXCEPTION (deploy-critical; splitting it in the same PR as a staging-gated change adds deploy risk); its split stays in the 2026-04-03 backlog task.
- Test-file `!`/`any` populations de-scoped by decision: test-double typing is idiomatic; churn far exceeds value. Warn-scope for these two rules narrowed to non-test files so the counts become actionable.
- Mid-PR file-size regressions: this PR's validation additions plus prettier normalization pushed 8 previously-compliant files past the 800-line hard gate (`.claude/rules/18-file-size-limits.md`). 7 were split back under the limit in-PR (`workspace/index.tsx`, `ai-proxy.ts`, `GlobalCommandPalette.tsx`, `ChatFilePanel.tsx`, `agent-loop.ts`, `observability.ts`, `reconciliation.ts`); `sam-cli.ts` received a documented FILE SIZE EXCEPTION instead of a split — it is a hand-maintained OpenAPI document literal with a byte-exact generated-artifact contract (`openapi:check` diffs it against the checked-in `apps/api/openapi/sam-cli.openapi.json`), so splitting the spec literal across modules would add import complexity and artifact-drift risk without a reviewability benefit.

## Implementation checklist

### Phase 0 — security-first boundary fixes

- [x] `deployment-routing.ts:334,341` validate manifests via `DeploymentManifestSchema`/`validateManifest`; harden write path in `compose-publish-release-callback.ts`; discriminating regression test (unvalidated `routes` array must be rejected, valid manifest control passes)
- [x] `session-snapshots.ts:169` schema for VM-agent-submitted `SessionSnapshotManifest` sub-shapes
- [x] `local-forward.ts:115-117` validated body (null body → 400, not 500)
- [x] `github-trigger-filter.ts` `parseWebhookPayload` → Valibot transcription of `GitHubWebhookEvent`
- [x] Review undocumented `eslint-disable no-control-regex` at `routes/mcp/_helpers.ts:177` — document or fix

### Phase 1 — blocking classes 24/23/9 → 0

- [x] WP-1: 11 admin-route `c.req.json<T>()` → `jsonValidator` (admin-ai-allowance, admin-ai-proxy ×2, admin-quotas ×2, admin-runtime-controls, admin-sandbox ×4, admin-trials) + 400-path tests
- [x] WP-2: 13 user-facing sites → `jsonValidator` (knowledge ×4, library ×2, policies ×2, orchestrator, project-agent, sam, agent-credential-setup-sessions, mcp/index JSON-RPC envelope) + 400-path tests
- [x] WP-3/4/5/6: all 23 typed `JSON.parse` sites → `parseWithSchema`/`parseJsonRecord`/`readResponseJson` per cluster map in `.do-state.md`; dedup the duplicate `GitHubCliPolicy` parser (agent-profiles.ts:36 / github-cli-policy.ts:39)
- [x] WP-6/8/9/10: all 9 local record guards → shared helpers; add minimal dependency-free record predicate to `packages/shared` first; verify call sites where guards currently accept arrays (`row-schemas/messages.ts:114`, `document-card-data.ts:57`); non-throwing predicate for `canonical-json.ts`
- [x] Zero endgame: baseline counts → 0; `sam/no-unvalidated-request-json`, `sam/no-unsafe-json-parse-assertion`, `sam/no-local-record-guard` → `error` in `eslint.config.mjs`; manifest exemptions removed

### Phase 2 — semantic diagnostics 45 → 0 + checker promotion

- [x] WP-7: DO SQLite row-mapper cluster (project-agent, sam-session, project-orchestrator ×2, reconciliation:242, services/diagnosis-runner:36) — shared Valibot row schemas (`ConversationRow`/`MessageRow` identical across two DOs), rule-50 per-row fault isolation, good/bad/good regression tests
- [x] Remaining blind-external-payload sites (VM-agent callback routes, setup.ts, devcontainer-configs, webhook-trigger-store, node-selector, origin-ca-certificates, platform-config-validation, github-app ×3, mappers, vm-agent-container-runtime, debug-agent, stuck-tasks, credential-setup-session)
- [x] `useNotifications.ts:147` WS frame schema (apps/web)
- [x] `pnpm quality:runtime-boundary-semantics` → 0 diagnostics; promote checker to blocking for apps/api/src; update `runtime-boundary-semantic-evidence.json` decision block

### Phase 3 — cast hygiene

- [x] Remaining category-D casts of the 28 not covered above
- [x] Fix `ListProjectsResponse.projects` type (`Project[]` → `ProjectSummary[]`; removes double-casts at `projects/crud.ts:518` + `useProjectData.ts:36`)
- [x] Amend `.claude/rules/51-runtime-boundary-validation.md` with 3 sanctioned bullets (CSS-var-as-number casts; third-party generic container/lib-type-gap casts; self-constructed log/display payload widening)
- [x] Lower report-only baseline counts to the post-fix floor

### Phase 4 — lint debt

- [x] `eslint --fix` 61 `no-var` in apps/www; hand-fix 7 `no-unused-vars` + 2 `no-empty` + the 1 production `any`
- [x] Delete dead root `.eslintrc.cjs` (verify flat-config parity for `react/jsx-no-constructed-context-values` first); update `.claude/rules/48` reference
- [x] a11y: fix all 64 jsx-a11y warnings; promote `jsx-a11y/*` to error; archive `tasks/backlog/2026-04-01-promote-a11y-eslint-to-errors.md`
- [x] Production `no-non-null-assertion` burn-down (256 src sites; top `services/cron-utils.ts` 31) with real narrowing, no new suppressions
- [x] Scope `no-non-null-assertion`/`no-explicit-any` warn to non-test files; document decision
- [x] Review 35 `react-hooks/exhaustive-deps` suppressions against rule 48; fix unsafe ones, document safe ones
- [x] Scripts: 2 `scripts/quality` typed parses → `as unknown` + guard; `check-do-wall-time.ts:160` guard
- [x] Extend `check-file-sizes.ts` to scan `scripts/`; add documented FILE SIZE EXCEPTION to `sync-wrangler-config.ts`

### Cross-cutting

- [x] All baseline files lowered in this PR (type-boundary, semantic evidence, format count for touched files)
- [x] Playwright visual audit for changed apps/web surfaces (mobile 375 + desktop 1280, overflow assertions)
- [x] Docs sync: rules 48/51 updates included; no stale references to removed config

## Acceptance criteria

- [x] `pnpm quality:type-boundaries`: blocking counts 0/0/0/0; report-only counts at recomputed floor; `sam/*` rules at `error` with zero inline suppressions added
- [x] `pnpm quality:runtime-boundary-semantics`: 0 diagnostics, blocking for apps/api/src
- [x] `pnpm lint`: 0 errors; warnings reduced to the documented floor (test-file populations excluded by scoping decision); jsx-a11y at error with 0 violations
- [ ] `pnpm check:fast && pnpm typecheck && pnpm test && pnpm build` all green
- [x] No behavior regressions: invalid-body paths return structured 400s with tests; guard swaps verified at call sites
- [ ] Staging deploy green; regression checklist passes; **a real agent session dispatched on staging returns a good multi-message response thread**; staging nodes/workspaces deleted afterward
- [ ] PR merged with full Specialist Review Evidence; production deploy monitored to success

## References

- SAM idea `01KZPZCG3CP9XFGH5PRXE58Q6Y` (cleanup plan, full site lists)
- SAM idea `01KZK7TFEX05MVMDKZWKABBNS7` (prevention program)
- `.claude/rules/51-runtime-boundary-validation.md`, `02-quality-gates.md`, `17-ui-visual-testing.md`, `28-credential-resolution-fallback-tests.md`, `50-list-read-row-fault-isolation.md`
- `tasks/active/2026-08-09-deterministic-runtime-boundary-quality.md` (prevention task; this is its reduction companion)
