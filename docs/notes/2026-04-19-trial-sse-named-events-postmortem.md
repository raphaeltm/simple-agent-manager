# Post-mortem: Trial SSE endpoint emitted named events, EventSource.onmessage never fired

**Date discovered:** 2026-04-19
**Date fixed:** 2026-04-19
**Branch:** `sam/pick-where-previous-session-01kpk2`
**Integration branch:** `sam/trial-onboarding-mvp`

## What broke

On the staging trial onboarding flow (`app.sammy.party`), after a user
submitted a public GitHub repo URL and `POST /api/trial/create` returned
201, the frontend opened `GET /api/trial/:trialId/events` and received a
`200 text/event-stream` response with periodic `: heartbeat` comments —
but never displayed any `trial.knowledge`, `trial.progress`, or
`trial.ready` / `trial.error` events. The TryDiscovery card stayed pinned
on "Connecting…" indefinitely.

Curl against the same endpoint, in contrast, **did** surface events. A
raw `curl -N` of the SSE URL produced the expected frames:

```
event: trial.knowledge
data: {"type":"trial.knowledge","key":"description","value":"…"}

event: trial.started
data: {"type":"trial.started","at":…}

event: trial.progress
data: {"type":"trial.progress","step":"provisioning"}
```

So the backend was emitting events. The browser was receiving them on
the wire. But the client saw zero events.

## Root cause

The SSE serializer in `apps/api/src/routes/trial/events.ts` emitted
**named** SSE frames:

```ts
// Before
export function formatSse(eventName: string, data: unknown): string {
  const safeName = eventName.replace(/[\r\n]/g, '');
  const json = JSON.stringify(data);
  return `event: ${safeName}\ndata: ${json}\n\n`;
}
```

The frontend client in `apps/web/src/lib/trial-api.ts` subscribes via
`source.onmessage`:

```ts
source.onmessage = (msg: MessageEvent<string>) => {
  const parsed = JSON.parse(msg.data) as TrialEvent;
  handlers.onEvent(parsed);
};
```

Browser `EventSource.onmessage` **only fires for frames with no `event:`
line** (equivalently: `event: message`). Named events must be subscribed
to per-name via `source.addEventListener('trial.knowledge', handler)`.
The result: named frames were delivered to the TCP socket, parsed by
the browser's SSE state machine, dispatched as `'trial.knowledge'`
custom events — and silently swallowed because nothing was listening
for them.

Heartbeat comments (`: heartbeat …`) kept the connection alive, which
is why the UI saw neither events nor a disconnect.

## Timeline

- **2026-04-?? (Wave-0 / Wave-1)**: `formatSse()` shipped with the
  `event:` line. `TrialEvent` carries a `type` discriminator in the
  JSON body, but the serializer also encoded it as the SSE event name.
- **2026-04-19 morning**: User reports "zero trial.* data events on
  staging." Original suspicion list: `waitUntil` not running,
  `emitTrialEvent` fetch failing silently, orchestrator DO RPC throwing,
  alarm not firing, KV race.
- **2026-04-19**: Branch `sam/pick-where-previous-session-01kpk2` was
  cut to instrument the trial fan-out. `wrangler tail` auth failed with
  error 9106, so the agent used `curl` against `api.sammy.party`
  instead. The curl output surfaced named `event: trial.knowledge`
  frames — matching the "bytes on the wire but onmessage never fires"
  signature.
- **2026-04-19**: Fix landed — `formatSse()` now emits unnamed
  frames. Unit tests updated to assert the new shape. A capability test
  (`trial-event-bus-sse.test.ts`) was added exercising the bus → SSE
  round-trip end-to-end.

## Why it wasn't caught

### 1. No end-to-end capability test crossed the DO → SSE boundary

Unit tests for `formatSse()` existed but asserted the **wrong** shape —
they locked in the `event: <name>\ndata: …` frame as if it were the
intended contract. The bus (`trial-event-bus.ts`) had its own unit
tests. The SSE endpoint had route-level auth tests. Nothing exercised
the full path: *publish via `TrialEventBus.append` → `SELF.fetch` the
SSE endpoint → parse the raw stream bytes* in the same test.

