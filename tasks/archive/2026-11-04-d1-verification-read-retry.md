# Bounded retries for deployment verification reads

## Problem and scope

A transient D1 resource-window rejection can abort deployment while collecting protected-table counts. The subprocess wrapper drops structured diagnostics, so a failed read cannot be distinguished safely from a permanent failure. This blocks release of the merged cron recovery change.

Keep every discovery, count, migration-ledger and integrity check. Retry only a structured resource-limit rejection from a verification read; never retry migration writes. Emit fixed diagnostic categories without subprocess output, SQL, arguments or bindings. No production repair or restore is part of this work.

## Plan and validation

- [x] Search existing implementation and active work; no matching read retry found.
- [x] Injected tests: transient read recovery, exhaustion, permanent errors, malformed output, configuration bounds, privacy and original cause.
- [x] Add bounded configurable read retry; preserve existing write behavior and integrity gates.
- [x] Forward and document deployment-only controls.
- [x] Run targeted and full required checks, then specialist reviews.
- [ ] Coordinate staging, verify deployment and live workflows, clean any own fixtures.
- [ ] Open PR, complete CI and best-effort CodeRabbit gates, merge.
- [ ] Confirm production deployment and bounded read-only health/version smoke.

## Risk and cost

At most five attempts per failed verification read; default three attempts with ten seconds between attempts. Successful reads are unchanged. Permanent/unknown failures and exhausted transient failures block deployment. No new services or schema changes. Root causes of historical application errors are not inferred from deployment diagnostics.

## Review evidence

Cloudflare, security, test engineering, task coverage, constitution, documentation and environment reviews passed with no blockers. Focused tests: 53 passed, including the actual subprocess runner and unchanged write behavior. Script TypeScript and ESLint checks passed. Stable-tree root lint (13 tasks), typecheck (19), tests (21; API 14,921 passed), build (9), all script-quality tests (806), formatting and agent context budget passed. Staging and release gates remain pending.

## Post-mortem

### What broke

An explicitly transient failure of a deployment verification read could abort the entire verification pass.

### Root cause

The subprocess error's message omitted structured stdout diagnostics. Verification reads had no retry boundary, although migration writes and integrity checks must remain strict.

### Process fix

Synthetic subprocess-boundary tests now distinguish transient recovery, exhausted or permanent failure, malformed output and writes. They enforce safe diagnostics and preserve every existing integrity gate. No additional standing rule is needed.
