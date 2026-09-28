package server

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// standaloneGitCredentialHelperPath is where the standalone git credential
// helper script is installed inside the Cloudflare Container.
const standaloneGitCredentialHelperPath = "/usr/local/bin/git-credential-sam"
const standaloneGitBinaryPath = "/usr/bin/git"

// standaloneGitCredentialHelperScript is a git credential helper for standalone
// (cf-container) mode. Unlike the devcontainer helper, the agent runs in the
// SAME container as the vm-agent.
//
// GitHub and GitLab both exchange through the local vm-agent /git-credential
// endpoint so long-running sessions never reuse the boot-time GH_TOKEN after the
// underlying GitHub installation token expires. GitLab additionally requires a
// path-bound request before the endpoint will release a broad user OAuth token.
// The endpoint performs the workspace/provider/path authorization checks before
// returning credentials.
const standaloneGitCredentialHelperScriptTemplate = `#!/bin/sh
[ "${1:-get}" = "get" ] || exit 0
host=""
path=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
    path=*) path="${line#path=}" ;;
  esac
done
[ -n "$host" ] || exit 0
[ -n "${SAM_WORKSPACE_ID:-}" ] || exit 0
case "$host" in
  github.com|api.github.com)
    ;;
  *)
    [ -n "$path" ] || exit 0
    ;;
esac

url_encode_query_value() {
  printf '%s' "$1" | sed 's/%/%25/g; s/&/%26/g; s/=/%3D/g; s/?/%3F/g; s/#/%23/g; s/+/%2B/g; s/ /%20/g'
}

endpoint="${SAM_GIT_CREDENTIAL_ENDPOINT:-}"
if [ -z "$endpoint" ]; then
  port="${VM_AGENT_PORT:-8080}"
  endpoint="http://127.0.0.1:${port}/git-credential"
fi

workspace_id=$(url_encode_query_value "$SAM_WORKSPACE_ID")
encoded_host=$(url_encode_query_value "$host")
credential_query="workspaceId=${workspace_id}&host=${encoded_host}"
if [ -n "$path" ]; then
  encoded_path=$(url_encode_query_value "$path")
  credential_query="${credential_query}&path=${encoded_path}"
fi

curl -fsS --max-time {{ credential_timeout_seconds }} \
  "${endpoint}?${credential_query}" 2>/dev/null || true
`

func renderStandaloneGitCredentialHelperScript(timeout time.Duration) (string, error) {
	if timeout <= 0 {
		return "", fmt.Errorf("invalid git credential timeout: %s", timeout)
	}
	timeoutSeconds := strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64)
	return strings.ReplaceAll(
		standaloneGitCredentialHelperScriptTemplate,
		"{{ credential_timeout_seconds }}",
		timeoutSeconds,
	), nil
}

// ConfigureStandaloneGitCredentialHelper installs a git credential helper that
// delegates credentials to the local vm-agent exchange, plus a gh shim that
// refreshes GH_TOKEN through the same helper. This lets the agent's `git`
// commands (clone, ls-remote, fetch, push) and `gh` calls authenticate in
// standalone mode for the whole session, not just the first token lifetime.
// Failures are non-fatal — the agent can still run without git access.
func ConfigureStandaloneGitCredentialHelper(timeout time.Duration) {
	if err := writeStandaloneGitCredentialHelper(standaloneGitCredentialHelperPath, timeout); err != nil {
		slog.Warn("standalone git: failed to write credential helper; agent git auth unavailable", "error", err)
		return
	}

	// The shim calls the helper directly, so it does not depend on the git
	// config below succeeding.
	shimPath, err := installStandaloneGhShim(standaloneGhShimDir, standaloneGitCredentialHelperPath, os.Getenv("PATH"))
	switch {
	case err != nil:
		slog.Warn("standalone git: gh shim install failed; gh may use a stale GH_TOKEN", "error", err)
	case shimPath == "":
		slog.Info("standalone git: gh is not installed; skipping gh shim")
	default:
		slog.Info("standalone git: gh shim installed", "path", shimPath)
	}

	// Prefer system config so the helper applies regardless of HOME/user. Fall
	// back to global if the system gitconfig is not writable.
	if out, err := exec.Command(standaloneGitBinaryPath, "config", "--system", "credential.helper", standaloneGitCredentialHelperPath).CombinedOutput(); err != nil {
		slog.Warn("standalone git: system credential.helper config failed, trying global",
			"error", err, "output", strings.TrimSpace(string(out)))
		if out2, err2 := exec.Command(standaloneGitBinaryPath, "config", "--global", "credential.helper", standaloneGitCredentialHelperPath).CombinedOutput(); err2 != nil {
			slog.Warn("standalone git: global credential.helper config failed; agent git auth unavailable",
				"error", err2, "output", strings.TrimSpace(string(out2)))
			return
		}
	}
	if out, err := exec.Command(standaloneGitBinaryPath, "config", "--system", "credential.useHttpPath", "true").CombinedOutput(); err != nil {
		slog.Warn("standalone git: system credential.useHttpPath config failed, trying global",
			"error", err, "output", strings.TrimSpace(string(out)))
		if out2, err2 := exec.Command(standaloneGitBinaryPath, "config", "--global", "credential.useHttpPath", "true").CombinedOutput(); err2 != nil {
			slog.Warn("standalone git: global credential.useHttpPath config failed; GitLab git auth may be unavailable",
				"error", err2, "output", strings.TrimSpace(string(out2)))
		}
	}

	slog.Info("standalone git: credential helper configured", "path", standaloneGitCredentialHelperPath)
}

func writeStandaloneGitCredentialHelper(path string, timeout time.Duration) error {
	script, err := renderStandaloneGitCredentialHelperScript(timeout)
	if err != nil {
		return fmt.Errorf("render helper: %w", err)
	}
	if err := writeOwnerOnlyExecutable(path, script); err != nil {
		return fmt.Errorf("write helper: %w", err)
	}
	return nil
}

// writeOwnerOnlyExecutable writes an executable script readable only by its
// owner. os.WriteFile only applies the mode when creating the file, and a
// restored Cloudflare Container snapshot can already contain the file with
// broader permissions, so the mode is re-applied explicitly. The vm-agent and
// the agent run as the same node user, so owner-only access is sufficient and
// avoids exposing the credential exchange.
func writeOwnerOnlyExecutable(path, script string) error {
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}
