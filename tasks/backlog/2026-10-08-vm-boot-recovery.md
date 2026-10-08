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
- [ ] API transient certificate retries with capped backoff, request deadlines and configurable defaults; permanent 4xx fail immediately.
- [ ] Cloud-init bounded certificate fetch retry, validate PEM before install, configurable deadlines/backoff; shell/YAML execution tests.
- [ ] Authenticated best-effort boot failure callback with allowlisted reasons, no secret output, lifecycle fencing.
- [ ] Precise readiness reasons, wrong-version immediate failure, bounded first-heartbeat timeout.
- [ ] One durable fresh-VM replacement budget; confirmed teardown before replacement; no workspace/agent replay, reused/BYO nodes untouched; crash-boundary tests.
- [ ] Environment/API/operator documentation and unit/integration tests.
- [ ] Lint, typecheck, tests, build and local specialist reviews; address all findings.
- [ ] Exclusive staging lease; real new VM, heartbeat/access/TLS checks; <=2 VMs, prompt deletion and release.
- [ ] PR/CI/CodeRabbit gate, merge, production deploy; idea evidence and completion; channel MERGED/DONE and unsubscribe.

## Acceptance
Transient certificate failure recovers without failing task. Exhausted boot failure replaces exactly once, survives alarm restart, then fails with real reason. Wrong version resolves in one poll. No heartbeat expires before 900s without rejecting historically normal boots. No replacement before proven cleanup or after workspace work starts. Production deployment and staging evidence recorded.

## Rules
22 infrastructure gate; 27 fresh binary/VM; 34 callback auth; 72 recovery classification; cloud-init POSIX execution/YAML round trips. Coordination reliability-wave-1008 staging lease and migration claim rules.
