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

## Root cause (2026-04-19)

The SSE serializer in `apps/api/src/routes/trial/events.ts` emitted **named**
SSE frames (`event: trial.knowledge\ndata: {...}`) but the frontend
subscribes via `source.onmessage`, which only fires for the default
("message") event. Named events require `source.addEventListener(<name>,
...)`. Result: bytes arrive on the socket, the browser's SSE state machine
parses them, but nothing is listening for the custom event name, so the
frames are silently discarded.

Curl-based triage missed this for weeks because curl shows the raw byte
stream — `event: trial.knowledge` and `data: …` both visible — which looks
correct whether or not the browser's `onmessage` will ever fire.

Separately: `POST /api/trial/create` returned
`eventsUrl: /api/trial/events?trialId=…` (query-param), while the real
route is `/api/trial/:trialId/events` (path segment). The frontend builds
its own URL so end-users were not affected, but the response-field
contract was wrong and its unit test locked in the wrong shape.

Full write-up: `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`.

## Acceptance Criteria

- [x] `formatSse()` emits unnamed SSE frames so that
      `EventSource.onmessage` fires on every `trial.*` event.
- [x] Unit test `trial-events-format.test.ts` now asserts the frame has no
      `event:` line and carries a rationale comment pointing at the
      post-mortem.
- [x] Fixed `eventsUrl` response shape in `create.ts` to match the real
      route; unit test now asserts exact equality
      (`/api/trial/${trialId}/events`) instead of a substring match.
- [x] Capability test `tests/workers/trial-event-bus-sse.test.ts`: seeds a
      trial in KV, appends events via the real `TrialEventBus` DO, opens
      the SSE stream via `SELF.fetch`, reads the raw bytes, asserts no
      `event:` line and round-trip JSON integrity.
- [x] Post-mortem written at
      `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`.
- [x] Rule `13-staging-verification.md` updated: for browser-consumed
      SSE/WebSocket streams, curl-only verification is explicitly banned
      — only a real browser confirms dispatch to `onmessage`.
- [ ] Staging verification via Playwright against `app.sammy.party`:
      create a trial, capture the event stream, confirm ≥1
      `trial.knowledge`, ≥1 `trial.progress`, and a terminal event.
      Screenshots uploaded to library.

## References

- `apps/api/src/routes/trial/create.ts` (waitUntil dispatch site)
- `apps/api/src/services/trial/github-knowledge.ts`
- `apps/api/src/durable-objects/trial-orchestrator.ts`
- `apps/api/src/routes/trial/events.ts`
- Wave-1 PR: #760
- Staging screenshots: `.codex/tmp/trial-staging/0[1-7]-*.png`
