# Fix data race in vm-agent port scanner

## Problem (what & why)

`Scanner` (`packages/vm-agent/internal/ports/scanner.go`) runs a background
goroutine (`Start()` → `loop()` → `scan()`). Two fields are read from a
DIFFERENT goroutine — the HTTP diagnostics handler at
`packages/vm-agent/internal/server/ports_proxy.go:214-215` calls
`scanner.ConsecutiveFailures()` and `scanner.ContainerResolved()` concurrently
with the running scan loop. This is a genuine cross-goroutine data race that
`go build -race` / `go test -race` would flag.

Unsynchronized accesses:

- `ConsecutiveFailures()` (scanner.go:110-112) reads `s.consecutiveFailures`
  with NO lock.
- `ContainerResolved()` (scanner.go:114-117) reads `s.containerResolved` with
  NO lock.
- Writes in the loop goroutine, all WITHOUT the mutex on these fields:
  - `scan()` line 166: `s.consecutiveFailures = 0`
  - `recordResolutionFailure` line 317: `s.consecutiveFailures++` (plus repeated
    reads)
  - `handleScanFailure` line 338: `s.consecutiveFailures++`
  - `resolveContainerReplacing` lines 285-287: reads `s.containerResolved`,
    writes `s.containerResolved = true` and `s.consecutiveFailures = 0` — these
    three lines sit immediately AFTER the `s.mu.Lock()/Unlock()` block (277-280)
    that correctly guards the adjacent `containerID` write. One field in the
    critical section is protected and two are dropped — a clear oversight.

## Research findings

- The caller (`ports_proxy.go` `handleListWorkspacePorts`) runs on the HTTP
  server goroutine, distinct from the scanner loop. Confirmed genuine race, not
  theoretical.
- Existing tests (`scanner_test.go`) read the fields directly only AFTER
  `Stop()`, so no test currently exercises the getters concurrently with the
  loop — `-race` does not catch it today.
- `parser.go` reviewed: pure functions, no shared state, clean. No changes.
- `sync.RWMutex` is NOT reentrant, and the two fields are mutated immediately
  before/after existing `mu` critical sections in `scan`/`handleScanFailure`/
  `resolveContainerReplacing`. A mutex-guarded helper approach risks
  reentrancy/deadlock. `sync/atomic` is the idiomatic fix for a shared counter +
  boolean flag.

## Fix (how)

Convert the two fields to `sync/atomic` types.

1. Struct (scanner.go:54-64): `consecutiveFailures int` → `atomic.Int64`;
   `containerResolved bool` → `atomic.Bool`.
2. `NewScanner` (67-82): construct the struct, then call
   `s.containerResolved.Store(cfg.ContainerID != "")` before returning (atomic
   types can't be set in a struct literal).
3. Getters: `ConsecutiveFailures()` → `int(s.consecutiveFailures.Load())`;
   `ContainerResolved()` → `s.containerResolved.Load()`.
4. Writers/readers use `.Load()/.Store()/.Add(1)`:
   - `scan()` 166: `s.consecutiveFailures.Store(0)`
   - `resolveContainerReplacing` 285-287:
     `wasResolved := s.containerResolved.Load(); s.containerResolved.Store(true);
     s.consecutiveFailures.Store(0)`
   - `recordResolutionFailure` 316-335: `n := s.consecutiveFailures.Add(1)` then
     use local `n` for the `== 1`, `%6 == 0`, and log/event fields.
   - `handleScanFailure` 337-360: `n := s.consecutiveFailures.Add(1)` then log
     `n`.
5. Update same-package tests in `scanner_test.go` that read the fields directly
   (167-168, 219-220, 284, 330, 348) to use `.Load()`.
6. Add `"sync/atomic"` import to scanner.go (already imported in test file).

## Regression test (rule 02 — the test that would have caught it)

Add `TestScanner_ConcurrentDiagnosticsGettersRaceFree` to `scanner_test.go`:
start the scanner loop (resolver flaps failure/success so the loop mutates both
fields), then from a separate goroutine call `scanner.ConsecutiveFailures()` and
`scanner.ContainerResolved()` in a tight loop for the duration, then `Stop()`.
Fails under `go test -race` on current code; passes after the atomics
conversion.

## Implementation checklist

- [x] Add `"sync/atomic"` import to scanner.go
- [x] Struct: `consecutiveFailures atomic.Int64`, `containerResolved atomic.Bool`
- [x] `NewScanner`: post-construction `s.containerResolved.Store(cfg.ContainerID != "")`
- [x] `ConsecutiveFailures()` → `int(s.consecutiveFailures.Load())`
- [x] `ContainerResolved()` → `s.containerResolved.Load()`
- [x] `scan()` 166 → `s.consecutiveFailures.Store(0)`
- [x] `resolveContainerReplacing` 285-287 → Load/Store
- [x] `recordResolutionFailure` → `n := s.consecutiveFailures.Add(1)`, reuse `n`
- [x] `handleScanFailure` → `n := s.consecutiveFailures.Add(1)`, log `n`
- [x] Update `scanner_test.go` direct field reads → `.Load()`
- [x] Add `TestScanner_ConcurrentDiagnosticsGettersRaceFree`

## Acceptance criteria

- [x] `go test -race ./internal/ports/...` passes (including the new concurrency test)
- [x] `go vet ./...` clean
- [x] `go build ./...` succeeds
- [x] The new regression test fails on the pre-fix code (verified once)
- [x] No behavior change to port detection, event emission, or diagnostics output

## Scope / non-goals

- Do NOT split scanner.go (539 lines) in this PR — the defect is the race; a
  cosmetic split would inflate the diff. Note as a minor follow-up only.
- parser.go is clean; no changes there.
- vm-agent-only concurrency-correctness fix; primary verification is
  `go test -race` + `go vet` + `go build`.

## Post-Mortem

- **What broke**: No user-visible failure was reported — this was found by a
  proactive spot-check. `Scanner.ConsecutiveFailures()` and
  `ContainerResolved()` read `s.consecutiveFailures` / `s.containerResolved`
  from the HTTP diagnostics-handler goroutine
  (`ports_proxy.go:214-215`) while the background scan loop mutated the same
  fields without synchronization — a genuine cross-goroutine data race that
  `go test -race` flags.
- **Root cause**: When the diagnostics getters were added, the two fields were
  read outside any lock. In `resolveContainerReplacing`, the adjacent
  `containerID` write sits inside an `s.mu` critical section but the two
  race-prone fields were left just outside it — one field protected, two
  dropped. The getters had no lock at all.
- **Timeline**: Latent since the diagnostics getters were introduced. Found and
  fixed 2026-07-01 during a codebase spot-check.
- **Why it wasn't caught**: Existing tests only read the fields directly AFTER
  `Stop()`, so no test ran the getters concurrently with the loop; `-race` had
  nothing to flag. Test suite proved the fields were readable, not that they
  were race-free under concurrent access.
- **Class of bug**: Unsynchronized shared state exposed to an HTTP handler
  goroutine while a background loop mutates it — "diagnostic/getter reads a
  loop-mutated field without synchronization."
- **Process fix**: Added `.claude/rules/46-vm-agent-diagnostic-getter-sync.md`
  requiring vm-agent getters exposed to the HTTP server to synchronize access to
  any field a background loop mutates, plus a concurrent-getter `-race`
  regression test. This is the rule that, had it existed, would have blocked the
  original getters from merging unsynchronized.

## References

- `.claude/rules/02-quality-gates.md` — regression test that would have caught it
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — process fix (this PR)
- Go `sync/atomic` — idiomatic shared counter/flag
