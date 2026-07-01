# VM Agent Diagnostic Getters Must Synchronize Loop-Mutated Fields

## When This Applies

This rule applies to any vm-agent (`packages/vm-agent/`) struct field that is
BOTH mutated by a background goroutine (a scan/heartbeat/reconcile loop started
via `go`/`Start()`) AND read by a method the HTTP server can call from a
different goroutine (diagnostics endpoints, status handlers, `/ports`, `/logs`,
etc.). The canonical example is `Scanner.consecutiveFailures` /
`containerResolved` in `internal/ports/scanner.go`, read by
`ConsecutiveFailures()` / `ContainerResolved()` from the diagnostics handler at
`internal/server/ports_proxy.go` while `scan()`/`handleScanFailure`/
`resolveContainerReplacing` mutate them in the scan loop.

## Why This Rule Exists

The port-scanner getters read two loop-mutated fields with no synchronization —
a genuine cross-goroutine data race that shipped silently because no test
exercised the getters concurrently with the running loop, so `go test -race`
had nothing to flag. It produced no user-visible failure and was only found by a
proactive spot-check. See `tasks/archive/2026-07-01-vm-agent-port-scanner-data-race.md`.

## Class of Bug

Unsynchronized shared state exposed to an HTTP handler goroutine while a
background loop mutates it. The read "works" and the write "works" individually;
the race is invisible until two goroutines touch the field at the same instant.
Adjacent-field traps are common: a field the loop mutates just outside an
existing `s.mu` critical section (where a sibling field IS protected) looks
protected but is not.

## Hard Requirements

1. **Any field mutated by a background loop AND read by an HTTP-reachable getter
   MUST be synchronized** — either `sync/atomic` (idiomatic for a shared counter
   or boolean flag) or a mutex held on BOTH the read and every write. Do not
   protect only some of the writes.

2. **Prefer `sync/atomic` for a lone counter/flag.** A `sync.RWMutex` helper is
   NOT reentrant; if the field is mutated immediately before/after an existing
   `mu` critical section, a lock-taking getter/helper risks deadlock. Atomics
   avoid that entirely.

3. **Watch adjacent-field traps.** When a field is mutated next to an existing
   `s.mu.Lock()/Unlock()` block, confirm it is actually inside the critical
   section. "It's near a lock" is not "it's locked."

4. **Add a concurrent-getter `-race` regression test.** Start the loop (with a
   resolver/driver that makes the loop actually mutate the fields), then hammer
   the getters from a separate goroutine, then `Stop()`. Include a
   self-validation assertion that the loop actually ran (e.g. resolver call
   count > 0), so a broken setup cannot pass silently. The test MUST fail under
   `go test -race` on the pre-fix code.

## Quick Compliance Check

Before merging a vm-agent change that adds/edits a getter or a background-loop
field mutation:
- [ ] Every field the loop mutates AND a getter reads is atomic or fully
      mutex-guarded on read and all writes
- [ ] No lock-taking getter can deadlock against an adjacent `mu` critical section
- [ ] A concurrent-getter `-race` test exists and exercises real loop mutation
- [ ] That test self-validates the loop ran (guards against a no-op setup)

## References

- Post-mortem: `tasks/archive/2026-07-01-vm-agent-port-scanner-data-race.md`
- `.claude/rules/02-quality-gates.md` — regression test that would have caught it
- `.claude/rules/45-durable-object-concurrency-mutex.md` — the DO analogue
  (concurrency across `await`); this rule is the vm-agent goroutine analogue
