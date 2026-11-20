# Self-host landing slice: sealed secrets (key agent + key providers, on by default)

Task 01M7VQR79T1RA5WVXR7FMGD6ZD. Coordinator 01M7JMXS2JRW6QQMB1356ENPM3, channel
`feature.selfhost-landing`. Landing plan idea 01M72M9AEB933ZY8269D376DKC; history idea
01M77AG90EQB4F9VAKDVH94ZK4 (PRs #2680, #2687, #2692, #2703 into `sam/selfhost-pass-2` only).

## Problem

Main's self-host box runs in plaintext mode: celld keeps every Worker secret in plaintext in the
fleet bucket's deploy manifests. The integration branch built sealed secrets (a box-local key
agent, pluggable key providers, sealed bundles), plus two open findings against it (F9, F10).
Land it on main, self-host only, with no Cloudflare behaviour change.

## Research findings

- F9 and F10 come from the landing-plan findings table (idea 01M72M9AEB933ZY8269D376DKC, note
  01M79RQSWFZYRK9QSHWDK44GR6):
  - F9 (MEDIUM-3, #2680): the bundle id is a bearer capability (bucket deploy vars, agent logs);
    an SSRF from the Worker that can set headers and a JSON body reads every secret.
  - F10 (#2692, decision): agent container starts as root; purge deletes under `deploy/` against
    celld's documented contract; no platform-key rotation; test-box keys exposed.
- Coordinator decisions (event 1934cd17): F9 raw socket + binary preamble; F10 agent as state
  owner, no purge, read-only listing; rotation out of this slice (backlog idea); test-box keys
  stay an owner item.
- Main moved on: platform-keys.ts (init-only generation, identity groups never regenerated,
  prior-deploy evidence), backup encryption with a separate key, restore that gives a clone a new
  installation id, upgrade journal/rollback, CELLD_UID 7103, scripts never write `.env`.
- Main's restore read `platform-keys.json` only: a sealed backup could not have been restored.
- celld supports `cloudflare:sockets` (the SMTP client uses it on the box, L21).

## Checklist

- [x] Port key agent, providers, bundle format, key-service, key-choice, platform probes, status,
      switch, migrate, preflight, plaintext listing and tests from the integration branch
- [x] F9: framed protocol over raw TCP (NUL preamble), Worker uses `cloudflare:sockets`; HTTP
      gets nothing; discriminating test (old agent answers 200 with the secret, verified)
- [x] F10a: agent runs as SAM_KEY_AGENT_UID (state owner) from the start; refuses root; no
      SETUID/SETGID; `--init` prints the line, sealing deploys refuse a missing/wrong one
- [x] F10b: no purge; read-only listing; CLI refuses `--purge`; report offers none
- [x] F10c: rotation left out (no rotation hooks in runtime-secrets); backlog idea filed
- [x] F10d: README/listing/status say copies made before sealing stay until rotation lands
- [x] Carry-in a: one bundle-location seam (`deploy/selfhost/key-agent/bundle-store.ts`)
- [x] Carry-in b: README + `selfhost:secrets status` say a file-key box is never replaceable
- [x] Carry-in c: test that agent VMs never receive bucket or KMS credentials
- [x] Sealing follows main's platform-key rules (`completeSealedPlatformKeys`), dry run writes
      nothing, secrets.env may not override a platform key on a sealed box
- [x] Backups leave out the file key and key-service credentials
- [x] Restore of a sealed backup: clone identity recorded, sealed in by the target `--init` with
      the key copy; refuses without the key
- [x] Upgrade keeps a plaintext box on plaintext (`--key-provider legacy-plaintext`) and says to
      run `secrets migrate`; agent.env changes restart the stack
- [x] Egress fence opens the agent port only on a sealed box (recorded choice included)
- [x] Compose `key-agent` service, `.env.example`, README
- [ ] API tests (runtime-secrets, sealed contract) on the socket protocol
- [ ] Live suite on real celld + MinIO: socket path, fresh install, migrate, switch
- [ ] Validation, reviews, PR, box/VM proof, merge, deploy

## Acceptance criteria

- A fresh install seals with no key setup; the deploy names the provider and why.
- An existing unsealed install migrates (`secrets migrate`) and switches providers
  (`secrets switch`), proven on real celld.
- A correct HTTP request with the real bundle id gets no secret (F9), and the old agent did.
- The agent never runs as root; no purge exists (F10).
- A sealed box can be backed up and restored.
- Cloudflare behaviour unchanged (runtime-secrets only reachable from the celld entry).
