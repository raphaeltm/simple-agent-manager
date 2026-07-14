package server

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
)

// standaloneGitCredentialHelperPath is where the standalone git credential
// helper script is installed inside the Cloudflare Container.
const standaloneGitCredentialHelperPath = "/usr/local/bin/git-credential-sam"
const standaloneGitBinaryPath = "/usr/bin/git"

// standaloneGitCredentialHelperScript is a git credential helper for standalone
// (cf-container) mode. Unlike the devcontainer helper, the agent runs in the
// SAME container as the vm-agent.
//
// GitHub keeps the fast path: the per-session GH_TOKEN is injected into the
// agent process environment (see resolveAgentEnvVars), and git credential
// helpers inherit that environment.
//
// GitLab cannot use GH_TOKEN. It needs a fresh, path-bound token exchange through
// the local vm-agent /git-credential endpoint. The endpoint performs the
// workspace/provider/path authorization checks before returning credentials.
const standaloneGitCredentialHelperScript = `#!/bin/sh
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
case "$host" in
  github.com|api.github.com)
    [ -n "${GH_TOKEN:-}" ] || exit 0
    printf 'username=x-access-token\npassword=%s\n' "$GH_TOKEN"
    exit 0
    ;;
esac

[ -n "$host" ] || exit 0
[ -n "$path" ] || exit 0
[ -n "${SAM_WORKSPACE_ID:-}" ] || exit 0

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
encoded_path=$(url_encode_query_value "$path")

curl -fsS --max-time 5 \
  "${endpoint}?workspaceId=${workspace_id}&host=${encoded_host}&path=${encoded_path}" 2>/dev/null || true
`

// ConfigureStandaloneGitCredentialHelper installs a git credential helper that
// serves GitHub credentials from GH_TOKEN and delegates GitLab/non-GitHub
// credentials to the local vm-agent exchange. This lets the agent's `git`
// commands (clone, ls-remote, fetch, push) authenticate in standalone mode.
// Failures are non-fatal — the agent can still run without git access.
func ConfigureStandaloneGitCredentialHelper() {
	if err := writeStandaloneGitCredentialHelper(standaloneGitCredentialHelperPath); err != nil {
		slog.Warn("standalone git: failed to write credential helper; agent git auth unavailable", "error", err)
		return
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

func writeStandaloneGitCredentialHelper(path string) error {
	if err := os.WriteFile(path, []byte(standaloneGitCredentialHelperScript), 0o700); err != nil {
		return fmt.Errorf("write helper: %w", err)
	}
	// os.WriteFile only applies the mode when creating the file. A restored
	// Cloudflare Container snapshot can already contain this helper with broader
	// permissions. The vm-agent and agent run as the same node user, so owner-only
	// access is sufficient and avoids exposing the credential exchange helper.
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("chmod helper: %w", err)
	}
	return nil
}
