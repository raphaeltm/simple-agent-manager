# SAM-hosted git repositories on self-host (B2)

Task 01M76JB81F0G6V1TBRXTBDW4QA, branch `sam/overnight-task-b2-build-bdw4qa`, draft PR #2669
(base `sam/selfhost-pass-2`). Design and measurements: SAM idea 01M75V57RG8GR4NA0KC91TM1J7, notes
"HOSTED REPOS ON DURABLE OBJECTS" parts 1-6.

## Done (see the PR body for evidence)

- [x] Local `Env.ARTIFACTS` backend on a `HostedGitRepo` Durable Object (vendored dgit core, MIT, d5eba04), migration v23
- [x] Git smart HTTP at `https://api.<SAM_DOMAIN>/git/<repo>.git`, token checked on every request (no Caddy change)
- [x] Project create (email-only user), README seed and browsing in-process
- [x] Workspace git-token (host + username), VM agent attaches the token for the bound host
- [x] Caps with clear refusal messages (64 MiB push, 30k objects, 256 MiB storage)
- [x] Conformance + vertical tests with a real git client (Miniflare); manual celld 0.6.3 run
- [x] Security review: HIGH + MEDIUMs fixed and re-verified
- [x] Nice-to-have: import from a public forge URL (allowlist), browsing parity, GC

## Before main

- [ ] Box verification (PR section "How to enable and test on the box")
- [ ] Playwright audit of the onboarding copy change; CodeRabbit
- [ ] Caps as admin settings; CI job for `test:hosted-git`; idle-read timeout for slow pushes
- [ ] Instant (cf-container) runtime support; UI field for `importUrl`
