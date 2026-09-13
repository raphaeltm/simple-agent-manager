# Investigate staging capacity-query and deployment-reset error noise

## Evidence

Found during compact archive staging verification. The standard `pnpm quality:observability-noise` 24-hour check on 2026-09-08 reported two medium findings in staging observability D1 `8c2fa46c-3b89-428b-b235-d835b7914106`:

- 65 identical workspace SELECT failures, first 08:54:32 UTC and last 09:05:10 UTC. The query includes capacity-pool/provider-instance fields from the separate capacity-policy branch. The stored message truncates before the underlying SQL cause, so the cause is not yet established.
- 20 `Durable Object reset because its code was updated.` errors, all at 08:23:29 UTC.

Both sets predate deployment of the compact archive Worker (first API deployment began 09:08:06 UTC). Prior staging runs 34202813781 and 34205401491 deployed the capacity-policy branch. Do not attribute these errors to compact archival without new evidence.

Workers telemetry query was unavailable (403); persisted D1 errors were accessible.

## Next steps

- [ ] Inspect full traces for the workspace query failures and establish the schema/deployment mismatch or other actual cause.
- [ ] Verify whether failures continue after the current staging deployment.
- [ ] Determine whether deployment-triggered DO resets need handling or lower-severity classification without hiding real failures.
- [ ] Rerun the standard observability noise check after remediation.
