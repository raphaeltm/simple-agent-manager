# Automation form and native SamSession flake evidence

Test-only follow-up to PR #2728. Tested code head: `ff8c3471980124eb8ab1abd01d2651956b1a58ab`. No production source or existing test timeout changes. Staging is skipped under the coordinator's explicit test-only authorization. No UI surface changes, so a visual audit has no changed surface to exercise.

## Diagnosis

### GitHub create flow

Historical failures are the same default5000ms case in mainCI43621397675 and PR2722CI43570510620; the latter also lost the following case's Continue button. Locally, the original full file passed: target303.414ms without synthetic load,468.337–646.031ms over3 loaded runs. The5s historical timeout was not reproduced locally, and the subsequent missingContinue is consistent with a timed-out async test continuing against the next DOM, not a proven production UI bug.

The form has immediately resolved API mocks and no debounce. Its35 typed characters each pass through user-event's real0ms timer plus controlled React updates, with the GitHub filter preview rebuilding for each label character. A comparable neighboring webhook case already documents3–4s in CI. Instrumenting `userEvent.setup({advanceTimers: callback})` (real timers unchanged; default callback is a no-op) measured60 wait calls originally and27 with real click+paste events. The focused instrumented target passed609.449ms before/518.565ms after; `web-profile-summary.json` records hashes and counts. Uninstrumented fixed full-file target measured183.900–187.833ms normal and328.609–375.081ms under initial load.

The fix enters through the same routes, radio, event selector, fields and submit controls. Paste uses real DOM input events; request assertions still require `pull_request`, `opened`, `needs-review`, and the complete prompt. It also waits for the resulting detail route so the create mutation settles before cleanup. No API handler or internal form state is injected.

### SamSession fixed-minute window and mock cascade

The production rate limiter correctly keys usage by `floor(Date.now()/60000)*60000`. The original test awaited actual model generation between two POSTs using the real wall clock; CI evidence in incident01M5VSYXMPGMGKFWDVJ8FC90Y5 showed first request09:47:59.980, second09:48:00.013. The202 response was correct after rollover. Its background model call could then outlive the assertion failure and hit the next case's reset shared HTTP mock.

Node fake timers do not control native Miniflare/workerd. A test-only RPC changes `Date.now` within the real worker, preserving actual timers, SQLite, request admission, gateway adapter, Mastra and model completion. Offsets0,59999,60000,60001 around a minute boundary each verify malformed-row repair, exact stored window/usage, same-window429 and exact Retry-After, then advance to the next window and verify202 with a completed real turn. The future aligned2099 epoch prevents real DO alarms being placed in the past.

The native test subclass forwards the original bound `ctx.waitUntil` while tracking its promises. Teardown releases held model responses, drains registered work, then restores the original clock before any mock reset. A5s drain watchdog poisons the runtime before disposal on failure; later cases refuse reuse before touching HTTP/model state. This drains registered native work; it does not cancel arbitrary timed-out JavaScript test bodies.

## Discrimination and failure isolation

All mutations were temporary and restored with SHA256 equality checks; production files are absent from the final diff.

- `github-label-guard-removed.json`: changed real `triggerCreateRequest` to discard labels. Exactly GitHub-create RED;38 other cases PASS.
- `rate-guard-removed.json`: removed actual `OperatorStore.accept` same-window limit guard. All4 boundary cases RED (`202` versus `429`);21 other cases PASS, including the following HTTP-absence case. Unexpected accepted turns drain instead of contaminating the next mock.
- `drain-never-settles.json`: made native drain never settle. First targeted case fails at the5s drain watchdog; the following3 fail with `refusing reuse` before resetting mocks. This injected failure is excluded from stability counts. `drain-fault-summary.json` records exact failures and restored source hash.

## Stability proof

All 120 fresh full-file processes passed: **3,840 assertions, zero failures or skips**.

| File | Normal runs / assertions | Loaded runs / assertions | Target normal median / max | Target loaded median / max |
| --- | --- | --- | --- | --- |
| automation-flows.test.tsx | 30 / 1,170 | 30 / 1,170 | 192.599 / 248.598 ms | 350.554 / 525.337 ms |
| sam-session-do.test.ts | 30 / 750 | 30 / 750 | 128.527 / 182.631 ms | 251.643 / 378.942 ms |

Native target measurements pool the four boundary cases per run. Each run executed all 39 web or 25 native assertions. Per-run summaries include actual total/pending counts and verify every assertion passed against the recorded case-name lists. All six source hashes match across every run and the final files. The observed burner totals were 721.73 CPU-seconds for web and 1,218.19 for native runs. Normal process duration maxima were 8.495 s (web) and 14.106 s (native); loaded maxima were 19.718 s and 31.410 s. Loaded batches of 15 stayed below 10 minutes. Ordinary first checks/profiling and intentional mutation failures are excluded.

Each run uses `pnpm exec vitest run <file> --reporter=json --outputFile=<unique-report>` from its app directory; native SamSession adds `--config=vitest.sam-runtime.config.ts`. No test-name filter or retry. Loaded runs pin the entire pnpm/Vitest/workerd process tree to two CPUs with `taskset -c <pair>`, while two Python `while True: pass` processes each pin to one of the same CPUs. Web pair0,1; API pair2,3. Each foreground measurement process terminates and waits for both children in `finally`. Per-run summaries record observed burner CPU seconds, counts, elapsed time, head SHA and SHA256 hashes of all4 changed test files and both production paths used for mutation. Hashes are checked after EVERY run. Loaded batches use15 runs per command to remain below10minutes.

## Other validation and reviews

- 11 API dependency builds PASS (fresh main required rebuilding previously stale local dist artifacts).
- API and web typechecks PASS.
- Full API/web lint: 2 tasks PASS (2 preexisting web warnings); API/web build: 16 tasks PASS. All 3 shared native-runtime files PASS: 66 assertions (35 grounding, 6 live-stream, 25 SamSession).
- Local test review: PASS; Cloudflare review: initial P2 unbounded drain addressed and re-review PASS; completion review PASS for implementation/local validation. The reviewer independently recomputed all cohort counts, unique run indices, case lists, CPU evidence and current source hashes.

Draft+needs-human-review and coordinator exact-SHA merge approval remain mandatory. Original PR2724 production watch through2026-11-15 11:59:39.619UTC and PR2728 main Test timing tracker remain separate obligations.
