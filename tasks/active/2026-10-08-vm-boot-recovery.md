# Recover fresh VM boot failures

## Problem and evidence
Production task 01M467MSH3527SSD28TKTFHC8W failed after node 01M467ND1CM7J766YCNXHT9P89 disappeared during node_agent_ready. Read-only production D1 verified deleted node, no heartbeat/ready/version, created 2026-10-05 14:32:10Z and deleted 14:46:43Z. Coordinator traced this to the single certificate HTTP 500. Idea 01M2CKKM7QHV8WQTMAB3YAWKRM.

## Research
- origin-ca-certificates.ts makes one upstream request; cloud-init template makes one CSR POST and exits.
- readiness.ts has a version predicate but node-agent-ready-step.ts labels every healthy rejected heartbeat stale.
- claimed-node-availability.ts permanently fails deleted nodes. TaskRunner state is durable; retry budget must survive alarm/restarts independently of per-step retryCount.
- Strict node deletion confirms provider termination with exact credentials; admission lease and task node pointer must be released only after cleanup.
- Callback auth must precede session auth; callbacks must not overwrite running/terminal resources. Avoid storing arbitrary VM diagnostics.
- Never-heartbeat timeout must accommodate observed historical 154–333 second boots; choose configurable 6 minute default, bounded by overall readiness timeout.

## Implementation checklist
- [x] API transient certificate retries with capped backoff, request deadlines and configurable defaults; permanent 4xx fail immediately.
- [x] Cloud-init bounded certificate fetch retry, validate PEM before install, configurable deadlines/backoff; shell/YAML execution tests.
- [x] Authenticated best-effort boot failure callback with allowlisted reasons, no secret output, lifecycle fencing.
- [x] Precise readiness reasons, wrong-version immediate failure, bounded first-heartbeat timeout.
- [x] One durable fresh-VM replacement budget; confirmed teardown before replacement; no workspace/agent replay, reused/BYO nodes untouched; crash-boundary tests.
- [x] Environment/API/operator documentation and unit/integration tests.
- [x] Lint, typecheck, tests, build and local specialist reviews; address all findings.
- [ ] Exclusive staging lease; real new VM, heartbeat/access/TLS checks; <=2 VMs, prompt deletion and release.
- [ ] PR/CI/CodeRabbit gate, merge, production deploy; idea evidence and completion; channel MERGED/DONE and unsubscribe.

## Acceptance
Transient certificate failure recovers without failing task. Exhausted boot failure replaces exactly once, survives alarm restart, then fails with real reason. Wrong version resolves in one poll. No heartbeat expires before 900s without rejecting historically normal boots. No replacement before proven cleanup or after workspace work starts. Production deployment and staging evidence recorded.

## Rules
22 infrastructure gate; 27 fresh binary/VM; 34 callback auth; 72 recovery classification; cloud-init POSIX execution/YAML round trips. Coordination reliability-wave-1008 staging lease and migration claim rules.

## Specialist review
All findings addressed: security reviewer identified pre-workspace warm-claim race; quarantine now applies bounded warm-claim and other-task ownership guards. Completion/test reviewers requested real deletion→replacement integration; added real strict deletion, lease release, provisioning and readiness test with only external providers stubbed. Re-reviews PASS for security, Cloudflare/test engineering, completion, environment, constitution and documentation. Full validation/staging/deploy remain pending.

## Post-mortem
Single-shot Origin CA issuance originated in a34af0662 (#1413); permanent failure for disappeared claimed nodes was made explicit in 71e97323e (#1764). A transient bootstrap dependency failure therefore became a permanent task failure after the readiness wait. Existing tests covered immediate issuance and deleted-node rejection, not transient transport recovery followed by safe replacement. This change adds executable shell fault tests, SQLite callback/recovery tests, strict deletion→provisioning integration, and crash/replay controls. The lifecycle writer inventory explicitly limits this new empty-node compensation path to termination-proven node closure and rejects workspace closure.

## Local validation evidence
Lint13/13, typecheck19/19, build9/9 passed. Focused API71 tests, cloud-init180 tests, deployment forwarding47 tests passed. Recovery/readiness/callback coverage:96.24% lines,88.07% branches. Full root run web4023 tests passed; API run found two expected integration updates (terminal-writer inventory and old generic timeout assertion), both corrected and focused36 tests passed. Full-suite completion still pending; staging is queued behind the shared lease.

Final root rerun passed21/21 tasks; API830files/11653tests passed. All required local validation is green.
