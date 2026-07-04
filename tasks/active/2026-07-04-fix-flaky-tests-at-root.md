# Fix All Known Flaky Tests at the Root (No Retries)

## Problem Statement

CI has repeatedly gone red on tests unrelated to the changed code, blocking production deploys (most recently commits 95be06994/8591fb4e0, which touched only `packages/shared` yet failed on an acp-client component test). The user has explicitly rejected retry-based mitigation: **no vitest `retry` config, no CI auto-rerun logic anywhere**. Every known flaky test must be fixed at its root cause.

Known flaky tests and noise sources:

1. **acp-client** `ToolCallCard › lazy-loads empty tool content and keeps the card expandable` (`packages/acp-client/tests/unit/components/ToolCallCard.test.tsx:75-92`)
2. **web** `useAvailableCommands › re-fetches when refreshKey changes (new session)` (`apps/web/tests/unit/hooks/useAvailableCommands.test.ts:150-176`) — tracked in `tasks/backlog/2026-04-11-fix-flaky-useAvailableCommands-test.md`
3. **vm-agent (Go)** `TestSessionHost_ReplayDoesNotDropMessages` (`packages/vm-agent/internal/acp/session_host_test.go:435`) — tracked in `tasks/backlog/2026-02-28-fix-flaky-vm-agent-tests.md`
4. **web** unit tests hit real `fetch` in jsdom (no stub in `apps/web/tests/setup.ts`), producing "Failed to load skills: fetch failed" console noise and background state updates during unrelated tests (e.g. `apps/web/src/pages/project-chat/useProjectSkills.ts:16` fetches on mount)
5. Other instances of the sync-assert-after-async-boundary pattern across `apps/web/tests` and `packages/acp-client/tests`

## Research Findings

### 1. ToolCallCard lazy-load race (confirmed)

The test does:

```tsx
fireEvent.click(header);
await waitFor(() => expect(onLoadContent).toHaveBeenCalledWith('msg-empty-tool'));
expect(screen.getByText('No output.')).toBeTruthy(); // sync — races
```

`handleToggle` (`packages/acp-client/src/components/ToolCallCard.tsx:58-76`) calls `onLoadContent(...)` and only afterwards awaits the promise and sets `lazyContent`/`loading=false`. `waitFor` resolves as soon as the mock is *called* — before the awaited promise's state updates flush — so the card can still show "Loading content…" when the sync `getByText('No output.')` runs. Component is correct; test asserts an intermediate state window.

**Fix**: assert the final UI state asynchronously — `await screen.findByText('No output.')` (the mock-called waitFor becomes redundant but harmless; keep or fold in).

### 2. useAvailableCommands refreshKey race (confirmed mechanism class)

The failing assertions are *already inside* `waitFor` (moved there in a prior fix attempt) and the hook's effect/cancellation wiring is correct (verified: `fetchCachedCommands` cancellation signal, effect deps `[fetchCachedCommands, refreshKey]`, no lost update path). What remains: `waitFor` uses a **1000ms default timeout with real timers**. Under `vitest run --coverage`, instrumentation overhead plus CPU-starved shared CI runners can stretch the rerender→effect→fetch→setState→re-render chain past 1s of wall time. This is why it only fails in CI with coverage and passes locally.

**Fix**: raise the testing-library async utility timeout globally via `configure({ asyncUtilTimeout: ... })` in the web (and acp-client) test setup files, so all `waitFor`/`findBy*` calls get a CI-realistic bound (e.g. 5000ms). This fixes the *class*, not just this test. Vitest `testTimeout` should stay comfortably above it. This is deterministic waiting with an adequate bound — not a retry mechanism.

### 3. Go replay test — backlog task's root cause is WRONG; corrected analysis

The 2026-02-28 backlog task hypothesizes a race between `BroadcastEvent` ingestion and `AttachViewer` replay and prescribes "Option A: wait for ingested count == 50 before attaching". **This cannot be the cause**: `broadcastMessage` → `appendMessage` appends to the buffer synchronously under `h.bufMu.Lock()` (`session_host_broadcast.go`) before `broadcastMessage` returns. All 50 messages are in the buffer before `AttachViewer` is called. Confirmed by observed CI failures: the pre-replay `session_state.ReplayCount == 50` assertion PASSES; the failure is the delivered count (48-49 of 50) with `replay_done` still received.

The actual loss mechanism is **delivery-side**: `replayToViewer` sends each buffered message via `sendToViewerWithTimeout(viewer, data, 5*time.Second)`; on timeout it logs "viewer replay send timed out" / "viewer replay aborted" and `break`s — dropping the remaining suffix — after which `AttachViewer` still sends `replay_done` (with a fresh 5s timeout, which can succeed). The client then sees a complete-looking replay with < 50 messages. For the send to time out, the `viewerWritePump` goroutine must stall ~5s draining the cap-8 `sendCh`; the 50 tiny messages fit kernel TCP buffers, so the plausible CI mechanism is goroutine scheduler starvation under `-race` + coverage + `t.Parallel()` on saturated shared runners. Test-structural contributor: the client only starts reading AFTER the fully-synchronous `AttachViewer` returns.

