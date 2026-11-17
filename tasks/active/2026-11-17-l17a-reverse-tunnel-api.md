# L17a: reverse tunnel API foundation

## Problem
Land the integration branch's leases, frps authorization and provisioning on main without shipping self-host-only code in the Cloudflare Worker. Task 01M7KNAMFQC7M8EPZN6HNGT3EF; parent 01M7JMXS2JRW6QQMB1356ENPM3. Source origin/sam/selfhost-pass-2; fresh base origin/main 60a11bb27. No cherry-picks. Merge authorized after every /do gate.

## Research and preflight
Classes: cross-component, business logic, security sensitive, infrastructure and docs sync. Existing Cloudflare tunnel lifecycle is canonical; L6 redirect hardening is merged. H1 #2752 is merged into integration only, with self-host entry/config owning HostedGitRepo. Main has no celld packager. celld flat migration projection can append a self-host migration set, so no empty lease table belongs on Cloudflare. Placement posted feature.selfhost-landing event b096a4da-cc2c-4403-b86e-78111eaa8939 before code.

Data flow: provisionNode -> transport driver -> ownership SQL before provider create -> boot renderer -> provider VM; strict deletion -> termination proof -> driver release. Pre-create failure/direct provider deletion release exact incarnation; failed best-effort release remains discoverable by callable backstop. Authz verifies claimed node/incarnation/credential against stored lease and managed VM, plus session and exact proxy port. Stored transport (including NULL tunnel_id) controls heartbeat DNS suppression. L17b owns routing, gateway and scheduled sweep mounting; L18 owns frpc cloud-init; L22 owns full self-host packaging. Missing renderer must fail before provider create.

## Checklist
- [x] Shared typed transport lifecycle seam exercised by existing Cloudflare provisioning/compensation/termination.
- [x] Self-host-only lease config, allocation, release and callable backstop; self-host-only additive migration renumbered 0255 and packaging manifest.
- [x] HMAC purpose subkey; frps duplicate-session fence and ownership/lifecycle validation; track credential rotation in a SAM Idea.
- [x] API F21: stored-transport heartbeat gate with NULL tunnel_id; precise cooling-down vs exhausted allocation errors.
- [x] F19 real SQL tests: failed-release backstop, direct provider delete, providerless destroying branch and live controls; no CF lease SQL (C18).
- [x] Prove Worker dependency graph excludes all self-host runtime and migration; Cloudflare/default output unchanged.
- [x] Document placement, build contract, bounds/throughput and later-slice interfaces.
- [ ] Full lint/typecheck/test/build and required specialists security/Cloudflare/test-engineer/completion plus applicable docs/constitution reviews.
- [ ] Staging queues checked; default + CF tunnel real provisioning/connect/cleanup and migration isolation/sweep no-op proven.
- [ ] Free box claimed; integration-tip candidate built and reverse nodes connect, or explicitly record owed box run if occupied. Post BOX FREE after use.
- [ ] CI/CodeRabbit gates, merge, idea update PR+commit, production smoke and coordinator completion.

## Acceptance
Every item above has automated or documented live evidence. Self-host code is absent from Worker graph; no lease-table UPDATE executes on CF. Existing live nodes and foreign identities cannot lose their lease; confirmed teardown releases only the exact non-live incarnation. Allocation is atomic and never reuses a cooling port. Duplicate controls cannot serve one lease concurrently. All migration work is additive with fresh/upgrade tests. Non-test code target about 1,000 lines.

## References
Idea 01M72M9AEB933ZY8269D376DKC landing plan parts 2–7; rules 11,31,34,74,81; H1 #2752; L6 #2819.

## Work bounds and throughput
Allocation owns one non-compressible loopback port per active lease. One atomic CTE considers at most 20,000 configured ports (default10,000), with indexed active-port/history lookups; the SQL statement processes the entire range, not a batch deferred to another tick. At the outer probable limit20,000 ports and20,001 historical releases, a real SQL entry-point test exhausts the range, diagnoses cooling and reuses the first eligible port in the same attempt. Retained history is unbounded, but the `(port,released_at)` index serves MAX/age lookups without scanning all installation history per candidate. Allocation has no network I/O; provider creation follows only after lease/config and boot validation.

Release/backstop is one local indexed UPDATE over all active leases with a primary-key node lookup per lease, never external network calls and never a count-limited page. Normal maximum active ownership is the configured20k-port range; even ranges changed across upgrades cannot exceed65,535 active rows because of the physical-port unique index. One pass releases all eligible rows; at L17b's existing5-minute cron cadence a missed synchronous release is retried within one tick, without multi-page starvation. Port reuse waits at least2× the configured frps heartbeat timeout (default180seconds), independently of deletion labels. A live incarnation with a fresh heartbeat remains owned regardless of its lifecycle label; a hard-deleted/replaced/proven-terminated incarnation is releasable. Cooling and full range have separate errors and recovery actions.

## Evidence so far
Placement posted before edits, event b096a4da-cc2c-4403-b86e-78111eaa8939. Draft PR2831. Pure failure-finalization extraction76aa97a2a; oldCF27tests and typecheck passed. Rootlint22/typecheck36 PASS. Focused105assertions PASS before final safe-row/owner/CA/manual additions; root test/build running. F19/authz independentTE42/42 PASS; expanded allocator/C18 suite46 PASS. Surgical removals reddened exactly F21 NULLtunnel_id cases, ownership-drift auth case, all3 session-op cases and all3 CF release-SQL cases; restored. Security finalPASS. Rotation recovery tracked idea01M7KPNV3B28WPEVJRNRAM2X1D. No live resources allocated yet. Primary staging reserved via44007258922 (queue success, deploy skipped intentionally), position4 projected04:13:57UTC at03:05 check; both staging queues were checked. Required future gates stay unchecked.

Final incremental security/Cloudflare PASS, combined completion implementation readiness PASS with live gates pending. Renderer callback excludes Cloudflare-specific version field; regression passes. Full-root suite has three long unrelated API tests timing out under parallel local load; investigate/rerun before calling validation complete.

## Sonar PR 2831 follow-up

The SQLite migration finding `AaHnfqh6jf_tJyvZU1Yz` (`plsql:S1192`, repeated `active` literal) is a false positive: this is SQLite DDL, not PL/SQL; SQLite has no named constants usable across a column default, its CHECK constraint and a partial index. The repeated literal is the canonical persisted status in each required location. Preserve the additive migration; no SQL rewrite or scanner exclusion is warranted. The six TypeScript findings are addressed with equivalent encoding, explicit transport selection, sequential isolated releases and smaller failure-finalization helpers; deletion stays in the existing inventoried module with its original proof predicates.
