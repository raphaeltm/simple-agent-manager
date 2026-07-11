package server

import (
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
// SAME container as the vm-agent, and the per-session GH_TOKEN is injected into
// the agent process environment (see resolveAgentEnvVars). git spawns credential
// helpers with its own environment, so the helper simply serves that token for
// GitHub hosts. Scoped to GitHub so it never leaks the token to other hosts.
const standaloneGitCredentialHelperScript = `#!/bin/sh
[ "${1:-get}" = "get" ] || exit 0
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
  esac
done
case "$host" in
  github.com|api.github.com) ;;
  *) exit 0 ;;
esac
[ -n "${GH_TOKEN:-}" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$GH_TOKEN"
`

// ConfigureStandaloneGitCredentialHelper installs a git credential helper that
// serves the injected GH_TOKEN for GitHub hosts and registers it in the system
// git config. This lets the agent's `git` commands (clone, ls-remote, fetch,
// push) authenticate in standalone mode. Failures are non-fatal — the agent can
// still run without git access.
func ConfigureStandaloneGitCredentialHelper() {
	if err := os.WriteFile(standaloneGitCredentialHelperPath, []byte(standaloneGitCredentialHelperScript), 0o755); err != nil {
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

	slog.Info("standalone git: credential helper configured", "path", standaloneGitCredentialHelperPath)
}
