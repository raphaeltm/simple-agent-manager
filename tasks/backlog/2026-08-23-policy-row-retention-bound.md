# Bound total `project_policies` row growth (retention, not just an active cap)

**Filed from**: PR review of the policy lifecycle controls work
(`tasks/active/2026-08-23-policy-lifecycle-controls.md`). Raised independently by the
security-auditor (MEDIUM) and the performance-reviewer (MEDIUM).

## Problem

Policy lifecycle controls added `expires_at`. `getActivePolicies` and the per-project
cap `COUNT` both use `active = 1 AND (expires_at IS NULL OR expires_at > ?)`, so an
expired policy stops being injected **and** stops consuming cap headroom.

Retaining the row is deliberate — `get_policy`, `list_policies`, and the Policies tab
must still show a human that a policy existed and when it lapsed. The consequence is
that **nothing bounds total row count**:

- `removePolicy` is a soft delete (`SET active = 0`), so a row never leaves the table.
- An expired `scope='task'` row is never counted by any ceiling.
- `validatePolicyLifecycle` only requires `expiresAt > now`, so `now + 1ms` is a legal
  expiry. A caller with `add_policy` access (rate-limited to 120 req/min) can therefore
  create rows indefinitely without ever tripping the 100-policy active cap.

The blast radius is confined to the owning project's own Durable Object — each
`ProjectData` DO is a separate SQLite database keyed by `projectId`, so this is a
self-inflicted storage/scan-cost issue, not a cross-tenant vulnerability. It also
grows the `idx_project_policies_active` partial index that `getActivePolicies` scans on
**every** agent session's opening turn, which works against the token/I-O reduction the
feature exists to deliver.

## Why it was not fixed in the originating PR

A hard total ceiling was considered and rejected as written: because `removePolicy` is a
soft delete, there is no way for a project that reached the ceiling to get back under it.
That converts a slow growth problem into a permanent write lockout with no in-product
recovery — strictly worse. Sizing a ceiling requires first deciding a retention story.

## Options to evaluate

1. **Retention window + hard delete.** Hard-delete rows that are `active = 0` AND expired
   more than `POLICY_RETENTION_MS` ago. Needs a deletion path (there is none today) and
   must respect rule 31's caution about destructive DO SQLite operations — DO SQLite has
   no time-travel recovery.
2. **Minimum expiry horizon.** Require `expiresAt >= now + POLICY_MIN_EXPIRY_MS` (e.g. 1
   minute) so a near-instant expiry cannot be used purely to dodge the active cap. Slows
   the vector but does not bound it.
3. **Total ceiling + a hard-delete recovery path**, shipped together so the ceiling is
   escapable.
4. **Index the predicate.** `(active, expires_at)` partial index so the read stays
   index-covered as the table grows, independent of whether growth is bounded.

Options 1 and 3 are the only ones that actually bound growth.

## Acceptance criteria

- [ ] Total `project_policies` row count per project is bounded by an env-configurable
      limit with a `DEFAULT_*` constant (Principle XI)
- [ ] A project that reaches the bound has an in-product path back under it — no
      permanent write lockout
- [ ] Expired-but-recent policies remain visible in `list_policies` and the UI so the
      "why did this stop applying" affordance survives
- [ ] Any hard delete is scoped by a `WHERE` that cannot match a live policy, and is
      covered by a two-sweep test proving a live row is never selected
      (`.claude/rules/47-control-loop-io-budget.md`)
- [ ] A regression test creates rows past the active cap via short-lived expiries and
      asserts growth is bounded; proven discriminating against the current code

## References

- `apps/api/src/durable-objects/project-data/policies.ts` — `createPolicy` cap check,
  `APPLIES_NOW_SQL`, `removePolicy`
- `apps/api/src/durable-objects/migrations.ts` — migration `034-policy-lifecycle-controls`
- `.claude/rules/31-migration-safety.md` — DO SQLite has no recovery mechanism
- `.claude/rules/47-control-loop-io-budget.md` — bounded candidate sets, escape paths
- `.claude/rules/42-no-untracked-degrading-placeholders.md` — why this task exists
