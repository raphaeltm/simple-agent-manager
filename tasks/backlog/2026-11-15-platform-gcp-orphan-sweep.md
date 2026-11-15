# Authenticate platform GCP orphan reconciliation

## Problem and findings

The selected platform cloud credential goes through the static provider builder in `apps/api/src/scheduled/provider-orphan-reconciliation-core.ts`. That builder rejects every GCP credential, including workload identity and service-account keys. Failed runs retry on each five-minute cron because only successful scans stamp the hourly interval. User/project inventory already uses the GCP-aware exact resolver and isolates account failures.

Classification (b). Read-only production check November 15 ~00:03 UTC: one enabled platform Hetzner credential, no platform GCP; one active user GCP and three user Hetzner credentials, no project credentials. Narrow Nov14–15 failure-signature log query and Nov1–15 platform-error search found none. Production GCP inventory has three exact-installation VMs, all claimed by nonterminal nodes, zero orphan candidates. No observed orphan charges. Findings delivered to coordinator before implementation (event 785862fd-96a5-4790-b4b5-4aa128f116de).

The sweep recovers billable provider VMs left without a live D1 claim by create/crash races. Exact installation, environment, managed label, valid node label, minimum age, validated D1 claims, and final immutable identity/ownership checks authorize deletion. This task changes authentication only.

## Checklist and acceptance

- [x] Investigate main, production credential shapes, logs and read-only cloud inventory; report before fix.
- [ ] Add behavioral regression through real `runProviderOrphanReconciliation`, real GCP config/token path and provider HTTP boundary; demonstrate red before fix.
- [ ] Support platform workload identity and service-account keys through existing GCP token provider/factory, retaining the platform credential's owner context.
- [ ] Prove foreign/legacy resources never reach DELETE, with owned positive control; prove per-credential failure isolation.
- [ ] Keep static provider configuration and orphan ownership/selection unchanged.
- [ ] Run lint, typecheck, tests and build; specialist reviews and task-completion validation.
- [ ] Coordinate shared staging, deploy, verify real platform GCP workload identity and safe deletion/preservation; bound test spend to cents and clean up immediately.
- [ ] Recheck production first-run deletion risk; stop before merge if newly enabled deletion is expected.
- [ ] PR, green CI, best-effort CodeRabbit wait, coordinator final review, normal merge gates.
- [ ] Monitor production deployment; basic health and next sweep log check only.

## References

- SAM task 01M7E7PHTQH57W6EPC8ZJQ3VP8; coordinator 01M7AF82KG9C78WAABTG3V1MN1.
- Idea 01M77HYN8N41MQ17TQZ622PPPV, R13 D7; investigation note 01M7E8AQBH1K4V7KRH5YAGHY4D.
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`.
- API scheduled isolation rule 53; shared predicate rule 67; root proxy-signal rule 74.
- Existing provider orphan real-boundary tests; GCP token owner/factory and catalog seed conventions.
