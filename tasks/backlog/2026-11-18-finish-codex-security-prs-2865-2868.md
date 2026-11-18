# Finish Codex Security PRs #2865, #2866, #2867, #2868

SAM task `01M7PX499FF397BR3VWYTD3HQT`. Previous owner (Codex task `01M7NB9FZNC4CXG6MGXJDQJM1C`) is
parked on an exhausted weekly limit; Raphaël asked Claude agents to finish now.

## Problem

Four draft PRs opened by the Codex Security scanner, each with partial or failing CI:

- #2865 same-site tenant apps can CSRF cookie-authenticated multipart operations
- #2866 late task-comment filtering leaks counts and hides visible threads
- #2867 project WebSockets not bound to actor capabilities
- #2868 mission pause/cancel can race an in-flight scheduler

For each, one at a time: confirm the finding against current `main`; close with evidence if it
is not real or already fixed; otherwise finish the smallest correct fix with discriminating tests
that reach the bug through its real entry point (rules 35, 62), mark ready, pass every gate, merge.
Nested containers in devcontainers must keep working (policy 4b7b5e40).

Raphaël's 2026-11-18 decisions: pre-existing staging error groups are waived (a PR must add no
new error group and must not materially increase an existing one in its own window); use the
normal staging lease queue.

## Research Findings

### #2865

- Confirmed real on `main` `dcf4bf083`: the session cookie reaches `ws-*` pages' requests (same
  site), credentialed CORS only blocks preflighted requests, and multipart/form-data is
  CORS-simple. `library.ts` POST `/upload`, `projects/files.ts` POST `.../files/upload` and
  `transcribe.ts` POST `/` had no origin check. PUT `/library/:id/replace` is preflighted (PUT is
  not a simple method), so CORS already covers it.
- `lib/browser-write-origin.ts` already had `requireExactBrowserOrigin` (interactions, secrets).
- Sibling class found: POST routes that parse JSON with raw `c.req.json()` accept `text/plain`
  CORS-simple bodies. Filed `tasks/backlog/2026-11-18-text-plain-json-csrf-on-raw-json-routes.md`.

## Implementation Checklist

- [ ] #2865: verify, finish, test through the real worker, review, staging, merge, deploy
- [ ] #2866: verify against main, then finish or close with evidence
- [ ] #2867: verify against main, then finish or close with evidence
- [ ] #2868: verify against main, then finish or close with evidence
- [ ] Post results on channel `maintenance.pr-shepherd`

## Acceptance Criteria

- [ ] Each PR is either merged and deployed to production, or closed with evidence
- [ ] Each merged fix has a test that fails with the guard removed and passes with it
- [ ] Each merged fix passed security-auditor review and leased staging verification
