# Row-count gate: churning tables need an absolute floor

## Problem

The post-migration row-count gate (`scripts/deploy/d1-migration-safety.ts`) caps a churning
table's decrease at a percentage (`DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT`,
50%). On a table that holds one or two rows, any single legitimate delete exceeds it.

## Context

Deploy Production run 42414497735 (commit f8ea41c1a, #2571, 2026-11-07) was blocked with
`vm_provisioning_leases: 1 -> 0 (100.000% decrease exceeds 50% churning-table limit)`. The
migration (`capacity_pool_source_order`, additive) had applied cleanly. A task released its VM
provisioning lease between the before and after counts. Re-running the job passed because no
migration was pending.

`vm_provisioning_leases` is already listed in `DEFAULT_D1_MIGRATION_CHURNING_TABLES`: the
percentage cap alone cannot tell a one-row release from a wipe.

## Acceptance Criteria

- [ ] A churning table may shrink by up to a configurable absolute number of rows (with a
      `DEFAULT_*` constant and env override) regardless of percentage; above that the
      percentage cap still applies
- [ ] Business tables keep zero decrease tolerance
- [ ] Tests: 1 -> 0 on a churning table passes; a large churning table losing more than the
      cap still blocks; a business table 1 -> 0 still blocks
