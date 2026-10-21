# Staging evidence: /sam live answers, scroll fix, recency, GLM 5.3 Flash

Task `01M5ER021WQMW1QB3ETQKMFNJ9`, 2026-10-21. Staging (`app.sammy.party`), smoke user,
412×891 mobile browser with touch, Playwright. Each run sent "What shipped recently?" and
sampled the running turn twice a second until it finished.

## Runs

| Run | Build | Model | Result |
| --- | --- | --- | --- |
| 1 | `dcd201546` (deploy 39578825121) | GLM 5.3 Flash | Pass. Live inbox and project reads, 17 visible answer increments, dated answer. "Sending…" showed for seconds (see below). |
| 2 | `cb1528def` (deploy 39585545753, throwaway branch, deleted) | Gemma 4 26B | Same build as run 3 with only `SAM_MODEL` changed. |
| 3 | `a262f0ee9` (deploy 39588349771) | GLM 5.3 Flash | Pass. |
| 4 | `280162f4e` (deploy 39593029335) | GLM 5.3 Flash | Pass, stored answer correct. The model first wrote a copy of a history record; 463 characters streamed for ~10 s before the guard's correction replaced them. Fixed afterwards: the guard now rejects record copies. |
| 5 | `8a9f1306e` (deploy 39598495157) | GLM 5.3 Flash | Pass. The model copied a record again; nothing of it streamed, and the correction's live answer followed. The status read "Writing" for those 14 s, fixed afterwards to "Thinking". Done at ~44 s; 51,109 in / 1,437 out, $0.0064. |

Every run: no failed API requests, no console errors, `<main>` not scrollable
(`scrollHeight - clientHeight = 0`, `scrollTop = 0`), composer bottom = shell bottom (891 px).

## Model comparison (runs 2 and 3: same build, question and data; one sample each)

| | GLM 5.3 Flash | Gemma 4 26B |
| --- | --- | --- |
| Live reads | inbox | inbox, then projects |
| Model requests | 2 | 3 |
| Turn on screen after Send | 0.9 s | 1.3 s |
| First step shown | 4.5 s | 9.0 s |
| First answer text | 9.8 s | 22.1 s |
| Finished | ~20 s | ~31 s |
| Tokens in / out | 32,876 / 539 | 57,302 / 1,213 |
| Cost (AI Gateway log = SAM budget meter) | $0.0033 | $0.0043 |
| Reasoning preview | none streamed | 32 updates |

Both answers used live data and dates. GLM also gave the check time ("live inbox check just
now, 2026-10-21 11:17 UTC") and flagged stale running tasks. Run 1's cost works out to about
14.8K of 33K input tokens billed at the cached rate (in-turn prefix reuse).

## Latency found and fixed during verification

- `GET /api/sam/turns` took 4.0–7.6 s for this user (91 turns, 10 project-work cards); other
  SAM requests took 0.4–0.8 s. `OperatorWork.view` did three D1 reads per card in sequence.
- Send waited for that read before showing the turn. Now the turn shows from the send receipt
  (0.9 s in run 3) and the reads run in parallel: on `a262f0ee9` the same read took 1.25–1.47 s
  (93 turns, 10 cards).

## Screenshots

Local audit with mocked API (`apps/web/tests/playwright/sam-assistant-audit.spec.ts`), 375×667
and 1280×800: `sam-overscroll-*`, `sam-live-thinking-*`, `sam-live-working-*`,
`sam-live-writing-*`, `sam-sent-streaming-*`, `sam-live-polled-*`.

Staging run 3: `staging-glm-01-1s-*` (turn shown, Starting), `staging-glm-03-4s-*` (Working,
"Checking your inbox…"), `staging-glm-07-12s-*` (Writing). Run 2: `staging-gemma-99-done-*`.
The final run-3 frame is omitted because it shows another staging user's handle.
