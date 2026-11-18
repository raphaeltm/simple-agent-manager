# /sam assistant: mobile scroll leak, live streaming progress, recency grounding, GLM 5.3 Flash

Task: `01M5ER021WQMW1QB3ETQKMFNJ9` · Branch: `sam/looks-theres-scrolling-bug-kmfnj9`

## Problem

Raphaël's feedback on the new private SAM assistant (`/sam`, PR #2386), 2026-10-21:

1. **Scrolling bug (mobile, screenshot).** The composer floats mid-screen with blank page background
   below it and the SAM header gone.
2. **Progress is too generic and too infrequent.** One turn showed only "Working…" the whole time;
   another showed "Checked projects and tasks" late.
3. **No token streaming.** The old SAM UI streamed tokens and felt smooth; the new one shows the
   whole answer at the end.
4. **Wrong answer to a basic question.** "What shipped recently?" returned work from months ago.
5. **Model.** Gemma 4 26B is the current `SAM_MODEL`; evaluate GLM 5.3 Flash (has a cached-input price).

## Research Findings

### Scroll bug (reproduced locally, Playwright 412x891 mobile)

- `apps/web/src/pages/Sam.tsx`: conversation scroller is `h-full overflow-y-auto` but **not
  positioned**; its wrapper is `relative`. Tailwind `sr-only` spans (`SamTurn.tsx` "You: ") are
  `position:absolute`, so their containing block is the wrapper, outside the scroller. They are not
  clipped by the scroller and sit at their unscrolled static positions (151 → 5621px).
- Their overflow propagates through the overflow-visible wrapper/root into the AppShell `<main>`
  (`overflow-y-auto`): measured `main.scrollHeight=5560` vs `clientHeight=829` with only an 829px child.
- A wheel/touch scroll at the bottom of the conversation chains to `<main>` (measured
  `main.scrollTop=3000` after one wheel), dragging the SAM header off-screen and the pinned composer
  up — exactly the screenshot.
- The existing audit `checkComposerPinned` asserted `composer.bottom <= viewport.height`, which a
  composer dragged upward also satisfies; it never asserted `<main>` cannot scroll.

### Wrong "what shipped recently" answer (production AI Gateway logs, gateway `sam`)

