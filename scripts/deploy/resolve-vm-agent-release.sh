#!/usr/bin/env bash

# Resolve the immutable VM-agent release identity for a deployment.
#
# The release is the last commit that CHANGED packages/vm-agent, not the
# deployment commit. Keying it on the deployment commit rotated
# VM_AGENT_REQUIRED_VERSION on every deploy, and `isNodeAgentVersionCompatible`
# compares for exact equality, so every already-running node became ineligible
# for reuse several times a day. 22 of the 25 commits to main preceding this
# change did not touch packages/vm-agent at all, and production was provisioning
# a fresh VM per agent as a result.
#
# BUILD_DATE is emitted from the SAME commit on purpose. It is baked into the
# binary through ldflags, so a release whose bytes must be reproducible cannot
# take its date from a commit that the release identity ignores — otherwise two
# deploys of identical agent source produce different bytes under one immutable
# release key and publish-vm-agent-artifacts.sh fails closed.
#
# Emits GITHUB_OUTPUT-shaped lines on stdout:
#   release=<40-hex commit sha>
#   build_date=<ISO-8601 committer date of that commit>

set -euo pipefail

DEPLOY_SHA="${1:?deploy sha is required}"
AGENT_SOURCE_PATH="${VM_AGENT_SOURCE_PATH:-packages/vm-agent}"

# A shallow clone answers `rev-list -1 -- <path>` with the shallow boundary
# rather than the real last-touching commit, which would silently reproduce the
# per-deploy rotation this script exists to remove. Fail closed instead.
if [ "$(git rev-parse --is-shallow-repository)" != "false" ]; then
  echo "::error::resolve-vm-agent-release: repository is shallow; the deploy checkout needs fetch-depth: 0 to resolve the VM-agent release" >&2
  exit 1
fi

release="$(git rev-list -1 "$DEPLOY_SHA" -- "$AGENT_SOURCE_PATH")"
if [ -z "$release" ]; then
  echo "::error::resolve-vm-agent-release: no commit touching $AGENT_SOURCE_PATH is reachable from $DEPLOY_SHA" >&2
  exit 1
fi
if ! printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "::error::resolve-vm-agent-release: resolved release is not a full lowercase commit SHA" >&2
  exit 1
fi

build_date="$(git show -s --format=%cI "$release")"
if [ -z "$build_date" ]; then
  echo "::error::resolve-vm-agent-release: could not read the committer date of $release" >&2
  exit 1
fi

printf 'release=%s\n' "$release"
printf 'build_date=%s\n' "$build_date"
