# Pin Insights Accounts test clock

## Problem and research

On 2026-11-17 after noon UTC, main and PR #2836 API shard2 failed `projectAccounts > attaches the last-reported limit windows to your own accounts only`. The fixture uses NOW=2026-11-16 noon and resets_at=NOW+DAY, but the real credential meter reads Date.now independently of the Insights range input nowMs. The provider window expired correctly, turning71 into0. Production behavior is correct. Reproduced locally:21 passed/1failed; CI6006 passed/1failed/1skipped. Coordinator requested separate test-only PR to unblock main and sibling #2835; no staging needed.

## Implementation

- [x] Pin Date.now to fixture NOW in shared beforeEach so all fixture dates have the same clock.
- [x] Restore mocks after each test.
- [x] Add a control advancing only wall-clock beyond reset and assert utilization becomes0.
- [x] Run focused suite, lint and formatting.22/22PASS; targeted eslint and Prettier PASS; API dependency build12/12PASS.
- [x] Independent test/completion review. PASS/no findings; A-C covered, D-F not applicable to test-only scope.
- [x] Green exact-head CI and CodeRabbit request/wait, then merge.

## Acceptance

All22 Insights Accounts tests pass on later calendar dates; the account meter expiry control returns0 after reset. No production files change. No staging or production writes.

## Process fix

The fixture's shared setup now pins every real Date.now consumer to its fixed dates. The reset control deliberately advances the clock to ensure expiry remains covered. This prevents the test from becoming calendar-dependent without changing the application's meter behavior.

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2861](https://github.com/raphaeltm/simple-agent-manager/pull/2861).
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
