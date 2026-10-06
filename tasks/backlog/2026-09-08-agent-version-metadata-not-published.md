# Publish VM agent version metadata alongside binaries

## Evidence

During PR #2030 staging verification on 2026-09-08, the public
`GET https://api.sammy.party/api/agent/version` returned
`{"version":"unknown","available":false}` while Cloudflare R2 listed both
`agents/vm-agent-linux-amd64` and `agents/vm-agent-linux-arm64`, freshly uploaded
at 18:14 UTC. The `agents/` listing contained no `version.json`.

`apps/api/src/routes/binary-artifacts.ts` reads `agents/version.json` for this
endpoint. The canonical deployment workflow publishes the two VM agent binaries
but does not generate/upload that metadata. This omission is also present on
main at `77806119f`; it is not introduced by the node-pool changes. CLI publishing
already has a separate version metadata step.

## Acceptance

- Generate metadata with the exact deployed commit and build date expected by
  the existing agent-version schema, and upload it with the binaries.
- Cover the deployment contract so publishing cannot silently omit metadata.
- Verify the public version endpoint agrees with the downloaded binary version.

This did not block binary download or heartbeat version verification. Kept
separate from PR #2030's runtime and cleanup fixes.
