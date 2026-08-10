# Repository quality scripts

## Scheduled OSV advisory scan

`pnpm quality:osv-policy` validates `osv-scanner.toml` and requires every ignored
vulnerability or vulnerability-ignoring package override to have both an owner-provided reason
and a future expiry date. The check runs in pull-request CI without requiring private routing, so
an unrelated pull request is not blocked merely because the scheduled advisory destination has
not been configured.

`.github/workflows/osv-scan.yml` is intentionally schedule-only and fork-guarded. On a scheduled
run, policy validation fails closed unless both `SAM_OSV_WEBHOOK_URL` and
`SAM_OSV_WEBHOOK_TOKEN` repository secrets exist. The workflow installs the pinned OSV-Scanner
2.5.0 release only after verifying its published SHA256 checksum, then runs
`pnpm quality:osv-advisory`.

The advisory runner withholds vulnerability and package details from public logs and sends only
an authenticated summary count to the configured private SAM intake. It does not create public
GitHub issues or upload scanner reports. Keep the workflow parked until the repository secrets,
the SAM-side private webhook intake, and end-to-end routing verification all exist.
