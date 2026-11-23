# Complete project socket admission checks after #2867

## Problem and evidence

Late CodeRabbit findings on merged #2867 remain on main cbe74795c: accepted sockets receive broadcasts while their post-admission membership lookup is pending, and a failed lookup leaves them open. Suspension retries also skip memberships removed between attempts. These enforce the existing active-member/non-suspended-account boundary; no new authorization model is introduced.

## Plan and acceptance

- [x] Reproduce pending-read broadcast delivery and failed-read survival with controlled ordering, legitimate streaming controls, and real Workers upgrades.
- [x] Keep pending sockets visible to revocation; persist readiness in hibernation attachment and exclude them from every broadcast until verified. Finish proof before returning101; reuse initial/reconnect snapshot refresh so legitimate clients recover withheld updates. A close during lookup must win over promotion.
- [x] Close inconclusive lookups with retryable1013; confirmed denial remains4403; a later authorized reconnect works. Missing project identity must not bypass verification.
- [x] Reconcile the separate suspension retry finding with independent reviewers and preserve any justified residual. Do not widen the existing unbounded request fan-out without an explicit I/O/throughput plan.
- [x] Make the existing late-admission regression independent of another test's removal.
- [x] Correct security docs/backlog claim; preserve independent lifecycle residual in SAM Idea.
- [ ] Local quality, independent adversarial/specialist/completion review, exact-head CI, best-effort CodeRabbit and leased real staging/cleanup; production deployment/basic health only.

One D1 admission lookup remains per opened socket, zero per frame; readiness adds no I/O. Existing socket counts and legacy sockets retain compatibility. No migrations or new tunables.

References: #2867 discussions4612988097/8109/8073/8086/8125; rules25,45,60,62,81. Shared broadcast and admission implementations remain canonical. Historical failed offboarding RPC/signout/sibling socket reconciliation stays in existing backlog; this candidate fixes admission only. The parent API security task remains active for a subsequent serial suspension-retry candidate; no security finding is treated as resolved by deferral.

Residual scanner2868 preserved in SAM Idea01M83YFRZ77ZN55HP5QYW4V444.

Implementation note: proof finishes before101; the project socket refreshes on every successful open. Chat joins the mount read then bypasses prefetch for a fresh list; Overview joins any initial query before exact invalidation. Same project/account scope fences protect delayed state writes. No layout changes. Local mobile/desktop screenshots were inspected for clipping, overflow, readability and hierarchy; independent rubric remains pending.