- Turn `82921219-…` ("What shipped recently?"): ONE Gemma call, **zero tool calls**. The model
  answered from a months-old legacy assistant message in private history (projected as
  `sam_historical_turn_status`, `turnId:null`, `state:unknown`). Its reasoning: "the previous turn's
  summary (which I'm treating as the source of truth…)".
- The system prompt has **no current date/time**; historical records carry **no timestamps**.
- Turn `44c7bb04-…` (follow-up): 3 calls (projects_list, tasks_list, answer) = 11s + 14s + 36s;
  correct answer once live data was read. The model inferred "today" from task timestamps.
- `inboxGet` (`apps/api/src/operations/connector-read-core.ts`) returns unread notifications and
  pending items with **no timestamps**, so even live inbox data cannot be judged for recency.

### No streaming / generic progress

- `operator/agent.ts` calls Mastra `agent.generate()` → non-streaming upstream request (prod request
  body has no `stream`). The browser polls `GET /api/sam/turns` every 2s (`SAM_ACTIVE_POLL_MS`).
- `SamTurn.tsx` shows "SAM · working" + "Working… You can leave this page and return." for any active
  turn; read receipts only appear after a tool completes ("Checked …").
- Mastra 1.77 `agent.stream()` + `onChunk` gives `text-delta`, `reasoning-delta`, `tool-call`,
  `tool-result`, `step-start`/`step-finish` chunks. `getFullOutput().text` is the **last step's text**
  for tool-driven runs (pre-tool narration excluded) — the live draft must mirror that.
- The server publication guard (`assertGroundedOperatorResponse`) runs on the final text and may
  trigger an unpublished-draft correction. Streaming must not publish text the guard would reject:
  release only whitespace-bounded prefixes that pass the guard (guard is prefix-monotonic for
  whitespace-bounded prefixes: identifiers/URLs never contain whitespace).
- Streaming usage: Mastra's openai-compatible client sends no `stream_options`; Workers AI
  `/v1/chat/completions` reports `finish_reason` "only on the usage chunk" (changelog 2026-02-17), so
  usage arrives in streams. Budget accounting (`incrementTokenUsage`) depends on it → add a
  fail-safe estimate if a step reports no usage, and verify KV counters on staging.

### Send latency (staging measurement, 2026-10-21)

- After Send, "Sending…" stayed up ~4–5 s after the POST returned. `Sam.tsx` `send()` awaited a
  history refresh before the new turn could show.
- `GET /api/sam/turns` took 4.0–7.6 s for the smoke user (91 turns, 10 project-work cards); other
  SAM requests took 0.4–0.8 s. `OperatorWork.view` ran three D1 reads per card one after another
  (two membership reads plus the task read) on every history read.

### History record copy (staging run 4, 2026-10-21)

- GLM began one answer by writing a `sam_historical_turn_status` JSON record copied from its
  history. The stream showed 463 characters of it for ~10 s; the final text then failed the
  guard (its old links had no receipts this turn) and the correction forced a live read. Before
  streaming the copy was invisible; a copy with no links or IDs would have been stored.

### Model evaluation (Cloudflare docs, 2026-10-21)

| Model | Input $/M | Cached input $/M | Output $/M | Context | Notes |
| --- | --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` | 0.10 | — | 0.30 | 256K | 4B active |
| `@cf/zai-org/glm-5.3-flash` | 0.15 | 0.03 | 0.50 | 1M | 18B active of 320B; tools, streaming; `reasoning_effort` low/high/max, cannot disable |

- Raphaël's two turns (27,585 in / 3,009 out tokens) cost $0.0037 on Gemma; GLM 5.3 Flash ≈ $0.0056
  uncached, ≈ $0.0039 with in-turn prefix caching (later steps resend the earlier prefix).
- Prefix caching is automatic; `x-session-affinity` raises hit rates; dynamic content belongs at the
  end of the prompt.
- `PLATFORM_AI_MODELS` has no cached-price field and lists Gemma's context as 32,768 (stale).

## Implementation Checklist

### A. Mobile scroll leak (web)
- [x] Make the SAM conversation scroller the containing block (`relative`) so absolute descendants
      (sr-only labels) are clipped by it and cannot extend `<main>`'s scroll area.
- [x] Playwright regression: long conversation at 375/390/412px, wheel/touch past the bottom;
      assert `<main>` has no scrollable overflow, `main.scrollTop` stays 0, SAM header visible,
      composer bottom at the viewport bottom. Prove it fails without the fix.
- [x] Tighten `checkComposerPinned` to assert the composer sits at the bottom edge (not merely above it).
- [x] Record the lesson (absolute descendants escape a non-positioned scroller) in the web overflow rule.

### B. Recency grounding (api)
- [x] Add the current UTC date/time to each turn's instructions (constant within a turn, at the end).
- [x] Add `recordedAt` to every `sam_historical_turn_status` record (operator turn `created_at`;
      legacy message `created_at`).
- [x] Strengthen instructions: status/recency questions must use operations called this turn;
      history is past context only; judge recency against the current time and include dates.
- [x] `inboxGet`: include `updatedAt` for pending items and `createdAt` for notifications.
- [x] Tests: request body contains the current time and `recordedAt`; inbox timestamps.

### C. Live streaming + specific progress (api + web)
- [x] Refactor grounding into a reusable receipt index + text check (`assertGroundedOperatorResponse`
      keeps its contract).
- [x] `operator/live.ts`: per-DO live state for the active turn (phase, released answer text,
      reasoning preview, tool activity), SSE subscribers with snapshot-on-connect, throttled flushes,
      heartbeat, subscriber cap, close on turn end. Release only guard-passing whitespace-bounded prefixes.
- [x] `agent.ts`: `agent.stream()` + `getFullOutput()` (same error semantics as `generate`),
      `onChunk` → live hub; step narration resets the draft; correction resets the draft.
- [x] Usage fail-safe: estimate tokens when a streamed step reports none; log `sam.operator.usage_estimated`.
- [x] `controller.ts`: `GET /turns/:id/stream` (SSE) and a live snapshot on the active turn in
      `GET /turns`; publish `done` after the turn's terminal state is written.
- [x] `routes/sam.ts`: proxy the stream path (authenticated, per-user DO).
- [x] Runtime-tunable knobs as admin settings (flush ms, heartbeat ms, max subscribers).
- [x] Web: `useSamLiveTurn` hook (fetch-stream SSE parser, reconnect with backoff, fallback to polling).
- [x] Web: active turn shows streamed answer, specific tool activity lines ("Reading your 20 most
      recent tasks"), "Thinking" phase with a one-line reasoning preview, and elapsed time.
- [x] Web: slower history polling while the stream is healthy; refetch on tool completion and `done`.
- [x] Tests: native workerd runtime (real Mastra) for streamed text, guard gating, tool activity,
      `stream:true` upstream, usage accounting; unit tests for the hub and the SSE parser; Playwright
      audit with a progressive mocked stream at mobile + desktop.
- [x] Web: show the accepted turn from the send receipt at once and refresh history behind it; a
      failed send still waits for history. Playwright holds the history read and asserts the turn
      and its stream show (fails on the old handler).
- [x] API: `OperatorWork.view` reads cards in parallel and checks each project once (3N → N + 2P
      D1 reads). Unit tests: all reads in flight together, one membership check per project, and a
      revoked-project control (the first two fail on the sequential loop).
- [x] Review follow-ups: one access cache shared by receipts and work cards, run together; tool
      names in the thinking line read as step titles; overscroll audit at 412×891.
- [x] Guard: a reply that carries a history record key (kind, authority, assistantMessages, assistantOmitted) is rejected (never streamed or
      stored; runs the correction; left out of later context); instructions say never to write
      such records. Tests: guard unit, live hub, context, and a workerd run with the real agent
      (copy → correction → tool → answer); all four fail without the rule.
- [x] Live status says "Thinking", not "Writing", while a step's text is withheld (run 5 showed
      14 s of "Writing" with nothing written); an end-of-prompt line asks for plain prose.
- Deferred: why the model copies records (every past assistant turn is shown as JSON) →
  `tasks/backlog/2026-10-21-sam-history-records-primes-json-replies.md`. It needs a history
  projection redesign with its own security review.

### D. Model (shared + api config)
- [x] Add `@cf/zai-org/glm-5.3-flash` to `PLATFORM_AI_MODELS` with published pricing, optional
      cached-input price field; fix Gemma's context window.
- [x] Use cached-input pricing in SAM cost accounting when usage reports cached tokens.
- [x] Send `x-session-affinity` (per private conversation) on SAM Workers AI calls.
- [x] Per-model request controls (GLM 5.3 Flash: `reasoning_effort: low`).
- [x] Switch `SAM_MODEL` to GLM 5.3 Flash after staging comparison; check GitHub Environment overrides
      for `SAM_MODEL` (rule 70) and verify the deployed value. Staging A/B on the same build,
      question and data (throwaway branch with only `SAM_MODEL` changed, deleted after): both
      models called live tools and answered with dates. GLM made 2 model calls, 32,990 in / 488 out,
      $0.0034; Gemma made 3 calls, 57,302 in / 1,213 out, $0.0043, and finished in ~31 s against GLM's ~20 s. No
      staging/production Environment override of `SAM_MODEL`.

### E. Docs
- [x] `apps/www/.../guides/sam-assistant.md`, `architecture/sam-account-assistant.md`,
      `reference/configuration.md` (new admin settings, model), `reference/api.md` (stream route).

## Acceptance Criteria

- [x] On a phone, scrolling the conversation never moves the page: header and composer stay put
      (Playwright regression, proven discriminating; staging runs 1-3: `<main>` scrollable 0,
      composer bottom = shell bottom).
- [x] The answer streams into the UI progressively while SAM works; persisted answer matches
      (workerd test asserts live text = stored response; staging 14-17 visible increments).
- [x] Active turns show what SAM is doing right now (specific tool lines, thinking, writing) with
      elapsed time, updating at least every few seconds (staging run 3: turn shown 0.9 s, step
      4.5 s, answer 9.8 s; GLM streams no reasoning, so no thinking line on GLM).
- [x] Streamed text never shows content the publication guard rejects (live hub unit tests,
      workerd midpoint test, preview redaction test).
- [x] Token budgets still record usage for streamed turns (workerd test; staging budget deltas
      equal the AI Gateway log for every run).
- [x] "What shipped recently?" on staging calls live tools and reports recent work with dates.
- [x] SAM runs on GLM 5.3 Flash in staging with streaming and tools working end to end.

Evidence: `tasks/evidence/2026-10-21-sam-live-streaming/README.md`.

## References

- PR #2386 (Mastra SAM assistant), `apps/api/src/durable-objects/sam-session/operator/*`
- `apps/web/src/pages/Sam.tsx`, `apps/web/src/components/sam/*`
- Rules: web 56 (clipped overflow), 62 (real trigger), 52 (model catalog), 70 (deployed value), 60 (I/O budgets)
- Cloudflare docs: Workers AI GLM 5.3 Flash, Gemma 4, prompt caching, changelog 2026-02-17
