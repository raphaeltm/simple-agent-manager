# Repair primary staging GCP provisioning and stranded nodes

SAM task 01M7NZTWT6AC98R70CGYJJZE0A; branch sam/repair-primary-staging-gcp-jjze0a.
Idea 01M7N20Z6P4VWCGG2C6VMZ4QQA. Merge authorized after /do gates.

## Verified research

Fresh primary /api/gcp/verify and Worker log at 2026-11-18T00:20Z: STS invalid_grant, issuer https://api.sammy.party differs from expected https://api.sammy2.party. GCP read-only IAM and audit: sam-staging-infra (353771248703), sam-pool/sam-oidc was updated by staging2 setup at Nov 17 12:00:31Z. createOidcProvider blindly PATCHes after 409. Do not repoint shared trust or widen issuers.

D1: three affected nodes bind user GCP credential 01M7BS2M65D5PK3XBMMKPV463P, last updated Nov 14 10:23Z. No platform GCP exists. User pool explicitly ranks GCP before Hetzner (balanced/queue). All provider IDs/proofs null, no linked workspaces or provisioning leases. Independent reader inventory found zero VMs. Existing owner-attested manual removal returned 200 for all three at 00:25Z. Retain attested provenance; never call it strict termination proof.

## Preflight

Classes: external-api-change, business-logic-change, security-sensitive-change, docs-sync-change.
GCP setup conflict must read provider and compare issuer before same-issuer update. Unknown/malformed config refuses. No endpoint, callback, secret or identifier default changes. Existing static OAuth callback unchanged. One installation must not overwrite another's trust.
Positive GCP create-not-dispatched sentinel may establish absence only for terminal non-durable allocation, fenced to original placement/incarnation. Intermediate durable retries retain semantics. Never infer absence from STS text or empty inventory.
References: rules19/28/56/62/71, PR2715; official Google WIF configuration and best-practices docs (docs.cloud.google.com/iam/).

## Checklist

- [x] Verify original claims; publish root cause and coordinator status.
- [x] One nonblocking exact IAM task: ask:01M7P0M7X3R0WCA84941B07T4N (read-only identity).
- [x] Supported owner-attested removal for historical nodes, no D1 edits.
- [x] Confirm final node/tunnel state and independent provider absence.
- [x] Prevent foreign-issuer WIF overwrite, with regression controls.
- [x] Safe absence proof for unsent terminal allocations; preserve uncertain/durable cases.
- [x] Separate binding-state tests for owner escape against real D1.
- [x] Public setup/troubleshooting docs.
- [ ] Local lint/typecheck/test/build and specialist reviews.
- [ ] Primary staging deploy/live verification, maximum two test VMs cleaned promptly.
- [ ] Canonical 24h noise gate passes; preserve historical evidence while it ages naturally.
- [ ] CI, CodeRabbit, merge and read-only production deploy monitoring.

## Acceptance

Primary trust repaired without breaking staging2 when human IAM task completes; GCP VM provisioning verified. Existing nodes removed via supported escape with named provenance. New unsent allocations reclaimable. Foreign/malformed trust refuses before PATCH. Ownership and durable retry controls pass. New primary deploy passes canonical noise gate; any external blocker remains explicit.

## Local validation and review

WIF isolation regression: original behavior failed 8/9; the fresh-create control passed. Candidate focused 60 tests and 24 Workers tests pass; additional final-write race controls bring node hardening to 38 tests. In an isolated mutation worktree, removing only the final proof/placement predicates makes both races fail (cleared proof resurrected and status overwritten). Removing only the strong binding predicate fails the mismatch case while three other binding controls pass. All six mutation controls pass after restoring the candidate.

Security, Cloudflare, constitution, docs and test reviews pass. API lint, typecheck/build and the 298-page docs build pass. Full API suite running. Context budget passes. Task-completion implementation audit found no additional code/test gaps (A/B/E/F pass, D not applicable); overall WARN because live IAM/provisioning and canonical noise verification remain unfulfilled. This is not completion or archive approval.

PR2880 https://github.com/raphaeltm/simple-agent-manager/pull/2880. Task-file directmainpush rejected by protected Durable Object Workers check, so taskrecord travels in thisPR. No implementation bypass. Primary staging reservation position4; turn01:36:59Z, durable wake4c1e8738-08b7-4a41-bfa2-79423add4fa4.

The first complete candidate was marked ready at approximately 00:47Z, with full CI and the trusted CodeRabbit label request running in parallel. CI/review subscriptions and a bounded scheduled fallback resume this chat; staging has its separate scheduled turn. No test VMs have been created. The single dedicated-WIF IAM inbox task remains open.

Canonical24h gateaftercleanup: historical nodeerrors67/57/47, sessionverification59, snapshot33, price10; preserve evidence and wait for natural aging after recurrence is fixed. Never claim a shorter windowclears thisgate.
