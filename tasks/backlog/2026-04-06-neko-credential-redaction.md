# Neko Credential Redaction in Docker Error Logs

## Problem
`CLIDockerExecutor.RunSilent` in `packages/vm-agent/internal/browser/docker.go` formats the entire `args` slice into error messages using `%v`. When `docker run` fails, the error includes `-e NEKO_PASSWORD=<hex>` and `-e NEKO_PASSWORD_ADMIN=<hex>` in cleartext in structured logs.

## Context
Discovered during security audit of PR #611 (Neko browser device emulation). Pre-existing issue, not introduced by that PR.

## Acceptance Criteria
- [ ] Docker error messages redact `-e` flag values containing `PASSWORD`
- [ ] Existing tests updated to verify redaction
- [ ] No credential values appear in error log output
