# Trial orchestrator + knowledge fast-path emit zero events on staging

## Problem

On staging (sammy.party) `POST /api/trial/create` succeeds (201), the SSE
endpoint `GET /api/trial/:trialId/events` opens correctly (200, fingerprint
auth passes via cookie), and 15-second heartbeat comments are streamed as
expected — but **zero `trial.*` data events** ever arrive on the bus.

Captured live evidence:
- Trial: `trial_a17ad48b9e3a45c990aa87a8160afe90`
- Repo: `https://github.com/sindresorhus/is`
- Window: ~75 seconds after create
- Stream: 1 `: connected` + 5 `: heartbeat <ts>` comments, **no data lines**
- Full transcript: `.codex/tmp/trial-staging/event-stream.jsonl`

Both the GitHub knowledge fast-path (`emitGithubKnowledgeEvents`) and the
TrialOrchestrator DO `start()` are dispatched via `c.executionCtx.waitUntil`
inside `apps/api/src/routes/trial/create.ts`. Neither produces visible events
on the SSE bus on staging. The browser-side EventSource stays in
"Reconnecting" because `onopen` does fire once but the lack of any data
events plus a transient transport drop trips `onerror` into the polished
retry UI.

## Context

- Discovered during Wave-2 UX polish staging verification
  (task `01KPJQT8AEP2RC6BN792J69JY9`, branch
  `sam/trial-onboarding-ux-polish-01kpjq`).
- The Wave-2 UX polish itself renders correctly on staging — header,
  Live/Reconnecting badge, "Setting things up" panel, slow-job copy,
  ChatGate input — but cannot be fully exercised because no data events
  arrive.
- Backend was last touched in PR #760 (Wave-1 TrialOrchestrator + knowledge
  fast-path wire-up).

## Acceptance Criteria

- [ ] On staging, `POST /api/trial/create` followed by an SSE subscription
      receives at least one `trial.knowledge` event within
      `TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS` (default 5s).
- [ ] On staging, the orchestrator emits `trial.progress` events for
      `creating_workspace` / `provisioning_vm` / etc. within 60s.
- [ ] Either `trial.ready` or `trial.error` arrives within
      `TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS` (default 5 min).
- [ ] Add a capability test that publishes via `TrialEventBus.publish` and
      asserts the SSE endpoint streams the JSON payload (catches the
      bus → endpoint break that unit tests miss).
- [ ] Investigate whether `c.executionCtx.waitUntil` is actually awaiting
      these tasks on the staging Worker bundle (check `wrangler tail`
      for `trial.create.orchestrator_dispatch_failed` and
      `trial.knowledge.error` log lines).

## References

- `apps/api/src/routes/trial/create.ts` (waitUntil dispatch site)
- `apps/api/src/services/trial/github-knowledge.ts`
- `apps/api/src/durable-objects/trial-orchestrator.ts`
- `apps/api/src/routes/trial/events.ts`
- Wave-1 PR: #760
- Staging screenshots: `.codex/tmp/trial-staging/0[1-7]-*.png`
