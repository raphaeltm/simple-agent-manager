# Journey 02: preserved failed staging receipt

Candidate application: `07a1e3b1aca17fc1ce7775615ff5daa37f5a1e92`.
CI 39485995410, E2E 39485991869 and staging deployment/smoke 39486491489 passed. Cloudflare Worker traffic was 100% on this commit; frontend deployment step matched it.

Run `401d81c2-de41-4fca-82d3-8724740de785` ran 2026-10-20 20:10–20:18 UTC. One `sam_chat_start` receipt completed, with stable task/session identity and private-marker exclusion. The owned node became healthy, a workspace was created and a fresh Codex runtime heartbeat was observed. The complete journey **did not pass**: before the initial answer, a workspace-detail GET returned HTTP 500. No follow-up or user-confirmed stop acceptance is claimed.

Platform error context at 20:17:33 UTC identifies `GET /api/workspaces/:workspace`, `causeCode: D1_ERROR`, `d1Category: other`. The stored message redacts the failed query and has no underlying cause. A specific database root cause is therefore unknown. The old test diagnostic combined workspace-list and detail paths and aborted on the first failed read. Subsequent inventory reconciliation succeeded; that alone does not establish the original cause.

The harness correction distinguishes list/detail paths and permits at most three allowlisted GET attempts for 500/502/503/504 within the original request deadline. Failed attempts remain in sanitized evidence. Persistent errors, authorization failures, 404/429, malformed JSON and transport failures remain failures. Mutations are never retried by this helper. Offline coverage includes recovery, persistent errors, authorization during recovery, invalid JSON, unknown paths and deadline exhaustion.

Cleanup: owned workspace, empty node and temporary profile deleted; baseline inventory unchanged. The runner could not confirm SAM opt-out, so the root reconciled it explicitly and verified OFF at 20:20:59 UTC. Budget restoration was verified by the runner at 20:18:03 and independently read again during reconciliation: original noncustom settings, effective 500,000 input/200,000 output, other fields unchanged. Restoration backstop was cancelled only after this proof.

Usage delta: 23,358 input / 1,092 output tokens, USD0.0026634 at recorded Gemma rates. Retaining the full conservative USD0.1024 VM and USD0.10 ancillary charges yields USD0.2050634 for this attempt; cumulative task-attributable accounting is USD0.3063594 of the approved USD5 monthly increase. This is conservative accounting, not a claim of an atomic provider billing cap.

The immutable original failed ledger SHA256 is `29c03b88eefa6977e9644d68c8e766faa8d4a4fbddf4acbf1c722d4ff2f22421`. Private provider/session data remains local. The used runner must not be replayed. A fresh bounded journey remains a release gate after review of the harness correction.
