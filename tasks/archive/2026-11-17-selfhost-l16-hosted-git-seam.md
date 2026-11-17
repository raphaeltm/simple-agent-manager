# Self-host landing slice L16: hosted-git seam (no Durable Object)

SAM task `01M7M9F7A5T7MKX15KV5EYT0T8`; plan idea `01M72M9AEB933ZY8269D376DKC` (LANDING PLAN part 2 row C15,
part 6 row L16, part 7 decision D7); coordinator task `01M7JMXS2JRW6QQMB1356ENPM3`; channel `feature.selfhost-landing`.

## Problem

`sam/selfhost-pass-2` serves SAM-native repositories on self-hosted installs from its own git server
(`HostedGitRepo` Durable Object + vendored dgit). Decision D7: do NOT ship that server to production yet;
land only the seam. Raphaël's Nov 14 two-build rule: self-host-only code lives in the self-host build
(`apps/api/src/selfhost/`), never imported by `apps/api/src/index.ts`. On main, Cloudflare Artifacts must keep
working exactly as today.

## Research findings

- Every `env.ARTIFACTS` caller on main: `index.ts` (`/api/config/artifacts-enabled`), `routes/projects/project-create.ts`
  (create, seed-cleanup delete), `routes/projects/crud.ts` (delete on project delete), `routes/workspaces/runtime-git-token.ts`
  (token mint), `packages/repo-hosting/src/repo-browse/index.ts` + `artifacts.ts` (browse). Each checks enabled/binding
  slightly differently.
- Integration `services/hosted-git/backend.ts` mixes the seam (`resolveArtifactsBackend`) with the DO backend
  (`createDurableObjectArtifactsBackend`, tokens, http handler, in-process fetch). Only the seam lands; the DO
  backend registers itself from the self-host build.
- C15 (`workspace-git-source.ts`): integration adds a D1 read when `repository` is not passed. Every caller already
  holds the project row or can add the column to a select it already makes, so the read is unnecessary:
  instant-restore (`row.repository`), instant-session (`input.project`), `_helpers.scheduleWorkspaceCreateOnNode`
  (`linkedProject` row), TaskRunner `loadTaskRunnerProjectRepo` (add column), `resolveWorkspaceGitSourceByProjectId`
  (add column). I/O added per request: 0.
- Production (read-only, sam-prod D1, 2026-11-17): 47 projects, 10 `repo_provider='artifacts'`, 10/10 remotes
  `https://<account>.artifacts.cloudflare.net/...`, 0 empty. C15's new branch never fires on Cloudflare.
- VM agent: `withGitToken` attaches the token only to known hosts; a self-hosted remote `api.<domain>` needs the
  bound `RepositoryHost` for `repoProvider=artifacts`. Server-side credential helper already honours
  `RepositoryHost` (`git_credential.go:isAllowedCredentialHostForWorkspace`). Rollout: new agent + old control plane
  never gets RepositoryHost for artifacts; old agent + new control plane on Cloudflare: C15 never sets it. Compatible.
- `bootstrap.go` is a grandfathered >800-line file: put the new helper in its own file.

## Checklist

- [x] `apps/api/src/services/hosted-git/backend.ts`: `resolveArtifactsBackend`, `isArtifactsAvailable`, self-host
      registration hook (`registerArtifactsBackendFallback`)
- [x] Route all `env.ARTIFACTS` callers through it (index, project-create, crud delete, runtime-git-token)
- [x] repo-hosting `artifacts` port (`resolve`) + wiring; repo-browse uses it
- [x] C15 in `workspace-git-source.ts`, `repository` required on the source type, callers pass it (no new D1 reads)
- [x] vm-agent `isBoundHostedArtifactsHost` in its own file; `withGitToken` + `needsCredentialHelperForConfig` use it
- [x] Tests: backend resolution (enabled/disabled/binding/fallback/binding-wins), C15 (CF host, hosted host, malformed,
      github unchanged) through real callers, Go withGitToken + credential helper with controls, repo-browse port
- [x] Docs sync: no user-facing doc impact. Cloudflare behaviour is unchanged and
      `guides/project-files.md` (ARTIFACTS_ENABLED gate) stays accurate; self-host hosted-git docs ship with the
      self-host build.

## Acceptance criteria

- Cloudflare Artifacts create / clone / push / browse / delete unchanged (staging).
- GitHub project clone unchanged (staging).
- A registered fallback backend serves repositories only when Artifacts is enabled and no binding exists (unit). Deletion cleanup remains available after disabling the flag, matching the Cloudflare binding.
- An Artifacts project whose remote is not `*.artifacts.cloudflare.net` gets cloneUrl + repositoryHost; the VM agent
  attaches the token only to that bound host (unit, Go).
- No D1 read added to any workspace-creation path.

## Review fixes

- cloudflare-specialist: the config test copied the handler, so `/api/config/artifacts-enabled` moved to
  `routes/artifacts-config.ts` and the test mounts the real module; legacy NodeLifecycle payload guard made explicit
  (`typeof repository !== 'string'`).
- go-specialist: the credential helper would answer a bound self-hosted host with username `x-access-token` while the
  clone used `x`; the git-token route now returns `username: 'x'` for a bound (non-Cloudflare) host only, so Cloudflare
  responses are unchanged and already-deployed agents get it. Added Go cases for case, port, empty bound host,
  non-artifacts provider.
- security-auditor: documented that `projects.repository` for Artifacts projects is server-assigned (LOW-1).
- Old agent + new control plane on a self-hosted install cannot clone a hosted repository (no token attached): not
  reachable on Cloudflare, and self-host placement already rejects nodes whose agent build differs from the required
  release (rule 54), so hosted projects only land on agents with this change.

## Takeover validation

- Merged safe deploy main including #2841 (`0c672ddbf`); `quality:no-secret-readback` passes.
- Codex comment 4598971932 addressed: cleanup-only backend resolution preserves disabled-feature deletion without widening serving, creation or token access. Surgical revert: disabled/absent DELETE cases fail, 13 controls pass; restored suite passes.
- Consolidated copied Artifacts creation test setup (Sonar); tests still enter the real production route/schema.
- Focused Cloudflare/security/completion reviews PASS; Go implementation unchanged, prior review retained.
- Staging fresh VM/clone/push and GitHub clone remain pending; production merge hold remains until coordinator lifts it.
