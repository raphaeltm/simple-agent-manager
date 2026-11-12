# Spike S1: self-host secrets out of the fleet bucket, root key in an operator-chosen key service

Task 01M77B0FEAZ32TYVYJ7NC9JHNN, idea 01M77AG90EQB4F9VAKDVH94ZK4. Draft PR to `sam/selfhost-pass-2`,
never main, not merged. Design lives in the PR body (Design, Proof, Limits, Migration, Later).

## Checklist

- [x] Runtime delivery under celld measured on the real runtime (celld 0.6.3; no later release)
- [x] Key provider interface + conformance suite (file, transit, gcp-kms fake, azure-kv fake)
- [x] OpenBao transit proven in a container (live suite)
- [x] Sealed bundle format, deploy-side sealing, migration from plain files, backup exclusion
- [x] Tests: conformance, bucket/backup contains no plaintext, Worker fails closed
- [x] security-auditor once on channel + bundle; CRITICAL/HIGH fixed
- [x] Draft PR + channel post

## Overrides from the dispatch

No staging, draft only, skip CodeRabbit and the Playwright visual audit.
