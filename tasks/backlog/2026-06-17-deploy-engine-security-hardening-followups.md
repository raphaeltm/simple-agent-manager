# Deploy-engine security hardening follow-ups (deferred from PR #1312)

## Context

Deferred MEDIUM/LOW findings from the PR #1312 (`app-deployment-mvp-hardening`)
security re-audit on 2026-06-17. None were merge-blocking — the two "HIGH"
findings in that audit were stale-code false positives (already fixed in-branch
at `image-resolver.ts:162-172`/`:87-91` and `diskstate.go:96`). These are
genuine but low-priority hardening items captured per rule 42 so they are not
lost.

## Problem

The agent-first deploy pipeline (registry-credential minting → signed
`ApplyPayload` → vm-agent apply) has several defense-in-depth gaps that do not
block the MVP but should be tightened.

## Acceptance Criteria

- [ ] **Sign `RegistryCredentials.Server` (MEDIUM, defense-in-depth).** Include
      the credential server host in `buildSignableBytes` (`signature.go`) and the
      TS signing path (`deploy-signing.ts`) so a swapped registry server
      invalidates the Ed25519 signature. Keep the password out of the signed
      bytes. Update the deliberate-omission comment at `signature.go:95-99`.
      Add Go + TS contract tests that the signature covers `Server`.
      Note: currently mitigated — the image is pinned by the signed
      `ComposeHash` (T3 digest), so tampering can only fail the pull.
- [ ] **Reduce registry-credential TTL 60→15 min (MEDIUM).**
      `DEFAULT_REGISTRY_CREDENTIAL_EXPIRATION_MINUTES` in
      `registry-credentials.ts` — the credential is only needed during
      `docker compose pull` at apply time, not for the full signed-payload hour.
- [ ] **Escape/constrain `extractParam` key (MEDIUM, latent).**
      `image-resolver.ts:139-143` builds `new RegExp(\`${key}="..."\`)` without
      escaping `key`. Keys are currently literals (`realm`/`service`/`scope`) so
      it is not exploitable, but make the function private/inline or escape the
      key to remove the footgun.
- [ ] **`redactSensitive` username (LOW).** Pass `username` alongside `token` in
      the `cache.DockerLogin` error path (`cache.go:100`) so it cannot surface
      in `state.ErrorMessage` → heartbeat → UI.
- [ ] **`deployment_environments.nodeId` UNIQUE constraint (LOW).** Enforce the
      MVP one-environment-per-node invariant at the DB layer to eliminate the
      FNV host-port band birthday-collision risk (`deployment-routing.ts:63`).
      Revisit if multi-environment nodes become a goal.
- [ ] **`composeDown`-failure retry on redeploy (LOW).** `engine.go` swallows a
      `composeDown` failure (logged `slog.Warn`) before `composeUp` of the new
      release; if the old containers still hold the port, both the new up and the
      rollback up fail. Add a short port-free confirmation or retry.

## Test-coverage follow-ups (deferred from PR #1312 test-engineer review, 2026-06-17)

None of these block #1312. The Go↔API `fetchRelease` contract is exercised
end-to-end by the live staging deploy chain; `cache.DockerLogin` is already
unit-tested directly (`engine_test.go:932-973`, the review's "HIGH" claim that it
tests a facsimile was a stale-code false positive).

- [ ] **`fetchRelease` URL/auth contract test (rule 23).** `fetchRelease`
      (`engine.go:394-395`) constructs `GET {ControlPlaneURL}/api/nodes/{nodeId}/deploy-release?seq=&environmentId=`
      with `Authorization: Bearer {CallbackToken}`. This path/auth is pre-existing
      (untouched by #1312) and has no Go-side `httptest` contract test asserting the
      URL template + Bearer header match the `deploy-release-callback.ts` route
      registration. Add `TestEngine_FetchRelease_URLAndAuth` using
      `httptest.NewServer`.
- [ ] **`RegistryCredentials`-out-of-signature behavioral assertion.** Add a
      `signature_test.go` case that signs a payload, then sets `RegistryCredentials`
      on the struct post-sign and asserts `Verify()` still returns nil — documents
      the deliberate design (`signature.go:95-99`) as a behavioral test rather than a
      comment. Pairs with the "sign `RegistryCredentials.Server`" item above (if that
      lands, this assertion flips to expect failure on `Server` mutation).
- [ ] **Token-exchange failure test (LOW).** In `image-resolver.test.ts`, add a case
      where manifest HEAD returns 401 with a Bearer challenge and the token endpoint
      returns 403; assert `ImageResolveError` is thrown with an auth-failure
      `statusCode`.

## Go-specialist follow-ups (deferred from PR #1312 go review, 2026-06-17)

Neither blocks #1312. The review's two highest findings were stale-code false
positives verified against current source: the `cache.DockerLogin` test calls the
real function (`engine_test.go:955`), and the revert path already tears down the
partial new release before re-upping the previous one (`engine.go:323-331`).

- [ ] **`docker logout <registry>` after apply (MEDIUM, defense-in-depth).**
      `cache.DockerLogin` persists creds to `~/.docker/config.json`; nothing removes
      them on success/failure. Bounded today by short-lived minted token TTL. Add a
      `cache.DockerLogout(ctx, registry)` helper and a best-effort deferred logout in
      `engine.go` after a successful login.
- [ ] **`go mod tidy` for `yaml.v3` (LOW, cosmetic).** `packages/vm-agent/go.mod:23`
      marks `gopkg.in/yaml.v3 v3.0.1 // indirect`, but `mount_guard.go` imports it
      directly. Run `go mod tidy` to move it to the direct-require block (prevents a
      future unexpected CI diff). Not merge-blocking — CI is green and the checksum is
      valid.

## References

- PR #1312 security-auditor + cloudflare-specialist review rows
- rule 42 (track deferred behavior-degrading placeholders / follow-ups)
- Mitigation context: T3 tag→digest pinning + signed `ComposeHash`
