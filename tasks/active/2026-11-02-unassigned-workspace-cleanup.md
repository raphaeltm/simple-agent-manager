# Recover unassigned direct-provisioning workspace deletion

## Scope

Complete original PR2458 test cleanup (provider upgrade already shipped via2484). Tracking idea01M68ZK972ZAP9YD4BZSD1H1S2. Do not mutate closed2458 branch or bypass deletion proof. No new VM, credential expansion or forced DB state.

## Research

- Own workspace01M68Z6WYTAYJ1F048V7SCXREG remains stopping/node_idNULL/deletionproofNULL. Oldnode01M68Z6WJV8ZK41HE8EVWW7GYJ absent; deleted_by_owner audit at2026-10-31T16:18:16.702Z.
- workspace-deletion.ts requires nodeId for VM deletion; node-row absence/audit alone are not strict proof.
- Deterministic workspace-create:<id> NodeLifecycle retains direct-provisioning intent including exact original node/incarnation/placement credential generation.
- Exact credential resolver and complete fail-closed Hetzner inventory already exist. Other provider inventory is not accepted as absence proof.
- Existing finalizer fences workspace owner/project/chat/generation and propagates lifecycle closure. Reuse existing DELETE; no admin endpoint/UI needed.

## Checklist

- [x] Inspect current cleanup, task credential-generation metadata, and node audit read-only.
- [x] Implement narrowly fenced terminal-intent/provider absence confirmation for unassigned explicit deletion, requiring the original strict-owner deletion audit.
- [x] Preserve blocking behavior for active/foreign/reassigned intent, in-flight provisioning, credential rotation, existing/ambiguous/incomplete provider inventory.
- [x] Prove behavior with real D1/DO and provider HTTP tests; run relevant type/lint checks.
- [x] Independent Cloudflare/security/completion review; fix findings.
- [ ] Coordinate staging with2493owner01M6DRSWKJP4387Z2JWXY0ZDFA before mutation; deploy/verify existing orphan cleanup without new VM.
- [ ] Exact-head CI/Sonar, CodeRabbit request/wait, merge and basic production smoke; retain cleanup evidence and handoff2457.

## Acceptance

Authenticated explicit DELETE can finish this unassigned orphan only after original durable intent matches ownership/generation and terminal provisioning cannot replay, exact original Hetzner credential generation resolves, and complete provider inventory proves original node allocation absent. Changed/unknown state remains pending. Existing finalizer supplies terminal proof/lifecycle consistency. Actual staging workspace and node absent after supported cleanup. No repeated provisioning, forced DB writes or credential expansion.

## Design review

Independent Cloudflare/security/constitution review PASS. This historical recovery reuses the existing strict providerless Hetzner absence contract, requiring an immutable original credential generation, complete inventory across all incarnations, and the original strict owner-deletion audit. A fabricated historical timeout is not used as proof. Terminal saved intent stays sealed under its DO lock; active work rejects reconciliation. It shares strict deletion’s existing provider late-completion assumption.

## Local validation

Workers direct-provisioning suite: 19 passed, including authenticated DELETE confirmed/pending, actual D1/DO/provider HTTP and ProjectData closure. Existing real-SQL DELETE routes: 16 passed. Ownership lookup markIdle regressions: 5 passed. API typecheck, targeted ESLint, formatting, file-size limits and diff whitespace passed. Independent infrastructure/security/constitution and completion/test/documentation reviews passed. Staging and release gates remain pending.
