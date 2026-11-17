# L17a: reverse tunnel API foundation

## Problem
Land the integration branch's leases, frps authorization and provisioning on main without shipping self-host-only code in the Cloudflare Worker. Task 01M7KNAMFQC7M8EPZN6HNGT3EF; parent 01M7JMXS2JRW6QQMB1356ENPM3. Source origin/sam/selfhost-pass-2; fresh base origin/main 60a11bb27. No cherry-picks. Merge authorized after every /do gate.

## Research and preflight
Classes: cross-component, business logic, security sensitive, infrastructure and docs sync. Existing Cloudflare tunnel lifecycle is canonical; L6 redirect hardening is merged. H1 #2752 is merged into integration only, with self-host entry/config owning HostedGitRepo. Main has no celld packager. celld flat migration projection can append a self-host migration set, so no empty lease table belongs on Cloudflare. Placement posted feature.selfhost-landing event b096a4da-cc2c-4403-b86e-78111eaa8939 before code.

Data flow: provisionNode -> transport driver -> ownership SQL before provider create -> boot renderer -> provider VM; strict deletion -> termination proof -> driver release. Pre-create failure/direct provider deletion release exact incarnation; failed best-effort release remains discoverable by callable backstop. Authz verifies claimed node/incarnation/credential against stored lease and managed VM, plus session and exact proxy port. Stored transport (including NULL tunnel_id) controls heartbeat DNS suppression. L17b owns routing, gateway and scheduled sweep mounting; L18 owns frpc cloud-init; L22 owns full self-host packaging. Missing renderer must fail before provider create.

## Checklist
- [ ] Shared typed transport lifecycle seam exercised by existing Cloudflare provisioning/compensation/termination.
- [ ] Self-host-only lease config, allocation, release and callable backstop; self-host-only additive migration renumbered 0255 and packaging manifest.
- [ ] HMAC purpose subkey; frps duplicate-session fence and ownership/lifecycle validation; track credential rotation in a SAM Idea.
- [ ] API F21: stored-transport heartbeat gate with NULL tunnel_id; precise cooling-down vs exhausted allocation errors.
- [ ] F19 real SQL tests: failed-release backstop, direct provider delete, providerless destroying branch and live controls; no CF lease SQL (C18).
- [ ] Prove Worker dependency graph excludes all self-host runtime and migration; Cloudflare/default output unchanged.
- [ ] Document placement, build contract, bounds/throughput and later-slice interfaces.
- [ ] Full lint/typecheck/test/build and required specialists security/Cloudflare/test-engineer/completion plus applicable docs/constitution reviews.
- [ ] Staging queues checked; default + CF tunnel real provisioning/connect/cleanup and migration isolation/sweep no-op proven.
- [ ] Free box claimed; integration-tip candidate built and reverse nodes connect, or explicitly record owed box run if occupied. Post BOX FREE after use.
- [ ] CI/CodeRabbit gates, merge, idea update PR+commit, production smoke and coordinator completion.

## Acceptance
Every item above has automated or documented live evidence. Self-host code is absent from Worker graph; no lease-table UPDATE executes on CF. Existing live nodes and foreign identities cannot lose their lease; confirmed teardown releases only the exact non-live incarnation. Allocation is atomic and never reuses a cooling port. Duplicate controls cannot serve one lease concurrently. All migration work is additive with fresh/upgrade tests. Non-test code target about 1,000 lines.

## References
Idea 01M72M9AEB933ZY8269D376DKC landing plan parts 2–7; rules 11,31,34,74,81; H1 #2752; L6 #2819.
