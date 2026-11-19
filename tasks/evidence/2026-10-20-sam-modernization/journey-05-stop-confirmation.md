# Journey 05: stop confirmation acknowledgement timeout

Candidate: `a911880b8fc14dcd35f229426da31502a98d4b7c`; application still deployed at Opus-approved `07a1e3b1aca17fc1ce7775615ff5daa37f5a1e92` (subsequent changes are tests/evidence).

The bounded live journey passed initial dispatch, applied Astra High runtime contract, answer, source link, exactly one follow-up delivery, and interrupted-follow-up recovery with preserved receipts. It failed `Scoped stop confirmation accepted`. Full confirmed stop is **not passed**.

Cloudflare retained logs for the exact confirmation endpoint establish:

- POST request `554bccbb0f5298b3dced83b9904cdab6` returned HTTP 200 at 2026-10-20 22:11:57.123 UTC, duration **18,097 ms**.
- The test's response waiter allowed **15,000 ms**, then began fallback cleanup.
- Task cleanup started at 22:11:51.241; another cleanup started at 22:12:01.188 and reported workspace already stopped at 22:12:01.212.
- A later read of the exact stop receipt returned `uncertain`. This is distinct from the pre-click `approval_required` snapshot in the failed ledger.

The response deadline was insufficient for this observed request. HTTP 200 alone does not establish successful stop: the controller can return an uncertain receipt after an operation exception. Cleanup cancellation/opt-out can fence an in-flight operation; the retained evidence does not identify the exact exception. Do not retrospectively convert this run to a pass, retry its confirmation, or replay its runner.

The test helper now preserves safe acknowledgement status/category/timing and reads the exact existing receipt after a failed acknowledgement without another confirmation request. No raw response body, private prompt, canary, or secret is copied into evidence. The original failure remains a failure even if the later receipt completed.

All six cleanup receipts are confirmed. Exact original dedicated-user budget restored at 22:12:13 UTC; independent readback at 22:13:33 confirms SAM already OFF, original noncustom settings/effective 500,000 input and 200,000 output limits, and unchanged baseline inventory. A subsequent saved-receipt inspection ended with OFF verified. Restore-only backstop cancelled after restoration proof.

Usage delta: 118,693 input / 3,424 output tokens. Conservative additional accounting: $0.0128965 model + $0.1024 VM + $0.10 ancillary = **US$0.2152965**; aggregate **US$0.931958**, with no unresolved reservation or override. These are conservative accounting figures, not an atomic provider billing cap.

Immutable failed ledger SHA-256: `99a32e50de9d21d7f27e4da9b525f6c4597eb4cf6d711d6056ac2f511f39a646`.

The correction uses the existing 90-second stop phase, bounded by the overall work deadline. It reserves two ordinary request slots and allows at most 60 seconds for confirmation acknowledgement; ordinary requests remain 15 seconds. The source stop path can await two 5-second background signals, a 5-second cleanup delay, and a 30-second interactive workspace operation plus bookkeeping. This test allowance is not a production completion guarantee. Budget is rechecked after saving intent and before subsequent requests. Success still requires a completed receipt, stable repeated-confirmation receipt, cancelled task, stopped session, and removed workspace before fallback cleanup.

Independent architecture validation: 23 focused tests passed, including observed 18.097-second delayed success, full acknowledgement timeout, reduced remaining budget, post-save expiry without clicking, and post-acknowledgement deadline exhaustion without repeated POST. Strict targeted TypeScript, lint and diff checks passed.
