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

## References

- PR #1312 security-auditor + cloudflare-specialist review rows
- rule 42 (track deferred behavior-degrading placeholders / follow-ups)
- Mitigation context: T3 tag→digest pinning + signed `ComposeHash`
