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
- [x] Exclusive staging lease; real new VM, heartbeat/access/TLS checks; <=2 VMs, prompt deletion and release.
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

## Staging queue checkpoint
Merged main PR2277 cleanly in3564a6622;79 overlapping boot recovery/preservation/lifecycle-inventory tests passed. Staging claim queued behind NOMEM task01M4DV2PE0ARS834TY69DG3KSF (active claim54); our queued claim uses branchsam/fresh-vms-fail-boot-m06427 and eta45min. Do not deploy until that holder releases. No resources created, no PR yet. Subscriptionee4dcb0e-562d-46e3-968e-f6884a48ae79 remains active. SAM runtime sleep discarded installed dependencies and ignored temporary scripts; recreate staging helpers if needed. Local.do-state.md removed from Git after automated sleep checkpoint tracked it; it must stay local.

## First real staging gate — failed, cleaned
Deployment 37805926298 succeeded on 2dffd2831 (latest 908d545cb only corrects a Workers fixture; that file's 21 tests pass). Controlled owner stop before heartbeat/workspace caused automatic replacement: old node termination confirmed 2026-10-08T16:24:58.687Z, replacement allocated 16:25:05.302Z. The replacement never heartbeated; six-minute first-heartbeat deadline failed with the precise reason and deleted it without a third allocation. Separate uninterrupted control also never heartbeated; cancelled before replacement. All owned nodes and project deleted, D1 active managed VM count zero; lease55 released as failed at 16:41Z. Only one VM was active at any time.

Healthy heartbeat/TLS/access gate remains **FAILED**, not waived. PR2275 was opened automatically by SAM at an earlier checkpoint and has been closed pending successful infrastructure validation; reopen that PR after the gate passes. No production deployment or idea completion.

Diagnosis: effective staging image docker-ce; pinned binary endpoint returns 200. Full generated synthetic cloud-config schema and shell syntax pass, independent full runcmd stub execution reaches completion. Fixed-window Worker telemetry contains only our manual download HEAD probes, no observed VM download GET/certificate requests. Pre-download template commands are unchanged from main; synchronous unattended-upgrades stop and unbounded download are possible pre-ingress blockers, not proven causes. Firewall analytics query unavailable with current token. Actual VM console evidence was unavailable before cleanup.

## Main-template comparison
After checking fresh channel history and deployment runs, acquired staging lease69 (17:00–18:00Z maximum). Main90cbf4ea4 deployment37813244254 and smoke passed. One uninterrupted cx23 with docker-ce and the same pinned agent974b3fd2e: created17:18:31.956Z, heartbeat17:21:36.020Z, ready17:23:07.218Z. Workspace reached running; Playwright dashboard/projects/settings returned200, HTTPS health200, real terminal command returned BOOT_RECOVERY_OK with no page errors at17:24:57Z. Cancelled test task, confirmed workspace deletion, deleted VM/project; D1 active managed VM count0. This establishes a healthy main comparison, not feature-branch acceptance. Feature branch deployment37816522004 is underway for one final uninterrupted VM within the same lease.

Identical realistic-input local rendering also compared main/branch:29901/32289 bytes, both under32768; #cloud-config preserved, schema and POSIX syntax valid, write_files and every pre-download runcmd entry identical. Recovery signs a fresh callback token for the new node identity and clears both provisioning/readiness clocks. Sampled request telemetry across all nodes showed no bootstrap401/403/404/410 during the failed replacement window. These checks have not established the earlier boot failure's cause.

Feature comparison deploy37816522004 completed successfully including smoke. Final uninterrupted node01M4EA25XVPZ78BBXQEWA0DQZT created17:48:01.851Z, still no heartbeat/readiness/error at17:52:59Z. Cancelled task01M4EA1W42CK9A6J01QWB70C11 at17:53 before automatic replacement; node and project DELETE200. D1activeVM0 confirmed, lease69 released failed/cleaned (channel78), Instant directly notified. Exactly2 sequential VMs in this lease. Main passed; feature branch gate remains FAILED. Requested early cloud-init/provider console evidence through coordinator before more paid attempts; no root cause established by local checks. PR stays closed and idea remains uncompleted.

## Bounded binary-download follow-up
Independent sibling deploy7fe65052c (cloud-init template/generator identical to baseline974b) also had a no-heartbeat replacement; our earlier A/B does not establish a branch-specific regression. A later running sibling VM reported API/R2 DNS lookup timeouts. Root cause remains unproven, but initial binary curl had a concrete unbounded DNS/connect/transfer gap. Added CLOUD_INIT_AGENT_DOWNLOAD_TIMEOUT_SECONDS (default60) so failures reach the existing fixed-reason boot callback and bounded replacement. All181 cloud-init tests, lint/typecheck/build,47 deployment-forwarding tests, API build/typecheck and context-budget check pass. Independent review approved; shell exit28 test proves configured deadline argument, reporting, and no continuation, not real DNS timing. Real feature-VM gate still required.

## Final healthy branch infrastructure gate — passed and cleaned
Staging deployment37871217816 succeeded on6e5b463992b616c4eb3ffd87671ddd38b81b2f46 including smoke. Lease154 used one VM only:01M4F6FQDNWDB6DJGVR0ARXH7W created2026-10-09T02:04:45.877Z, heartbeat02:07:20.741Z (155s), ready02:09:06.433Z with expected096afcd8f1211df3fdb414bc101763c75c9ef754 agent. Task01M4F6FF7G2AX8EE3JGPQCNANJ reached running, workspace01M4F6QQ05CB1ZV6B050R4VN7Q. Playwright dashboard/projects/settings200, zero page errors, HTTPS health200; authenticated terminal printed BOOT_RECOVERY_OK at02:09:40.552Z. Agent assistant/tool activity observed; no final assistant canary response claimed. Cold boot155s exceeds the generic two-minute benchmark but is faster than the earlier main control184s and within the empirically justified six-minute readiness budget.

Task cancelled and workspace/node/project deleted successfully by02:14Z; D1 query found no non-deleted/non-stopped nodes. STAGING_RELEASE PASS/cleaned channel156 and direct coordinator handoff sent. Earlier live controlled stop proves termination-before-replacement and bounded exhaustion; final normal VM proves heartbeat/TLS/access. Earlier intermittent boot root cause remains unproven. Latest completion review found no code gaps; release/production bookkeeping remains.
