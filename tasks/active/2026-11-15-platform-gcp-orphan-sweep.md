# Authenticate platform GCP orphan reconciliation

## Problem and findings

The selected platform cloud credential goes through the static provider builder in `apps/api/src/scheduled/provider-orphan-reconciliation-core.ts`. That builder rejects every GCP credential, including workload identity and service-account keys. Failed runs retry on each five-minute cron because only successful scans stamp the hourly interval. User/project inventory already uses the GCP-aware exact resolver and isolates account failures.

Classification (b). Read-only production check November 15 ~00:03 UTC: one enabled platform Hetzner credential, no platform GCP; one active user GCP and three user Hetzner credentials, no project credentials. Narrow Nov14–15 failure-signature log query and Nov1–15 platform-error search found none. Production GCP inventory has three exact-installation VMs, all claimed by nonterminal nodes, zero orphan candidates. No observed orphan charges. Findings delivered to coordinator before implementation (event 785862fd-96a5-4790-b4b5-4aa128f116de).

The sweep recovers billable provider VMs left without a live D1 claim by create/crash races. Exact installation, environment, managed label, valid node label, minimum age, validated D1 claims, and final immutable identity/ownership checks authorize deletion. This task changes authentication only.

## Checklist and acceptance

- [x] Investigate main, production credential shapes, logs and read-only cloud inventory; report before fix.
- [x] Add behavioral regression through real `runProviderOrphanReconciliation`, real GCP config/token path and provider HTTP boundary; demonstrate red before fix.
- [x] Support platform workload identity and service-account keys through existing GCP token provider/factory, retaining the platform credential's owner context.
- [x] Prove foreign/legacy resources never reach DELETE, with owned positive control; prove per-credential failure isolation.
- [x] Keep static provider configuration and orphan ownership/selection unchanged.
- [x] Run lint, typecheck, tests and build; specialist reviews and implementation task-completion validation.
- [ ] Coordinate shared staging, deploy, verify real platform GCP workload identity and safe deletion/preservation; bound test spend to cents and clean up immediately.
- [ ] Recheck production first-run deletion risk; stop before merge if newly enabled deletion is expected.
- [ ] PR, green CI, best-effort CodeRabbit wait, normal merge gates.
- [ ] Monitor production deployment; basic health and next sweep log check only.

## References

- SAM task 01M7E7PHTQH57W6EPC8ZJQ3VP8; coordinator 01M7AF82KG9C78WAABTG3V1MN1.
- Idea 01M77HYN8N41MQ17TQZ622PPPV, R13 D7; investigation note 01M7E8AQBH1K4V7KRH5YAGHY4D.
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`.
- API scheduled isolation rule 53; shared predicate rule 67; root proxy-signal rule 74.
- Existing provider orphan real-boundary tests; GCP token owner/factory and catalog seed conventions.

## Implementation evidence

Both platform GCP WIF/key tests failed before the fix with configuration errors; after the fix all 74 orphan tests passed. Tests use real encrypted platform credential lookup, parser, token exchange and provider HTTP/delete implementation; foreign and legacy resources are returned beside the owned positive control. Baseline repository lint/typecheck passed. Main task-only push rejected GH013 (required Durable Object Workers); keeping task commits in the feature PR.

## Review and staging preparation

Local security-auditor, cloudflare-specialist, test-engineer, constitution-validator, implementation task-completion-validator A-F and doc-sync-validator all PASS; no findings. Full lint, typecheck and build PASS. Root `pnpm test` rerun PASS: 39/39 package tasks; API 1015 files/15180 tests passed, 3 files/4 tests skipped. Initial concurrent run had one unrelated deployment-error-recovery timeout; isolated file 34/34 and full rerun both passed.

Isolated test-project fixtures (cleanup required): sam-vm-control-plane-test, us-central1-a; sam-orphan-jq3vp8-owned (7791020495571601202, created00:16:29Z) and sam-orphan-jq3vp8-foreign (2345179896148739888, created00:16:31Z), two e2-micro/10GB pd-standard/no public IP/no attached SA. Both stopped after creation; age floor reached01:16:32Z. Conservative total budget < $0.10. Own SA orphan-jq3vp8, own compute role membership, own pool orphan-jq3vp8/provider staging; trust initially refuses all tokens. Must remove all own resources after proof. No shared staging credential/pool/deploy change yet, handoff requested.

Fixture cleanup guard: accepted same-session schedule 76a3a75c-a98b-443d-9481-8025cb2138e2, version 1, due November15 01:45 UTC; cleanup deadline is absolute (no indefinite extension). PRShepherd is coordinating staging queue; no slot granted yet. Both fixture VMs confirmed TERMINATED00:20Z, disks autoDelete. Pool issuer is https://api.sammy.party (matches jwt.ts getIssuer); trust remains false until exact staging platform creator is captured. Full validation completed green at00:49Z; no runtime changes after specialist review.

## Inventory details (unchanged)

The five-minute handler calls the isolated sweep; successful scans default to hourly. The selected enabled platform credential is attempted first (`getPlatformCloudCredential` selects one), then a bounded rotating page of active legacy user/project cloud credentials is resolved by exact reference/fingerprint. Each account failure is contained. Missing/failed inventory is a failure/skip, never authority to delete. This sweep inventories VMs, not detached cloud storage or IPs.

| Provider | Existing inventory |
| --- | --- |
| Hetzner | Paginated project servers with the exact scope label selector. |
| GCP | Paginated aggregate instances across project zones, requiring SAM-managed plus exact scope labels; unreachable zones reject the partial result. |
| Scaleway | Servers in the configured zone plus other supported zones, with scope tags; 404 zones skipped. |
| Vultr | Account instances, then exact scope labels filtered locally. |
| DigitalOcean | Account droplets, then exact scope labels filtered locally. |
| UpCloud | Account servers, then exact scope labels filtered locally. |
| Infomaniak | Authenticated compute endpoint server detail inventory, then exact scope labels filtered locally. |

Core independently checks managed/environment/installation/node/age, validated D1 claims and final immutable identity/ownership before provider VM deletion. Associated auto-delete disks follow provider semantics; detached resources are outside this inventory. The production zero-orphan observation is specifically for GCP VMs in the inspected production project.


## Durable failure reporting follow-up

Coordinator observation e7898474-108f-4d92-b2fc-6ec06c065811 confirmed that contained credential failures previously appeared only in log counters, not durable failed-sweep records. After all credential attempts complete, the scheduled handler now passes a count-only failure through its existing isolator when errors are nonzero. Completed metrics remain available even after partial success, and downstream sweeps continue. No ownership, selection, credential isolation or deletion logic changed.

Two reporting regressions failed before this addition; final real-handler/real-isolator tests cover failed-only, partial-success and zero-error controls, persisted observability context, preserved metrics and downstream continuation. Focused three-file run:16/16 PASS. Follow-up security/Cloudflare review PASS; test-engineer and constitution follow-up PASS after preserving metrics and adding the clean control. Broad validation is being refreshed for the handler delta.
