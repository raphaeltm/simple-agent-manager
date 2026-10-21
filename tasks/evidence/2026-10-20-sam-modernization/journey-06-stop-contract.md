# Journey06 stop-contract evidence

Journey06 (`e68e328e-12e4-4028-a6f2-970812d0cb93`) failed; it is not a passing release receipt and must not be replayed. Its immutable ledger SHA256 is `e7ccffeea9da60be46fb9c080dd653f964daf10c1799dad6c06a350d443dfaf3`.

The run passed dispatch, actual Astra High project-worker contract, initial answer/source link, follow-up and recovery. Stop confirmation returned HTTP 200 after 21.619 seconds with a completed receipt. Repeated confirmation retained that receipt without another action. The combined postcondition requiring cancelled task, stopped session and absent workspace failed; individual observed statuses were not recorded, so the exact failing conjunct cannot be reconstructed from this ledger.

Source review established that terminal task status is preserved and VM workspace deletion is deferred by TTL. It also found a separate correctness defect: legacy cleanup swallowed node-stop failures before writing stopped state. Control-plane state alone therefore cannot establish runtime acknowledgement. The correction requires strict SAM failure propagation and a fresh scoped VM `workspace.stopped` event, separately from final resource deletion. This does not retroactively validate Journey06.

All six cleanup steps were confirmed. Exact original dedicated-account budget restoration completed at 23:15:56 UTC; independent readback at 23:17:39 confirmed SAM already OFF, original noncustom 500k input/200k output limits, original other settings, and unchanged baseline inventory (4 nodes, 7 workspaces). The restore-only backstop was cancelled after proof.

Usage delta was 115405 input and 2723 output tokens. Recorded model-rate accounting is USD0.0123574; retaining USD0.1024 VM and USD0.10 ancillary allowances gives USD0.2147574 for this run and USD1.1467154 cumulative additional accounting. No active budget override or reservation remains. These are conservative task accounting figures, not an atomic provider billing cap.

Final correction validation and a fresh bounded live journey remain required before release.

The implemented API correction is SAM-only: stop acknowledgement failures propagate to an uncertain receipt, repeated confirmation performs no additional stop, and ambiguous attached-resource states/identities cannot be treated as acknowledgement. Existing non-SAM cleanup behavior remains unchanged. SAM reports stopped-or-absent workspace state rather than claiming deletion; receipt grounding rejects legacy deletion-only or cancellation-only evidence. Root validation passed 126 API tests across five suites and full API TypeScript checking. Independent API review passed with 88 targeted tests. The final VM-event helper passed 49 tests, strict TypeScript and lint, including empty/unavailable baseline and stale/wrong-scope acknowledgement rejection. Root independently reran all 49 helper tests. Fresh CI, staging deployment and live journey remain required.
