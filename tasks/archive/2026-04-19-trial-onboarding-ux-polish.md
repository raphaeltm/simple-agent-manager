# Trial Onboarding — UX Polish (Wave 2)

**Task ID**: 01KPJQT8AEP2RC6BN792J69JY9
**Status**: backlog → active
**Wave**: 2 (UI polish only)
**Base branch**: `sam/trial-onboarding-mvp` (NOT `main`)
**PR target**: `sam/trial-onboarding-mvp` (NOT `main`)
**Branch**: `sam/trial-onboarding-ux-polish-01kpjq`

## Problem

Wave 1 (PR #760) shipped the TrialOrchestrator DO + GitHub-API knowledge fast-path. The backend now emits `trial.knowledge`, `trial.progress`, `trial.idea`, `trial.ready`, `trial.error` events over SSE. But the UI was built before those events streamed, so:

- `TryDiscovery` shows a static "warming up" empty state instead of a live event feed for the ~30–60 seconds before `trial.ready`.
- The progress UI renders the raw `trial.progress.stage` string (e.g. `creating_project`, `provisioning_node`) instead of human-friendly labels.
- Knowledge events arrive one-by-one with no grouping/animation — they pop in jarringly.
- `trial.error` shows a terminal panel with no obvious recovery path.
- `Try.tsx` paste form, `ChatGate` post-trial chat, and `LoginSheet` modal all need polish for mobile-first beauty.
- Edge states (long repo names, slow connections, rate-limit, private repo) need attention.

This task makes the entire trial flow beautiful and fluid on mobile (375px) and desktop (1280px).

## Constraints

- **Backend frozen**: do NOT modify `apps/api/src/routes/trial/*` or `apps/api/src/services/trial/*` unless absolutely required.
- **No new event types**: use only what is in `packages/shared/src/trial.ts`.
- **No hardcoded values** (Constitution XI): polling intervals, animation durations, copy thresholds all configurable.
- **Mobile-first**: 375px first, 1280px second. Raphaël uses mobile PWA primarily.
- **No duplicate UI controls** (Rule 24): search before adding any new control.
- **Project chat first** (Rule 26): not relevant here (this is the pre-project trial flow).

## Research Findings

### Event types (frozen — `packages/shared/src/trial.ts`)
- `trial.started { trialId, projectId, repoUrl }`
- `trial.progress { stage: string, progress: 0..1, message?: string }`
- `trial.knowledge { entityName, entityType, observation, confidence? }`
- `trial.idea { id, title, summary, prompt }`
- `trial.ready { workspaceUrl, sessionId }`
- `trial.error { code: TrialErrorCode, message: string, retryable: boolean }`

### Actual stage strings emitted by `TrialOrchestrator` (`apps/api/src/durable-objects/trial-orchestrator/steps.ts`)
| Stage string | Progress |
|---|---|
| `creating_project` | 0.10 |
| `finding_node` | 0.20 |
| `provisioning_node` | 0.30 |
| `creating_workspace` | 0.50 |
| `starting_agent` | 0.70 |
| `agent_booting` | 0.90 |

The task prompt's stage names (`workspace_ready`, `discovery_agent_start`, `running`) are imprecise — the UI must map friendly labels to the real strings above.

### Files to polish
- `apps/web/src/pages/TryDiscovery.tsx` — event feed surface (PRIMARY)
- `apps/web/src/pages/Try.tsx` — paste-URL landing
- `apps/web/src/components/trial/ChatGate.tsx` — post-trial chat / claim
- `apps/web/src/components/trial/LoginSheet.tsx` — sign-in bottom-sheet
- `apps/web/src/components/trial/SuggestionChip.tsx` — idea pills
- `apps/web/src/lib/trial-api.ts` — SSE consumer & error copy map
- `apps/web/src/hooks/useTrialDraft.ts` — localStorage draft
- `apps/web/tests/playwright/trial-ui-audit.spec.ts` — extend mocks
- `apps/web/tests/playwright/trial-chat-gate-audit.spec.ts` — extend coverage

### Existing test infrastructure
- Playwright at `375x667` (iPhone SE), `390x844` (iPhone 14), `1280x800` (Desktop).
- `setupTrialMocks(page, opts)` already mocks `/api/auth/get-session`, `/api/trial/create`, `/api/trial/waitlist`, `/api/trial/*/events`. Reuse and extend.
- Screenshots → `.codex/tmp/playwright-screenshots/`.
- `trial-chat-gate-audit.spec.ts` uses a `/__test/trial-chat-gate` harness — keep this pattern.

### Design tokens available
- Colors: `bg-canvas`, `bg-surface`, `bg-surface-hover`, `text-fg-primary`, `text-fg-muted`, `text-success-fg`, `bg-success-tint`, `text-danger-fg`, `bg-danger-tint`, `border-border-default`, `border-accent`.
- Type scale: `sam-type-page-title`, `sam-type-section-title`, `sam-type-body`.
- Touch target rule: ≥44×44px (Rule 17).

## Implementation Checklist

### Configurable constants (Constitution XI)
- [ ] All animation durations exposed via `import.meta.env.VITE_*` with safe defaults
- [ ] Stage label map exported as a constant (no inline literals in JSX)
- [ ] Slow-connection warning threshold configurable (`VITE_TRIAL_SLOW_WARN_MS`, default 20000)
- [ ] Knowledge event grouping window configurable (`VITE_TRIAL_KNOWLEDGE_GROUP_MS`, default 1500)

### TryDiscovery.tsx — live event feed
- [ ] Map `trial.progress.stage` raw strings → friendly labels via shared map (`creating_project` → "Creating your project", etc.)
- [ ] Replace static "warming up" empty state with skeleton placeholders showing the stages that will run
- [ ] Animate event entrances (CSS transition, respects `prefers-reduced-motion`)
- [ ] Group consecutive `trial.knowledge` events into a single collapsed card with "+ N more" affordance
- [ ] Sticky progress header shows friendly stage label + smooth progress bar (interpolate between updates)
- [ ] Slow-connection toast/inline hint after threshold (don't block the user)
- [ ] Reduced-motion fallback (no enter animation; instant render)

### Try.tsx — paste landing
- [ ] Polish form layout (input larger, button taller on mobile)
- [ ] Improve client-side URL validation feedback (inline, calm copy)
- [ ] Better TrialsPausedPanel & cap-exceeded copy

### ChatGate.tsx — post-trial chat
- [ ] Confirm SuggestionChip horizontal scroll behavior on mobile (snap)
- [ ] Send-button states (idle, sending, success) with smooth transitions
- [ ] Anonymous user CTA emphasized (sign-in to keep this work)

### LoginSheet.tsx — sign-in
- [ ] Refine bottom-sheet animation (transform, no opacity flash)
- [ ] Ensure focus trap + body-scroll lock unchanged
- [ ] Polish desktop centered modal spacing

### Error recovery
- [ ] `trial.error` → friendly TerminalErrorPanel with explicit "Try again" link and contextual copy by `TrialErrorCode`
- [ ] Connection-lost banner uses ConnectionBadge state, not a separate component

### Edge / empty states
- [ ] First paint (no events yet) shows skeleton stages, not blank space
- [ ] Long repo names truncate with ellipsis + `title=` tooltip
- [ ] Rate-limit / cap_exceeded path keeps existing flow but better copy

### Tests
- [ ] Extend `trial-ui-audit.spec.ts`: normal, slow (delay events), error, empty (no events) — both 375 and 1280
- [ ] Extend `trial-chat-gate-audit.spec.ts`: idle/sending states
- [ ] Behavioural test for friendly stage label mapping (renders the right label for each raw stage)
- [ ] Behavioural test for knowledge event grouping
- [ ] No source-contract patterns (no `readFileSync` + `toContain`)
- [ ] All new behavior asserted with rendered output, not source inspection

### Quality gates
- [ ] `pnpm typecheck` green
- [ ] `pnpm lint` green
- [ ] `pnpm test` green
- [ ] `pnpm build` green
- [ ] Playwright visual audit produces screenshots; no horizontal overflow at 375px

### Staging verification (mandatory per Rule 13)
- [ ] Deploy via `gh workflow run deploy-staging.yml --ref sam/trial-onboarding-ux-polish-01kpjq`
- [ ] From fresh browser context, paste `https://github.com/sindresorhus/is` on app.sammy.party
- [ ] Playwright screenshots at T+0, T+2s, T+10s, T+30s, T+60s, T+terminal — both mobile (375) AND desktop (1280)
- [ ] Capture SSE event stream as JSONL → upload as `event-stream.jsonl`
- [ ] Upload all screenshots to project library at `/trials/ux-polish-staging-verification/` via `mcp__sam-mcp__upload_to_library`, tagged `trial-onboarding`, `staging-verification`, `ux-polish-task`

### Specialist review (Phase 5 — all must PASS or ADDRESSED)
- [ ] task-completion-validator
- [ ] ui-ux-specialist (mandatory — `apps/web/` touched)
- [ ] test-engineer (verify behavioural patterns)
- [ ] cloudflare-specialist (only if Worker code touched — should be NO)
- [ ] security-auditor (only if auth/cookie/credential touched — should be NO)

## Acceptance Criteria

1. Pasting a public GitHub URL transitions Try → TryDiscovery in under one second.
2. TryDiscovery shows a live event feed within ~2 seconds of trial creation, with friendly stage labels and smooth progress bar.
3. Knowledge events grouped into a single collapsed card after the grouping window.
4. `trial.ready` transitions cleanly to ChatGate; suggestion chips appear and are tappable on mobile.
5. `trial.error` renders a recovery panel with explicit "Try again" affordance.
6. No horizontal overflow at 375px on any screen.
7. All animations respect `prefers-reduced-motion`.
8. All Playwright visual audits pass.
9. Staging verification screenshot grid captured and uploaded.
10. All specialist reviewers report PASS or ADDRESSED.

## References

- Wave 1 PR: #760
- Backend (frozen): `apps/api/src/durable-objects/trial-orchestrator/`, `apps/api/src/routes/trial/`, `apps/api/src/services/trial/`
- Event schema: `packages/shared/src/trial.ts`
- Visual testing rules: `.claude/rules/17-ui-visual-testing.md`
- Staging verification: `.claude/rules/13-staging-verification.md`
- Constitution XI: `.specify/memory/constitution.md`
