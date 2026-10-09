#!/usr/bin/env bash
# Safe: copies CLI into a disposable directory; uses synthetic in-process HTTP fixtures.
set -euo pipefail
audit_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$audit_dir/../../.." && pwd)
audit_tmp=$(mktemp -d)
trap 'rm -rf -- "$audit_tmp"' EXIT
cp -R -- "$repo_root/packages/cli" "$audit_tmp/cli"
go_bin=${GO_BIN:-go}
cd -- "$audit_tmp/cli"
"$go_bin" version
"$go_bin" test -race -coverprofile="$audit_tmp/coverage.out" -covermode=atomic ./...
"$go_bin" tool cover -func="$audit_tmp/coverage.out" | tail -1
cp -- "$audit_dir/observations_test.go.txt" internal/cli/audit_observations_test.go
"$go_bin" test -race -run '^TestAudit' -v ./internal/cli
"$go_bin" vet ./...
