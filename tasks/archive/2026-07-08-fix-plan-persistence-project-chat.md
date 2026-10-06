# Fix Plan Persistence In Project Chat

## Problem

Plans are durably persisted, but the project chat UI does not reliably show them. Missed WebSocket plan broadcasts are not recovered by fallback polling, reloads can miss plans when the `session_state` mirror is stale or keyed differently, and the plan pill disappears whenever the activity indicator reads idle.

## Research Findings

- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` hydrates plan only when `state.currentPlan` is truthy, so cleared plans never clear the UI. Its fallback poll fingerprint omits plan identity, so plan-only state updates can skip UI updates.
- `apps/web/src/components/project-message-view/useActivityVerifyTimer.ts` reads the lightweight state endpoint but currently only uses `state.activity`, discarding `state.currentPlan`.
- `apps/web/src/components/project-message-view/CompletionDock.tsx` renders the plan pill behind `working && hasPlan`, coupling plan visibility to the activity signal.
- `apps/api/src/routes/chat-agent-state.ts` fetches session state by ACP session id. Plan messages are persisted as `role='plan'` chat messages, and the resolver does not currently reconstruct the latest plan from those durable rows.
- `apps/api/src/durable-objects/project-data/message-persistence.ts` updates `session_state.current_plan_json` when plan messages are persisted, but the durable chat message is the stronger source of truth for reload recovery.
- Rule 17 applies because the project chat UI changes. Run Playwright visual audit at 375px and 1280px.
- Human-approved exception: skip staging deploy/verification for this PR, note that in the PR description, merge after local quality gates/CI/reviews, then monitor production deploy and verify production.

## Implementation Checklist

- [x] Add a durable ProjectData helper to read the latest `role='plan'` message and parse it as the source-of-truth plan snapshot.
- [x] Enrich chat detail and lightweight state responses with the durable plan, using `session_state.currentPlan` as a fast cache/fallback.
- [x] Include plan identity in the fallback poll fingerprint.
- [x] Make plan hydration unconditional in the web lifecycle so null/empty plan state clears the UI.
- [x] Hydrate `currentPlan` from `useActivityVerifyTimer` state responses.
- [x] Decouple `CompletionDock` plan pill rendering from `working` and style idle plan visibility appropriately.
- [x] Add regression tests for plan-only poll updates, reload from durable plan messages when the state mirror is stale/missing, and idle plan pill visibility.
- [x] Run targeted and full local quality checks plus required Playwright visual audit.
- [x] Run local specialist reviews required by `/do`.
- [ ] Skip staging by explicit human authorization, create PR, merge after CI, monitor production deployment, and verify production.

## Acceptance Criteria

- A plan-only state change between fallback polls rehydrates the plan.
- Reload with a stale or missing `session_state` plan mirror still returns and shows the latest persisted plan message.
- Clearing plan state clears the current UI plan.
- The plan pill remains visible when activity transitions from working to idle.
- The lightweight state verification path updates `currentPlan`.
- Playwright screenshots at 375px and 1280px show no overflow or broken dock layout.

## References

- Idea `01KX0K9JEADXBZMS2FDYQYPG11`
- Task `01KX0KF7M4Y3HSRZMJG4W6YV5C`
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/components/project-message-view/useActivityVerifyTimer.ts`
- `apps/web/src/components/project-message-view/CompletionDock.tsx`
- `apps/api/src/durable-objects/project-data/session-state.ts`
- `apps/api/src/durable-objects/project-data/message-persistence.ts`
- `.claude/rules/17-ui-visual-testing.md`
