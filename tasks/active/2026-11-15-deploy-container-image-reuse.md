# Deploys reuse unchanged container images

Task `01M7G55K6BSR1RPMZK14CAD8KE`, coordinator `01M7FXB4800VH9YT1ZZDC2QZ2N`, idea `01M7FYGMEESYH3AJZJ0CT3NKCZ` (older: `01M0QED2G61RWM8Z3TPFCHEQXS` item S1).

## Problem

Every staging and production deploy rebuilds both Instant container images (`apps/api/Dockerfile.sandbox`,
`apps/api/Dockerfile.vm-agent-container`), pushes them under a new digest, and since #2722 waits for the
container rollout. Staging went from 16.6 to 22.7 min median, production from 15.0 to 20.3 min.

Baseline (staging run 43725591242, 2026-11-15): `Deploy API Worker` 376 s, `Wait for container rollout
completion` 347 s, of a 21 min run.

## Research findings

- `wrangler deploy` (4.149.0) builds each Dockerfile with `docker build --load --platform linux/amd64
  --provenance=false`, tags it with the Worker version id, and skips the push only when the local image
  already carries a RepoDigest for the repository (`pushImageIfChanged`). A fresh runner never has one, so
  it always pushes. A layer cache alone would still rebuild the floating `RUN` layers into new bytes.
- `apply()` compares the application's image reference: identical reference and config means "No changes
  to be made" and no rollout. A registry `image` reference skips the build entirely (`image_uri`).
- `sync-wrangler-config.ts` already accepts digest-pinned registry references per container class
  (`SAM_CONTAINER_IMAGE_OVERRIDES`); the installer engine uses it. Reuse that path.
- `waitForContainerRollouts` already accepts "no new rollout" (test "accepts an unchanged-image retry...").
  It still gates on a rollout that is in flight. No change needed there; #2722 stays as is.
- Image inputs (both images built from the `apps/api` context):
  - Sandbox: base `cloudflare/sandbox:0.12.10@sha256:35c9...` (Ubuntu 22.04 jammy); COPY of three
    `apps/api/scripts/*.mjs`; `apt-get install ca-certificates jq wget gh` (Ubuntu archive + cli.github.com,
    unpinned versions); gh keyring URL; `npm install -g` of two exact-pinned CLIs (deps exact).
  - VM agent: base `node:22-bookworm-slim@sha256:d649...` (Debian bookworm) in two stages; apt packages
    (unpinned) plus gh; COPY of codex runtime archive (checksum-verified), codex installer, opencode
    installer (digest-pinned archive), vm-agent binary + version json (content-keyed, reproducible), two
    entrypoint scripts; `npm install -g` of six exact top-level pins whose transitive deps float
    (`codex-acp` wants `@openai/codex ^0.159.1`, `zod ^4`...); `curl https://astral.sh/uv/install.sh`
    (UNPINNED latest uv, which also picks the managed Python); `uv tool install mistral-vibe==2.25.8`
    (96 floating transitive PyPI deps) and `acp-amp` with pinned deps.
- Prior art: `imageContextKey` in `installer-engine-prebuilt.ts` keys only the Dockerfile and copied
  files, so it ignores the floating inputs above. Out of scope here (installer prebuilt path); recorded
  as an open item.
- VM-agent darwin binaries: `make build-all` builds four platforms, `publish-vm-agent-artifacts.sh`
  uploads only linux amd64/arm64. darwin builds are wasted.

## Design

Content key per image = sha256 of: Dockerfile bytes, every COPY source's bytes, build flags, and a
fingerprint of every floating input derived from the Dockerfile text:
- apt: `InRelease` SHA256 index lines (`<component>/binary-{amd64,all}/Packages*`) of every suite the
  stage's base image uses (table keyed by base digest) plus `deb` lines written in `RUN`.
- URLs fetched in `RUN`: content hash.
- `npm install -g`: one isolated `npm install --package-lock-only` per package (global installs do not
  dedupe across packages); hash of resolved versions + integrity.
- `uv tool install`: `uv pip compile` of the spec + `--with` pins for the stated Python.
- Executed build scripts that are COPYed: reviewed list keyed by path and sha256.
Anything unrecognised (unpinned base, ADD, ARG, globbed COPY, unknown installer, variable URL, failed
fingerprint) means no key, and the deploy falls back to Wrangler building the Dockerfile as today.

Deploy step `Resolve container images` (after the vm-agent artifact, before the first `wrangler deploy`):
key → registry tag `inputs-<key>` in the same repository Wrangler uses. Present: reuse its digest.
Absent: build with Wrangler's flags, push, use the new digest. Overrides go to `GITHUB_ENV`
(`SAM_CONTAINER_IMAGE_OVERRIDES`, so the tail re-sync keeps them) and into the generated env section.

## Implementation checklist

- [x] Pin the uv installer URL in `Dockerfile.vm-agent-container` (0.13.8, current latest)
- [x] `scripts/deploy/container-image-inputs.ts`: Dockerfile analysis + key composition (pure)
- [x] `scripts/deploy/container-image-fingerprints.ts`: apt / URL / npm / PyPI fingerprints, injectable IO
- [x] `scripts/deploy/container-image-reuse.ts`: registry lookup, build/push, overrides, toml patch, summary
- [x] Tests: analysis (every supported/unsupported shape, both real Dockerfiles), fingerprints, decision
      logic incl. degraded inputs (fingerprint failure, registry lookup failure, push failure)
- [x] Add tests to `scripts/deploy/installer-engine.vitest.config.ts`
- [x] Workflow: install pinned uv, run resolve step, keep rollout snapshot/wait untouched
- [x] Workflow: build only linux vm-agent binaries
- [x] Docs: deploy docs / self-hosting mention of image reuse and how to force a rebuild
- [ ] Staging: two deploys without image change (second skips push and rollout), one with a change
- [ ] Instant (cf-container) session + VM session on staging
- [ ] Idea note with before/after durations

## Acceptance criteria

- Unchanged inputs: no build, no push, no new rollout; the rollout wait returns at once.
- Changed inputs: rebuild, push, rollout wait still runs and gates success.
- Any analysis/fingerprint/registry doubt leads to a rebuild, never reuse (tests prove it).
- Clean install and upgrade both work (no prior registry tag → build path).

## Open items

- `installer-engine-prebuilt.ts` `imageContextKey` ignores floating inputs (prebuilt images can be stale).
  Deferred to `tasks/backlog/2026-11-15-installer-prebuilt-image-key-floating-inputs.md`.
