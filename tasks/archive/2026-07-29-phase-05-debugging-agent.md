# Phase 0.5 Standalone Deployment Debugging Agent

## Problem

Implement canonical idea `01KXN5YQ9TGN29ZZ8DP2DKAKHN` Phase 0.5: a superadmin-only, read-only Worker agent that correlates admin errors, Cloudflare logs, and bounded entity state into a redacted actionable diagnosis. This is standalone Loop A and the foundation for later Loop B; cross-instance transport, registration, crypto, quarantine, anonymous intake, and Inbox UI are out of scope.

## Research Findings

- Follow the fixed tool-registry loop in `apps/api/src/durable-objects/sam-session/agent-loop.ts`; do not use a VM, workspace, Mastra, or the prototype harness.
- Reuse `queryErrors`, `getHealthSummary`, `getErrorTrends`, and `queryCloudflareLogs` from `services/observability.ts`; Cloudflare credentials remain server-side.
- Replace the shallow sensitive-key filter with recursive deterministic redaction for keys, Anthropic/GitHub tokens, JWTs, PEM, Authorization, long hex, and long base64. Redact every tool result before model context.
- Expose only allowlisted projections from `nodes`, `workspaces`, `tasks`, `agent_sessions`, and `session_summaries`, bounded around the selected error/window.
- Extend `ai-token-budget.ts` and `AiTokenBudgetCounter` with an independent deployment-feature daily key plus per-run turns and token ceilings.
- Default to registered `@cf/zai-org/glm-5.2` via `DEBUG_AGENT_MODEL`. Gemma 4 26B has generic tool-call evidence but no diagnosis-quality comparison sufficient to override the canonical default.
- Retained GLM failure evidence requires exact Gateway payload tests and bounded secret-safe upstream diagnostics.
- `/api/admin/*` is already superadmin-gated; `/admin/errors` is the primary UI. Ideas are `tasks` rows with `status='draft'`; persisted diagnosis attachments need a main-D1 record and save-as-Idea should require an explicit project.
- Rules require realistic vertical-slice tests, mobile/desktop visual audit, non-empty staging data, real budget enforcement, and zero feature-flow errors.

## Implementation Checklist

- [x] Add shared debug-agent constants/types and env overrides for model, turns, run/daily token ceilings, tool limits, and time windows.
- [x] Export recursive deterministic redaction and apply it to every debug tool result and final diagnosis.
- [x] Add nested canary-secret fixtures covering every decided token format.
- [x] Add atomic feature-scoped daily accounting with KV fallback, isolated from user budgets.
- [x] Implement the dedicated AI-Gateway Worker loop and fixed read-only tools for errors, health, trends, CF logs, and related entity state.
- [x] Enforce turn/token/daily budgets, bounded payloads/windows, safe errors, and structured secret-free output.
- [x] Add a main-D1 diagnosis table/migration linked to error/window, usage metadata, and optional Idea.
- [x] Add superadmin run/list/save-as-Idea API routes with runtime validation.
- [x] Add typed clients and `/admin/errors` row/window Diagnose actions, diagnosis view, persisted attachments, and project-select save-as-Idea.
- [x] Add unit and vertical-slice tests for auth, correlation, token non-exposure, redaction boundary, budgets, persistence, Idea creation, and UI wiring.
- [x] Document new environment variables and local-admin PII versus model-secret posture.
- [x] Run the mandatory local Playwright audit at 375x667 and 1280x800 with normal, long, empty, many, error, special-character, and minimal data.
- [x] Run full quality gates and task-completion validation.
- [x] Run cloudflare, security, UI/UX, env, constitution, docs, and test specialist reviews and address findings.
- [x] Coordinate staging with active/queued `deploy-staging.yml` and concurrent vm-agent work.
- [x] On staging, select/seed a real error, run Diagnose as superadmin, verify useful redacted persistence, save a draft Idea, enforce run/daily budgets, and observe zero errors.
- [ ] Create PR, wait for all CI, merge, monitor the matching production deploy, and complete the SAM task.

## Acceptance Criteria

- A superadmin can diagnose one error or the selected recent window from `/admin/errors`; non-superadmins cannot invoke or read it.
- The agent runs in the Worker with no VM/workspace and no arbitrary SQL, shell, filesystem, network, or node debug-package access.
- `CF_API_TOKEN` and every canary format are absent from model-visible results and persisted diagnosis text.
- Data tools are allowlisted, correlated, time/size bounded, and server-privileged.
- Max turns, per-run total tokens, and deployment-wide daily tokens are independently configurable and enforced atomically with KV fallback.
- All inference uses the shared AI Gateway and configurable GLM-5.2 default.
- Diagnoses persist on the error surface and can create canonical draft Ideas in an explicitly selected project.
- Automated canary, concurrency, API vertical-slice, and UI interaction tests pass; visual audit has no overflow.
- The real staging flow is useful, redacted, bounded, budget-enforced, and error-free.
- Loop B machinery is not introduced.

## References

- SAM idea `01KXN5YQ9TGN29ZZ8DP2DKAKHN`
- SAM task `01KYPPEED4ENYP55SET0Y3KG5R`
- `apps/api/src/services/observability.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/src/durable-objects/ai-token-budget-counter.ts`
- `apps/api/src/durable-objects/sam-session/agent-loop.ts`
- `packages/shared/src/constants/ai-services.ts`
- `tasks/archive/2026-07-17-fix-glm-52-task-title-gateway-400.md`
- `tasks/archive/2026-05-05-gemma-harness-evaluation.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/30-never-ship-broken-features.md`
- `.claude/rules/35-vertical-slice-testing.md`
