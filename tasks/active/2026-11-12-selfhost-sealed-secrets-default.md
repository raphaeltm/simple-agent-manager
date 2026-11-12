# Self-host: sealed secrets on by default, key provider chosen automatically (task K1)

## Problem

Spike PR #2680 (merged into `sam/selfhost-pass-2` at c983bab11) made sealed Worker secrets an
opt-in (`SAM_KEY_PROVIDER`). The owner decided (idea 01M77AG90EQB4F9VAKDVH94ZK4): sealed secrets
on by default, provider chosen automatically (cloud KMS through VM identity on Google Cloud, AWS
and Azure; file key elsewhere), portable, 300 s cache fine, no bundled OpenBao.

## Research findings

- `deploy/selfhost/key-agent/` holds the provider interface (`provider.ts`), providers (file,
  transit, gcp-kms, azure-kv), bundle format and the agent server. Interface stays unchanged.
- `scripts/selfhost/key-service.ts`: deploy-side sealing; `keyServiceEnabled(box)` drives the
  fence (`egress-fence.ts`), profile check and `resolveDeployKeys`.
- Compose `key-agent` service is behind profile `key-agent` and needs `SAM_KEY_AGENT_UID`.
- celld v0.6.3 (source read at .tmp/celld-src): bucket layout `deploy/<script>/<version>/`
  (`manifest.json` holds `raw_metadata.vars`), pointers `deploy/current.json` and
  `deploy/<script>/current.json`, queue attachments `deploy/queues/<q>/consumer.json` naming an
  exact prefix, images `deploy/images/`. celld never deletes or lists old versions; nodes read
  only what a pointer or attachment names (`fleet.rs`, `generation.rs`, `control_plane.rs`).
  celld docs (`docs/guarantees.md`) forbid operators deleting under `deploy/`: behaviour says
  unreferenced versions are dead, the contract says do not delete. Purge therefore: opt-in,
  version-pinned to 0.6.3, only unreferenced versions holding secret vars, rechecks pointers.
- Every Worker request (incl. `/health`) loads secrets first (`runtime-secrets.ts wrapWorker`), so
  `/health` 200 after a sealed deploy proves the agent delivered the new bundle.
- `upgrade-lib.ts stateFingerprint` only hashes top-level `.state` files; `key-agent/agent.env`
  changes must also restart the stack.
- `backup-lib.ts runRestore` only refuses existing `platform-keys.json`; sealed installs keep keys
  in bundles.
- AWS SigV4 vectors: awslabs/aws-c-auth `tests/aws-signing-test-suite/v4` (Apache-2.0).
- Added scope (coordinator, relaying the owner): teardown for everything gcp-bootstrap creates,
  provider-neutral created-resources record, README removal commands for AWS/Azure and box side.

## Checklist

- [x] 1. Default on: auto choice in `--init`, key-agent always in compose, uid self-drop,
      `SAM_KEY_PROVIDER=legacy-plaintext` override, README/.env.example
- [x] 2. Platform probes (GCE, IMDSv2, Azure IMDS) with timeouts; KMS only after round trip;
      fallback file with one-line reason; choice recorded in `.state/key-agent/choice.json`;
      `pnpm selfhost:secrets status`
- [x] 3. AWS KMS provider (IMDSv2, SigV4, EncryptionContext, error classes), conformance vs fake,
      signer vs AWS vectors
- [x] 4. gcp-bootstrap `--kms`: key ring + key + key-level grant, dry-run, prints key ref;
      `--teardown`; created-resources record; README AWS/Azure steps + removal
- [x] 5. File key notice at first seal; `secrets key-file` / `verify-key-copy`
- [x] 6. `secrets migrate` (seal, deploy, verify, remove plaintext, rollback); upgrade finishes
      migration; `secrets plaintext` listing + gated purge; backups listing; rotation guide
- [x] 7. `secrets switch --to <provider|auto>` and `reseal`, agent opens previous provider during
      the switch
- [x] 8. Tests (conformance all providers; auto choice via real init entry with fake metadata;
      live default-on + migration + purge on real celld/MinIO; Cloudflare unchanged)
- [x] 9. Docs in same commits

## Acceptance criteria

- New install with no key setting seals; the deploy output names the provider and reason.
- On a cloud with no key / refused key / slow metadata the choice is `file` with a reason line.
- `legacy-plaintext` keeps old behaviour and README says it stores secrets in the bucket.
- AWS provider passes conformance against the fake and the signer matches AWS vectors.
- Migration removes plaintext files only after verification; rollback on failure.
- Purge never deletes a version named by a pointer or attachment; listing is read-only.

## Added scope (coordinator, relaying the owner)

- [x] gcp-bootstrap teardown (`--teardown`, `--dry-run`, ownership proofs, two-stage KMS removal),
      provider-neutral created-resources record, README removal commands for AWS/Azure and box side
- [x] Merge base 731a171d0 (R3 fixes); migration runs R3's contract chain before switching and
      rolls back when the first request after the switch is unhealthy
- [x] CI items inherited from the spike: outbound-fetch inventory, dependency governance,
      secret scan (expired baseline entry + new fixtures), Validate Deploy Scripts

## Notes

- Google's current docs: Cloud KMS keys and key rings can be deleted once every version is
  destroyed (correction to the brief's assumption); teardown is grant removal, scheduled version
  destruction behind --destroy-key-versions <key>, then a later run deletes versions, key, ring.
- celld 0.6.3: only pointers and queue attachments name versions that are read; docs forbid
  operator deletion under deploy/; purge is opt-in, version-pinned, fail-closed.
- Security review: 0 CRITICAL/HIGH, 3 MEDIUM + 9 LOW fixed (21d040ad1).
- Not run against real services: aws-kms, gcp-kms, azure-kv (fakes only). Real: file, transit
  (spike), celld + MinIO + key-agent image (live tests).
