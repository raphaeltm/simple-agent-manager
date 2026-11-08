# Prevent sleeping sessions with commands still running

## Request and constraints

Task 01M6Y0Y2AXG9K755ZE2RG1SDCC; idea 01M6XYQFD4J74KJ69G43PTR39P.
Investigate production first. Preserve the 30-minute stale-turn default and existing two-hour work ceiling. Prove actual commands remain protected, hung turns expire, and finished work sleeps. Record decisions durably. Test one small staging VM with temporary short stale-turn setting; restore and delete resources. Open PR after targeted checks, merge only after gates, complete idea after merge.

## Evidence and unresolved questions

Affected session 948ffa93-12b3-497e-be38-43687e1450d0 used openai-codex. Production sleep traces: 2026-11-07 00:51:04.838Z,14:01:25.941Z;2026-11-08 14:21:13.708Z.
Each follows peer disconnect/LoadSession recovery (00:14:10.770Z,13:22:14.701Z;13:41:52.148Z). Pre-sleep activity callbacks show prompting, runtimeWorkState inactive/count0, progressAt1794010457253/1794057742563/1794145320756 respectively. Last reports observedAt1794012605132/1794060053791/1794147606664. Exact historical work_at, runtimeWorkUpdatedAt and classifier verdict are not recorded in snapshot traces; callback receipt/progress are evidence, not substitutes for missing stored decisions.
November8 workspace resource samples continue CPU after recovery (no per-process attribution, no cgroup OOM). Cannot infer a command's identity or result owner from CPU alone. Archived tool payload lookup returned no records for that window. Narrow node debug-package reads found no OOM/panic matches; downloaded raw package must be deleted before finish.

Trace: ACP SessionUpdate → applyACPToolCallLifecycle → harnessWorkSnapshot → reportActivity → activity HTTP callback → ProjectData session_state/work clock → checkAutomaticSessionSleepEligibility/classifySessionIdleness → snapshot teardown gates. Runtime restart resets the tool set; crash recovery currently completes the attempt with recovered and reports idle. Review outstanding on whether the old prompting rereporter is stopped.

## Preflight

Classes: cross-component-change, business-logic-change, infra-change, docs-sync-change.
No new external service or trust boundary planned. Reuse existing harness lease, canonical classifier, bounded diagnostic retention. No default increase. Root cause remains unconfirmed; implementation must follow evidence.
Existing managed workspace is on the assigned output branch; preserve startup .codex/config.toml change. Task artifact stays on assigned branch rather than switching this live managed workspace to main.

## Checklist

- [x] Read idea, task instructions, prior implementation context, and production story.
- [x] Correlate all three sleeps with pre-sleep activity callbacks and crashes.
- [ ] Identify command payloads/lifetimes and exact reporting failure, or explicitly establish missing evidence and reproduce via real runtime.
- [ ] Fix evidenced condition and preserve bounded sleep controls.
- [ ] Persist sleep decision reason and relevant clocks through existing diagnostic surface.
- [ ] Real reporting-path regression and hung/finished controls, defaults via resolver.
- [ ] Guard-removal proof for each added guard.
- [ ] Targeted checks, push, early PR; full suites in CI.
- [ ] Local specialist reviews and completion validation.
- [ ] Coordinate staging, one small VM, short stale-turn setting, actual runtime test.
- [ ] Restore settings, delete resources; record evidence.
- [ ] CI, CodeRabbit request/wait, resolve findings, merge, production deploy/basic smoke.
- [ ] Update and complete idea only after merge; report task completion.
