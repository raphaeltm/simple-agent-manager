# Make the VM-agent build reproducible across runner images

## Problem

On 2026-11-14 at about 23:00Z GitHub moved `ubuntu-latest` from ubuntu-24.04 to ubuntu-26.04.
The VM-agent release key is content-derived (the last commit that touched `packages/vm-agent`, here
`ba3ba01ff`), so consecutive deploys must rebuild the agent byte-identically. The native linux/amd64
build in `packages/vm-agent/Makefile` does not set `CGO_ENABLED`, so it is cgo-enabled on an amd64
runner, and its bytes follow the runner's gcc/glibc. Unchanged source built on 26.04 differed from
the 24.04 artifact, and `scripts/deploy/publish-vm-agent-artifacts.sh` refused the upload. That
failed every staging and production deploy (staging run 43655924997, two attempts, existing
sha256 c0cb8210..., built sha256 6eda4320...).

The immediate unblock pins the deploy job to `ubuntu-24.04` (`sam/pin-deploy-runner-ubuntu-2404`).
That keeps builds identical but couples the release identity to an unstated runner choice, and the
cgo-linked amd64 agent also depends on the runner's glibc version for where it can run.

## Context

- `packages/vm-agent/Makefile` (`GOFLAGS`, `build-all`): arm64 is cross-compiled and already
  cgo-off by default; amd64 is native and cgo-on.
- `scripts/deploy/resolve-vm-agent-release.sh`: the release identity.
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`: the content-identity design.

## Acceptance Criteria

- [ ] The amd64 and arm64 agents build with `CGO_ENABLED=0` (or the reason cgo is needed is
      documented and the toolchain is pinned explicitly).
- [ ] Building the same source on ubuntu-24.04 and ubuntu-26.04 yields identical bytes (CI check).
- [ ] The build environment that affects the bytes (Go version, cgo mode) is part of the release
      identity, so a toolchain change yields a new key instead of a refused upload.
- [ ] Real VM provisioning on staging confirms the cgo-off agent works (DNS resolution, user lookup,
      PTY, ACP), and the deploy job pin can be removed.
