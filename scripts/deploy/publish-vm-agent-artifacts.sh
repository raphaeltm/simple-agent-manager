#!/usr/bin/env bash

set -euo pipefail

: "${R2_BUCKET:?R2_BUCKET is required}"
: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

publish_agent_artifact() {
  local architecture="$1"
  local source_path="$GITHUB_WORKSPACE/packages/vm-agent/bin/vm-agent-linux-$architecture"
  local object_path="$R2_BUCKET/agents/releases/$DEPLOY_SHA/vm-agent-linux-$architecture"
  local existing_path="$RUNNER_TEMP/vm-agent-linux-$architecture.existing"
  local get_output
  local source_sha
  local existing_sha

  # Wrangler v4: R2 commands default to local; --remote is required.
  if get_output=$(pnpm --filter @simple-agent-manager/api exec wrangler r2 object get "$object_path" --file "$existing_path" --remote 2>&1); then
    source_sha=$(sha256sum "$source_path" | cut -d' ' -f1)
    existing_sha=$(sha256sum "$existing_path" | cut -d' ' -f1)
    rm -f "$existing_path"
    if [ "$source_sha" != "$existing_sha" ]; then
      echo "::error::Refusing to overwrite immutable VM-agent artifact $object_path (existing sha256=$existing_sha, built sha256=$source_sha)"
      return 1
    fi
    echo "Reusing identical immutable VM-agent artifact $object_path"
    return 0
  fi

  rm -f "$existing_path"
  if ! echo "$get_output" | grep -q "The specified key does not exist."; then
    echo "$get_output"
    echo "::error::Could not verify whether immutable VM-agent artifact exists: $object_path"
    return 1
  fi

  pnpm --filter @simple-agent-manager/api exec wrangler r2 object put "$object_path" --file "$source_path" --remote
}

publish_agent_artifact amd64
publish_agent_artifact arm64
