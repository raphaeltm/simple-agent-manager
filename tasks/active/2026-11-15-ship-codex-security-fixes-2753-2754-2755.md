# Ship corrected versions of Codex Security PRs #2755, #2754, #2753

Parent task: 01M7DJT04N8DYW1T5VF30ETCQZ. Executing task: 01M7FPX2RR5JSJ1CYG6QPXY9VG.
Coordination channel: `feature.codex-security-fixes`.

## Problem

An automated scanner opened three draft PRs. Each finding was independently confirmed
real on 2026-11-15, but every patch has defects (failing tests, operational regressions,
fail-open code). Ship each one separately, in priority order #2755, #2754, #2753, each
from its own `sam/` branch, closing the bot PR with a link.

## Research Findings

### #2755: bearerless VM-agent `/git-credential` (branch `sam/fix-git-credential-bearer`)

- `isAuthorizedGitCredentialRequest` (`packages/vm-agent/internal/server/git_credential.go`)
  trusted any private/loopback peer, so another project's workspace on the same node could
  fetch a sibling workspace's installation token.
- Bot design (keep): per-workspace random bearer embedded in the helper, validated against a
  0600 SHA-256 digest with constant-time compare.
- Defects: 12 package test failures; token rotates on every `PrepareWorkspace`, while a running
  container keeps the old bind-mounted helper inode (401 on every fetch after rebuild/restart/
  recovery); failure cleanup deletes the digest under a running container; old helpers send no
  bearer; standalone digest keyed only to `cfg.WorkspaceID` with a warn-only empty-ID path;
  digest installed after `configureGitCredentialHelper` in the docker-cp path.

### #2754: stale MCP tokens after membership removal (branch `sam/fix-mcp-token-membership`)

- `validateActiveWorkspaceMcpToken` (`apps/api/src/services/mcp-token-lifecycle.ts`) never
  checks `project_members` or `users.status`.
- Keep: LEFT JOINs inside the existing query (0 extra round-trips); `deployment:deploy` check in
  `routes/project-deployment.ts` before identity-token cache/signing.
- Defects: 7 broken tests; suspended/invited permanently revoke (no recovery after unsuspend);
  per-tool capability map in `routes/mcp/index.ts` fails open, has mocked tests, disagrees with
  REST; security docs not updated.

### #2753: concurrent first sign-ups both become superadmin (branch `sam/fix-first-superadmin-election`)

- `user.create.before` in `apps/api/src/auth.ts` reads "no real users" before the insert.
- Keep: atomic election (platform_settings marker insert + guarded UPDATE in one D1 batch).
- Defects: 2 failing tests; migration 0242 silently demotes all but the oldest superadmin;
  `establishFirstSuperadmin` lacks "only real user" guard; election has no try/catch (D1 error
  blocks sign-in); self-heal recovery path not documented.

## Implementation Checklist

### #2755

- [x] Whole `go test ./internal/server` and `./internal/bootstrap` pass
- [x] Token stable for the workspace lifetime (reuse on reprovision) AND in-container reinstall when the container's helper bearer is not accepted
- [x] Failed PrepareWorkspace does not delete digest under a running container (only removes a bearer it minted, and only with no running container)
- [x] Tests: reprovision against a running container (real Docker bind mount) then exchange with the old helper's token; bearerless old helper replaced; recovery and snapshot-restore paths already assert the runtime workspace ID reaches PrepareWorkspace
- [x] Old-helper policy decided per rule 54 and stated in PR
- [x] Standalone: empty ID fails closed with an error log and writes nothing; bearer reused across agent restart; digest installed before git is configured in the docker-cp path
- [x] Helper bearer refused on relayed/tunnel/non-local requests (restored the orphaned `isRelayedRequest` guard)
- [x] security.md documents the exchange (incl. residual risk: host-level access defeats the bearer)
- [x] Review fixes: e2e smoke script sends workspaceId and asserts unscoped/bearerless refusal; minted bearer is written into the existing host inode (repairs a pinned bind mount); lost digest reinstalled from an owned helper; digest/helper reads require owner + O_NOFOLLOW; container `ErrNoRunningDevcontainer` sentinel; standalone helper rewrite skips unchanged content and replaces by rename

### #2755 old-helper compatibility policy (rule 54)

- A bearerless `/git-credential` request is refused (401); there is no compatibility fallback, because that fallback is the vulnerability.
- A node's helpers are written by that node's own agent, and agents are not upgraded in place: a new VM-agent release makes nodes ineligible for new work and they are retired after draining (rule 54 §6-7). Old-agent nodes keep their old (still vulnerable) behaviour until retired; their exposure ends with node retirement (24h absolute lifetime by default).
- Any bearerless or stale helper a new agent does meet (a container restored from an older snapshot, or a helper left by an earlier build) is repaired on the next provisioning: a docker-cp copy is reinstalled, and a bind-mounted one is rewritten in place on the host.
- Instant containers rewrite their helper on every agent start, so no old helper survives a new image.
- Accepted LOW residuals (go-specialist re-review): a reused bearer with a changed helper replaces the host file by rename, so a later forced re-mint can only reach the current inode, not an older pinned one (needs a deliberate digest rotation plus a template change); a digest reinstalled from a helper that survived a partial deletion revives a bearer no container holds; cross-process test-ID collisions in /tmp only affect two concurrent `go test` runs on one machine.
- Coverage of `recoverWorkspaceRuntime` and snapshot restore is at the seam (they pass the runtime's workspace ID into `PrepareWorkspace`) plus the bootstrap layer (real Docker bind mounts); there is no single test from recovery through Docker.
- [x] Staging: fresh agent binary, clone/fetch/push, after restart/rebuild, Instant session, cross-workspace refusal, cleanup (staging2, deploy 43799334260; evidence in PR #2759)

### #2754

- [x] Fix 7 broken tests (fixtures, expectations), reconsider `userStatus === null`
- [x] `suspended`/`invited` reject without revoke; `removed`/deleted user revoke
- [x] Drop per-tool capability map and dispatcher hook
- [x] Real-SQL tests for membership/status branches
- [x] Update `security.md` MCP token acceptance conditions
- [x] File backlog follow-up: stop/revoke removed member workspaces on offboarding (`tasks/backlog/2026-11-15-stop-removed-member-workspaces-on-offboarding.md`)
- [x] Staging: remove member B, B's agent MCP fails; active member's still works (staging2, deploy 43809005915: member call before removal OK, after removal rejected; admin control OK)
- [x] CodeRabbit Major fixed: pending owners rejected (kept) while signup approval is required, same predicate as REST (2d9dd31ff)

### #2753

- [x] Fix 2 failing tests
- [x] Migration (finally `0246_first_superadmin_election.sql`): no demotion; marker only; duplicates surfaced; test second superadmin survives
- [x] "Only real user" guard + tests (sole user suspended, sole user non-admin)
- [x] Election try/catch fails closed without blocking login
- [x] Document recovery path in self-hosting and admin docs
- [x] Staging: existing user sign-in works; D1 superadmins unchanged before/after (staging2, deploy 43812594179; evidence in PR #2772)

## Acceptance Criteria

- [ ] Each PR merged separately with specialist review evidence, staging evidence, CodeRabbit request-and-wait, and green production deploy
- [x] Bot PRs closed with links to replacements
- [ ] PR URL, merge SHA and deploy result published on `feature.codex-security-fixes`
