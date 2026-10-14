# Durable GitHub trigger recovery

The October 14 synthetic signed-ingress regression on main `faaf861ba` reproduced the code-backed risk: a routing read failed after delivery claim; the webhook returned 200; same-ID replay after the database recovered created no task. This does not establish production event loss.

The fix stores supported, signed trigger intake in D1 before ACK and processes it through the existing operational cron sweep. A processing lease and compare-and-set finalization prevent stale attempts from changing a newer claim. Per-delivery/trigger unique execution reservations, immutable admission snapshots and existing execution-derived task identities/checkpoints preserve one consequential task across partial success and interrupted submissions. Unconfirmed startup remains retryable. The same reserved-task authorization and TaskRunner idempotency boundaries remain in use.

Defaults: 256 KiB payload cap, 60-second processing lease, exponential 30-second to 15-minute backoff, 12 attempts, 25 rows per recovery/cleanup pass, 24-hour pending payload age and 90-day dedup/audit retention. All are optional Worker variables documented in `.env.example` and the environment reference. Completion and exhaustion erase inbox payloads; the existing execution prompt/audit retention still applies. The operational cron and GitHub trigger kill switches apply. Exhaustion is visible in `github_trigger_inbox.state`, retry/exhaustion logs, and recovery sweep counters. An already-running attempt can finish after its intake expires; expiry is not cancellation of consequential tasks.

Limits: same-ID prevention is bounded by dedup retention. Recovery cannot recover historical events whose payloads were never stored; existing pre-upgrade audit IDs remain terminal, regardless of their old decision. GitHub does not automatically redeliver a failed webhook. A storage failure before ACK or an oversized payload is therefore visible non-success, not a guarantee of eventual recovery. No GitHub-origin natural delivery or production canary proof is implied by synthetic tests or read-only health/configuration checks. No credentials, GitHub permissions, new runtime bindings, or security boundaries are added.

## Release evidence

Pending local validation, independent final reviews, coordinated staging, exact-head CI/Sonar/security, CodeRabbit, coordinator merge clearance, production deployment/migration/health evidence. See task `01M4WJGQK1DNSSRW6HM6A2XQQY` and its task file.