**Fix (test-side, no time.Sleep, no retries)**:
- Size `ViewerSendBuffer` in this test's config above the replay volume (e.g. 64 > 51), so `replayToViewer` enqueues the entire replay without ever blocking on pump scheduling — deterministic regardless of CI load. The test's purpose is "replay does not drop messages", not "backpressure under starvation".
- Additionally start the client reader concurrently with `AttachViewer` (goroutine), mirroring real browser behavior.
- Acceptance: `go test -race -count=100` green on the package.

**Real product bug found (file separately)**: replay can silently abort under backpressure yet still deliver `replay_done`, so real clients believe replay completed when a suffix was dropped. Fixing this properly (e.g. closing the viewer on replay abort so the client re-attaches, or signaling dropped counts) is a vm-agent behavior change deserving its own PR with infrastructure verification. File as a new backlog task during implementation; do NOT silently fold into this test-infra PR.

### 4. Unmocked fetch in web unit tests (confirmed gap)

`apps/web/tests/setup.ts` stubs `matchMedia` and `ResizeObserver` only. jsdom ships a real `fetch`; components that fetch on mount perform real network calls that fail slowly, log noise, and cause background state updates bleeding into unrelated tests.

**Fix**: stub `globalThis.fetch` in setup to reject immediately with `Unmocked fetch: <url> — mock this call in your test`. Run the web suite and properly mock any tests that were unknowingly relying on real fetch.

### 5. Pattern audit

Audit `apps/web/tests` and `packages/acp-client/tests` for:
- sync `getBy*`/`toBeTruthy` assertions immediately after an `await waitFor(...)` that only asserts a mock was *called*
- sync assertions immediately after `fireEvent` on handlers that are async

Historically flaky files to re-check: `repo-selector.test.tsx`, `agents-section.test.tsx`, `workspace.test.tsx`, `useChatWebSocket` tests (previously patched in PRs #867, #878, commit 3217faa06).

## Implementation Checklist

- [x] Fix ToolCallCard lazy-load test: `await screen.findByText('No output.')` for final UI state
- [x] Set `configure({ asyncUtilTimeout })` (CI-realistic, env-tunable constant) in `apps/web/tests/setup.ts` and the acp-client test setup
- [x] Verify `useAvailableCommands` refreshKey test is structurally sound (assertions in waitFor) and covered by the raised async timeout
- [x] Fix `TestSessionHost_ReplayDoesNotDropMessages`: `ViewerSendBuffer` sized above replay volume + concurrent client reader; no `time.Sleep`
- [x] File backlog task for the vm-agent product bug: silent replay abort still sends `replay_done` (suffix loss invisible to clients)
- [x] Add fail-fast fetch stub to `apps/web/tests/setup.ts`; fix all tests that break because they relied on real fetch
- [x] Audit web + acp-client tests for the sync-assert-after-async pattern; fix instances found
- [x] Archive `tasks/backlog/2026-04-11-fix-flaky-useAvailableCommands-test.md` and `tasks/backlog/2026-02-28-fix-flaky-vm-agent-tests.md` through the tasks/ flow (resolved by this work)
- [x] Verification: 5x consecutive green `--coverage` runs for each touched JS suite (matching CI conditions); `go test -race -count=100 ./internal/acp/` green

## Hard Constraints

- NO vitest `retry` config, NO CI re-run/auto-retry logic — user explicitly rejected retries (2026-07-04)
- Test-side fixes preferred; production code only for the separately-filed replay-abort bug (own PR)
- No `time.Sleep`-based synchronization in Go tests

## Acceptance Criteria

- [x] All five scope items fixed; no retry mechanism introduced anywhere
- [x] Touched JS suites: 5 consecutive green runs with `--coverage`
- [x] Go: `go test -race -count=100` green for `packages/vm-agent/internal/acp/`
- [x] Unmocked fetch in web unit tests fails fast with a clear message
- [x] Both pre-existing flaky-test backlog tasks archived with resolution notes
- [x] Product bug (silent replay abort) filed as its own backlog task

## References

- `.claude/rules/02-quality-gates.md` — regression tests, prohibited patterns
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — vm-agent concurrency test conventions
- `tasks/backlog/2026-04-11-fix-flaky-useAvailableCommands-test.md` (superseded analysis)
- `tasks/backlog/2026-02-28-fix-flaky-vm-agent-tests.md` (superseded analysis — Option A invalid, ingestion is synchronous)
- Prior flake fixes: PRs #867, #878, commit 3217faa06
