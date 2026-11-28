# Teardown should remove the staging fake AI upstream Worker and custom provider

## Problem

PR #3021 creates `<prefix>-fake-ai-<stack>` (workers.dev) and the AI Gateway custom provider
`<prefix>-test-upstream` on staging deploys (`scripts/deploy/fake-ai-upstream.ts`). `teardown.yml`
deletes the gateway but not these two. Both are inert (gated 404, no bindings or secrets), but the
slug stays reserved account-wide. Found by the cloudflare-specialist review of #3021 (LOW).

## Acceptance Criteria

- [ ] Teardown of a staging installation deletes the fake Worker and its custom provider (idempotent, 404 is success)
- [ ] Production teardown never touches them (the plan refuses production)
- [ ] Test covering both
