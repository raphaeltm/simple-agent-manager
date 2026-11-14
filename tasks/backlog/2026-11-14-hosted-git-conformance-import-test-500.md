# Hosted git conformance: the import test fails with HTTP 500 in the harness

## Problem

`pnpm --filter @simple-agent-manager/api test:hosted-git`, test "imports the source default branch
and history into a new hosted project", fails on sam/selfhost-pass-2 @ ea7ffb415 (found while
working on task F3, November 14, 2026): `resolveImportDefaultBranch` gets `HttpError: HTTP Error:
500` from isomorphic-git's `listServerRefs`, although the test's fake forge (outboundService in
`tests/hosted-git/hosted-git-conformance.test.ts`) answers `GET /sam-test/source.git/info/refs`
with 200. The failure is the same with and without F3's ref-prefix change. CI does not run this
suite (`ci.yml` has no `test:hosted-git` step), which is also how the missing repo-hosting wiring
in `tests/hosted-git/support/hosted-git-entry.ts` (fixed in F3) went unnoticed.

Suspect: the Node `fetch` response the outbound handler returns to Miniflare (decoded body with
the original content-encoding/length headers), not the import code.

## Acceptance Criteria

- [ ] Root cause found with evidence (harness or product)
- [ ] The import test passes
- [ ] Decide whether CI should run `test:hosted-git` on the self-host branch, and add it if so
