package server

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
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
protocol=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
    path=*) path="${line#path=}" ;;
    protocol=*) protocol="${line#protocol=}" ;;
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
encoded_protocol=$(url_encode_query_value "$protocol")
credential_query="workspaceId=${workspace_id}&host=${encoded_host}&protocol=${encoded_protocol}"
if [ -n "$path" ]; then
  encoded_path=$(url_encode_query_value "$path")
  credential_query="${credential_query}&path=${encoded_path}"
fi

exchange_token={{ git_credential_exchange_token }}
curl -fsS --max-time {{ credential_timeout_seconds }} \
  -H "Authorization: Bearer ${exchange_token}" \
  "${endpoint}?${credential_query}" 2>/dev/null || true
`

func renderStandaloneGitCredentialHelperScript(timeout time.Duration, exchangeToken string) (string, error) {
	if timeout <= 0 {
		return "", fmt.Errorf("invalid git credential timeout: %s", timeout)
	}
	exchangeToken = strings.TrimSpace(exchangeToken)
	if exchangeToken == "" {
		return "", fmt.Errorf("git credential exchange token is required")
	}
	timeoutSeconds := strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64)
	script := strings.ReplaceAll(
		standaloneGitCredentialHelperScriptTemplate,
		"{{ credential_timeout_seconds }}",
		timeoutSeconds,
	)
	return strings.ReplaceAll(script, "{{ git_credential_exchange_token }}", shellSingleQuote(exchangeToken)), nil
}

// ConfigureStandaloneGitCredentialHelper installs a git credential helper that
// delegates credentials to the local vm-agent exchange, plus a gh shim that
// refreshes GH_TOKEN through the same helper. This lets the agent's `git`
// commands (clone, ls-remote, fetch, push) and `gh` calls authenticate in
// standalone mode for the whole session, not just the first token lifetime.
// Failures are non-fatal — the agent can still run without git access.
//
// The helper's exchange bearer is keyed to the container's single workspace
// (cfg.WorkspaceID); the standalone server serves no other workspace
// (newPTYManagerForWorkspace and isKnownWorkspaceGitCredentialRequest refuse
// other IDs). An in-container agent restart reuses the existing helper's bearer
// while it validates, so a git command in flight keeps authenticating.
func ConfigureStandaloneGitCredentialHelper(workspaceID string, timeout time.Duration) {
	if err := installStandaloneGitCredentialExchange(standaloneGitCredentialHelperPath, workspaceID, timeout); err != nil {
		// Fail closed and visibly: without an installed bearer the local
		// exchange refuses every request, so git auth is unavailable.
		slog.Error("standalone git: credential exchange not installed; agent git auth unavailable",
			"workspaceID", workspaceID, "error", err, "action", "git_auth_disabled")
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

// installStandaloneGitCredentialExchange writes the helper at path with the
// workspace's exchange bearer, reusing the bearer of an existing helper while it
// still validates, and installs the bearer's digest for a new one.
func installStandaloneGitCredentialExchange(path, workspaceID string, timeout time.Duration) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required for the git credential exchange")
	}
	exchangeToken, reused, err := bootstrap.ResolveGitCredentialExchangeToken(workspaceID, path)
	if err != nil {
		return fmt.Errorf("prepare credential exchange: %w", err)
	}
	if err := writeStandaloneGitCredentialHelper(path, timeout, exchangeToken); err != nil {
		return fmt.Errorf("write credential helper: %w", err)
	}
	if reused {
		return nil
	}
	if err := bootstrap.InstallGitCredentialExchange(workspaceID, exchangeToken); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("install credential exchange: %w", err)
	}
	return nil
}

func writeStandaloneGitCredentialHelper(path string, timeout time.Duration, exchangeToken string) error {
	script, err := renderStandaloneGitCredentialHelperScript(timeout, exchangeToken)
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
//
// A git or gh process may be executing the file while it is rewritten (an
// in-container agent restart), so an unchanged script is left alone and a
// changed one is replaced by rename. If the directory does not let this user
// create a sibling temp file, the file is rewritten in place as before.
func writeOwnerOnlyExecutable(path, script string) error {
	if current, err := os.ReadFile(path); err == nil && string(current) == script {
		return os.Chmod(path, 0o700)
	}
	if err := replaceOwnerOnlyExecutable(path, script); err == nil {
		return nil
	}
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func replaceOwnerOnlyExecutable(path, script string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.WriteString(script); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o700); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