This is exactly the failure mode rule `10-e2e-verification.md` warns
against — components work individually, the system doesn't.

### 2. Curl was used as the verification tool for frontend SSE

Curl displays the raw byte stream — including the `event:` line —
which looks identical whether or not the browser's EventSource will
dispatch the frame to `onmessage`. A Playwright check in the real
browser, reading `EventSource.onmessage` invocations, would have caught
this on day one.

### 3. The frontend test path was not exercised during Wave-1 QA

The `openTrialEventStream()` helper in `apps/web/src/lib/trial-api.ts`
has no test that plugs it into a mock SSE server and verifies the
`onmessage` callback receives events. Wave-1 staging verification
tested that the POST /create endpoint returned 201 and that the SSE
endpoint opened — neither check exercises the actual message dispatch.

### 4. `eventsUrl` response field had a latent shape mismatch too

Separately, `POST /api/trial/create` returned
`eventsUrl: /api/trial/events?trialId=…` while the real route is
`/api/trial/:trialId/events`. The frontend builds its own URL and
ignores this field, so the mismatch was invisible — but any external
integrator relying on the documented response shape would have gotten
a 404. The `trial-create.ts.test.ts` unit test locked in the wrong
shape with a `toContain('/api/trial/events?trialId=')` assertion. Both
issues are fixed in this change.

## Class of bug

**Two-layer contract mismatch with a silent consumer.**

The server and client both "worked" individually — the server emitted
valid SSE, the client's `EventSource` parsed valid SSE. Neither threw.
But the **contract** between them (named vs default event) did not
line up, and the consumer had no way to signal the mismatch — a custom
event dispatched to zero listeners produces no error.

This is the same class of bug as the
`tasks/active/2026-03-30-duplicate-settings-controls-postmortem.md`
"duplicate settings controls" issue and the
`docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md`
"UI input collected but never sent" issue: **the data path looks
correct at every hop but nothing verifies the round-trip**.

## Process fix

### 1. Capability test for every cross-boundary stream

Added `apps/api/tests/workers/trial-event-bus-sse.test.ts`. It:
- Seeds a trial record in KV
- Appends events via the real `TrialEventBus` DO
- Opens the SSE stream via `SELF.fetch` with a valid fingerprint cookie
- Reads the raw stream bytes
- **Asserts no `event:` line exists** (the regression guard)
- Asserts the JSON payloads round-trip intact

### 2. Unit tests now encode the correct contract, with a rationale comment

`trial-events-format.test.ts` now asserts
`expect(frame).not.toContain('event:')` and carries an inline comment
explaining *why* (links back to this post-mortem). Future contributors
looking at the test will see the rationale before deciding to "fix"
the tests by re-adding `event:`.

### 3. Response-shape assertion is exact, not substring

`trial-create.ts.test.ts` previously asserted
`body.eventsUrl).toContain('/api/trial/events?trialId=')` — a test that
would pass on **literally the wrong URL shape**. Changed to
`expect(body.eventsUrl).toBe(`/api/trial/${body.trialId}/events`)`.
Substring matches on URL contracts are no longer acceptable for
anything the client or external consumer reads.

### 4. Playwright must be the verification surface for browser-facing
streams

Rule 13 already requires staging verification via Playwright. This
incident happened because curl was substituted for Playwright during
triage — `curl` can confirm bytes, not dispatch. The task-completion
check for any feature that emits browser-consumed SSE / WebSocket
frames must include a Playwright assertion that the frontend's own
handler was invoked. Adding a note to the follow-up process rule below.

## Follow-up

- [ ] Add a short note to `.claude/rules/13-staging-verification.md`:
      for any stream the browser consumes via EventSource /
      WebSocket, verification MUST be through a real browser, not
      `curl`. Curl confirms the byte stream; the browser confirms the
      dispatch.
- [ ] Consider a frontend unit test for `openTrialEventStream()` that
      plugs a mock SSE server into `EventSource` and asserts
      `onmessage` fires. Browser-polyfill tests are fiddly, so this is
      a soft recommendation, not a required change in this PR.
