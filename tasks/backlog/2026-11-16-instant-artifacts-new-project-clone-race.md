# Instant session on a just-created Artifacts project fails its clone

## Problem

Starting an Instant (cf-container) session within seconds of creating an Artifacts-backed project fails at launch:
the task ends `failed` / `launch_failed` with
`standalone git clone failed: exit status 128 ... fatal: could not read Username for 'https://<account>.artifacts.cloudflare.net/git/default/<repo>.git'`.

The VM agent's `standaloneCloneSpec()` (`packages/vm-agent/internal/server/standalone_workspace.go`) logs
"Standalone repository clone proceeding without git token" when `fetchGitTokenResponseForWorkspace` fails and then
clones without credentials, so the real cause (why the git token was unavailable) is hidden behind a git prompt
error.

## Context

Found 2026-11-16 on staging2 during PR #2770's verification (task 01M7G55K6BSR1RPMZK14CAD8KE):

- project created and Instant session started ~5 s apart: failed as above (task 01M7HB3198S8X9EYVAZ9PGPQC2, 04:50Z);
- VM session on the same project 8 min later: cloned and replied;
- fresh project, Instant session started 90 s after creation: cloned and replied (05:08Z).

So the Artifacts repository or its token is not ready immediately after project creation, and the standalone
path has no retry. The onboarding flow creates a project and starts an Instant session back to back, so real users
can hit this.

## Acceptance criteria

- [ ] Identify why the git-token request fails right after Artifacts project creation (Worker logs for
      `/api/workspaces/:id/git-token` at that moment)
- [ ] Either make project creation return only once the repository can mint tokens, or retry the token fetch in
      the standalone clone path with a bounded, configurable budget
- [ ] When no token can be obtained for a repository that needs one, fail with the token error instead of an
      unauthenticated clone's "could not read Username"
- [ ] Test that drives create-project then immediately start-Instant-session and asserts the clone succeeds
