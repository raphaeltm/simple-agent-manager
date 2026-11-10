# Track A running notes (raw log; FINDINGS.md is the deliverable)

Setup: celld 0.6.2 at /tmp/spike/bin/celld (sha256 verified), esbuild 0.27.7 from repo node_modules symlinked onto PATH.
Project dir: .tmp/celld/project (gitignored), `src -> ../../../apps/api/src` symlink, wrangler.json generated.

1. `main` outside the project dir -> `Error: config main must be a path inside the project`. Fix: symlink apps/api/src into the project dir (works — symlink accepted).
2. `Error: two r2 bindings name the same bucket: "workspaces-dev-assets"`. SAM binds R2 + PROJECT_DATA_ARCHIVE_R2 to one bucket (prod too: sync-wrangler-config.ts:1240 outputs.r2Name). Fix: generator renames the duplicate's bucket.
3. BOOTED (13:00:46Z). celld bundled apps/api with its own esbuild in 3.8 s, 29.4 MB upload (5.6 MB gzip), WITHOUT the [alias] unicorn-magic shim and WITHOUT no_bundle. Container classes (SandboxDO, VmAgentContainer) still exported and bound as plain SQLite DOs: loads fine. All 20 DO bindings, 2 D1, 2 KV, 2 R2 listed. GET /health -> 200 {"status":"healthy"}.
   Only console warning at module init: workers-oauth-provider "CIMD disabled: add global_fetch_strictly_public".
