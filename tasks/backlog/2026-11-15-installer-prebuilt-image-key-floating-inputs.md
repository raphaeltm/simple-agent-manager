# Installer prebuilt images are keyed without their floating inputs

## Problem

`imageContextKey()` in `scripts/deploy/installer-engine-prebuilt.ts` keys a published prebuilt
container image by the Dockerfile and the files it copies only. Both Instant images also install
unpinned apt packages, transitive npm and PyPI dependencies and fetched URLs. An installation whose
Dockerfile matches an older published image therefore imports that image with frozen (possibly
stale) upstream packages.

## Context

Found while building deploy image reuse (task `2026-11-15-deploy-container-image-reuse.md`), which
keys images with `analyzeDockerfile()` + `fingerprintInputs()` + `composeImageKey()`
(`scripts/deploy/container-image-*.ts`). The installer prebuilt path is opt-in (`use_shared_engine`).

## Acceptance criteria

- [ ] Decide whether prebuilt images should carry the full floating-input key (publisher and
      installer fingerprint at different times, so keys rarely match) or a bounded-age policy
- [ ] The chosen key cannot accept an image whose upstream inputs changed since publication
      without that being an explicit, documented choice
- [ ] Tests for the stale-upstream case
