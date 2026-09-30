# Flaky: TestHarnessActivityReportCoalescesACPToolCallBursts under -race load

## Problem

`packages/vm-agent/internal/acp/session_host_harness_work_test.go`
`TestHarnessActivityReportCoalescesACPToolCallBursts` failed once in 10 runs of
`go test -race -count=10 ./internal/acp/` with
`tool-call burst was not coalesced: reports=2`.

The test sends 13 ACP tool-call notifications and expects one debounced activity
report with a 20 ms debounce window. Under full-package `-race` load the burst can
take longer than 20 ms to deliver, so the debounce fires mid-burst and a second
report is sent. The code under test is likely fine; the test's timing is too tight.
Other debounce/timing tests in the package showed the same pattern
(`TestACPToolCallSettlingLeaseStopsRereporting`).

## Context

Discovered 2026-09-29 while re-verifying the prompt-cancel watchdog fix
(`tasks/archive/2026-09-29-bind-prompt-cancel-watchdog-to-attempt.md`). That change
does not touch the harness activity reporter.

## Acceptance Criteria

- [ ] The coalescing test owns its timing (fake clock or a debounce gate) instead of
      relying on a 20 ms wall-clock window
- [ ] `go test -race -count=50 -run 'Harness|ToolCallSettling' ./internal/acp/` passes
- [ ] The test still fails if coalescing is removed (discrimination check)
