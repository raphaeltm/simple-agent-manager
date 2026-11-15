# Stabilize the secret-card fulfilment test's clock fixture

## Evidence

During P1 validation on current main plus a backend-only diff, root `pnpm test` failed the first case in `apps/web/tests/unit/components/SecretRequestCard.test.tsx`: the expected Supplied badge was absent. The same file passes19/19 in isolation. No web source changed in P1.

The fulfilled response in that case sets `secretExpiresAt` to2026-11-12T11:05:00Z while the actual test date isNovember15. `useDeadlinePassed` re-evaluates a changed deadline in an effect; after the save, an initial live badge can be replaced by Value expired. The fixture is already expired, so expecting a stable live badge depends on render/effect timing. This explains the failure without implying a production expiry defect.

## Proposed work

- Give the live fulfilment case a future deadline relative to a controlled clock, or freeze its clock explicitly.
- Keep the existing expired-value and crossing-deadline controls.
- Verify the complete file and web/root suites; avoid longer arbitrary waits.

## Reproduction

`pnpm test` under normal workspace concurrency; compare with `pnpm --filter @simple-agent-manager/web exec vitest run tests/unit/components/SecretRequestCard.test.tsx`.

Out of scope for the provider orphan authentication fix; no unrelated source change made.
