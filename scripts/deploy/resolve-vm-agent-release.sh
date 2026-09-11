#!/usr/bin/env bash

# Resolve the immutable VM-agent release identity for a deployment.
#
# The release is the last commit that changed the VM-agent's BUILD INPUTS, not
# the deployment commit. Keying it on the deployment commit rotated
# VM_AGENT_REQUIRED_VERSION on every deploy, and `isNodeAgentVersionCompatible`
# compares it for exact equality, so every already-running node became ineligible
# for reuse several times a day — and `sweepIncompatibleVmAgentNodes` then
# destroyed the idle ones. 22 of the 25 commits to main preceding this change did
# not touch packages/vm-agent at all.
#
# BUILD_DATE is emitted from the SAME commit on purpose. It is baked into the
# binary through ldflags, so a release whose bytes must be reproducible cannot
# take its date from a commit the release identity ignores — otherwise two
# deploys of identical agent source produce different bytes under one immutable
# release key and publish-vm-agent-artifacts.sh fails closed.
#
# Emits GITHUB_OUTPUT-shaped lines on stdout:
#   release=<40-hex commit sha>
#   build_date=<ISO-8601 committer date of that commit>

set -euo pipefail

DEPLOY_SHA="${1:?deploy sha is required}"
AGENT_SOURCE_PATH="${VM_AGENT_SOURCE_PATH:-packages/vm-agent}"

# Paths under the agent that CANNOT change the compiled binary. Excluding them is
# the difference between "the agent changed" and "something inside its directory
# changed": `packages/vm-agent/.claude/rules/` holds this repo's own agent rules,
# and `.claude/rules/02` MANDATES a rule update on every bug fix — so without this
# exclusion a vm-agent bug fix rotates the release twice, and a docs-only commit
# rotates it for nothing. That is not hypothetical: commit df8e03ee7 touched only
# `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md` and would
# have evicted the entire node pool.
#
# This list EXCLUDES rather than includes on purpose. An unrecognised new file
# type then rotates the release — wasteful but safe — whereas an include-list
# would silently serve a stale binary under a current version.
#
# `_test.go` files are never linked into a non-test build; that is a Go language
# guarantee, not a convention. The exclusions assume none of these paths is
# `//go:embed`-ed into the binary, which a contract test enforces.
AGENT_SOURCE_EXCLUDES=(
  ":(exclude)$AGENT_SOURCE_PATH/.claude"
  ":(exclude)$AGENT_SOURCE_PATH/AGENTS.md"
  ":(exclude)$AGENT_SOURCE_PATH/**/*_test.go"
  ":(exclude)$AGENT_SOURCE_PATH/*_test.go"
)

# A shallow clone answers `rev-list -1 -- <path>` with the shallow boundary
# rather than the real last-touching commit, which would silently reproduce the
# per-deploy rotation this script exists to remove. Fail closed instead.
if [ "$(git rev-parse --is-shallow-repository)" != "false" ]; then
  echo "::error::resolve-vm-agent-release: repository is shallow; the deploy checkout needs fetch-depth: 0 to resolve the VM-agent release" >&2
  exit 1
fi

release="$(git rev-list -1 "$DEPLOY_SHA" -- "$AGENT_SOURCE_PATH" "${AGENT_SOURCE_EXCLUDES[@]}")"
if [ -z "$release" ]; then
  echo "::error::resolve-vm-agent-release: no commit changing $AGENT_SOURCE_PATH build inputs is reachable from $DEPLOY_SHA" >&2
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
