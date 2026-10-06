package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// standaloneGhShimDir is where the gh shim is installed. The instant-runtime
// image (apps/api/Dockerfile.vm-agent-container) puts this directory first on
// PATH and gives it to the `node` user that runs both the vm-agent and the
// agents, so the shim shadows the system gh for agent shells and terminals
// without writing to root-owned directories or rewriting any process PATH.
const standaloneGhShimDir = "/var/lib/vm-agent/agents/bin"

// standaloneGhShimScriptTemplate refreshes GH_TOKEN before every gh call.
//
// GitHub App installation tokens expire after one hour, so the GH_TOKEN
// injected at session start goes stale in long sessions. The shim asks the SAM
// credential helper directly rather than `git credential fill`: git config the
// agent controls (for example `gh auth setup-git`, which resets the helper
// list) cannot route the refresh back to the stale token, and git can never
// stop to prompt on a terminal.
//
// When the exchange yields no token, the inherited GH_TOKEN is dropped rather
// than trusted: gh fails visibly instead of silently using a credential SAM can
// no longer vouch for, such as one minted before the installation or the
// project's GitHub CLI policy was revoked.
const standaloneGhShimScriptTemplate = `#!/bin/sh
sam_gh_token=$(printf 'protocol=https\nhost=github.com\n\n' | {{ credential_helper }} get 2>/dev/null | sed -n 's/^password=//p' | head -n 1)
if [ -n "$sam_gh_token" ]; then
  GH_TOKEN=$sam_gh_token
  export GH_TOKEN
elif [ -n "${GH_TOKEN:-}" ]; then
  echo 'gh: SAM could not refresh GitHub credentials; not using the GH_TOKEN inherited at session start' >&2
  unset GH_TOKEN
fi
unset sam_gh_token
exec {{ real_gh }} "$@"
`

func renderStandaloneGhShimScript(credentialHelperPath, realGhPath string) string {
	return strings.NewReplacer(
		"{{ credential_helper }}", shellSingleQuote(credentialHelperPath),
		"{{ real_gh }}", shellSingleQuote(realGhPath),
	).Replace(standaloneGhShimScriptTemplate)
}

// installStandaloneGhShim writes the gh shim into shimDir, wrapping the gh the
// shim shadows on pathEnv. It returns the shim path, or "" when gh is not
// installed.
func installStandaloneGhShim(shimDir, credentialHelperPath, pathEnv string) (string, error) {
	realGhPath, ok := findShadowedGh(shimDir, pathEnv)
	if !ok {
		return "", nil
	}
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		return "", fmt.Errorf("create gh shim dir: %w", err)
	}
	shimPath := filepath.Join(shimDir, "gh")
	if err := writeOwnerOnlyExecutable(shimPath, renderStandaloneGhShimScript(credentialHelperPath, realGhPath)); err != nil {
		return "", fmt.Errorf("write gh shim: %w", err)
	}
	return shimPath, nil
}

// findShadowedGh returns the gh a PATH lookup would reach without the shim: the
// first executable gh on pathEnv outside shimDir. Relative entries are skipped
// so a repository-controlled ./gh can never be adopted, and candidates that
// resolve into shimDir are skipped so a reinstall can never make the shim exec
// itself.
func findShadowedGh(shimDir, pathEnv string) (string, bool) {
	shimDir = resolveDir(shimDir)
	for _, dir := range filepath.SplitList(pathEnv) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, "gh")
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil || filepath.Dir(resolved) == shimDir {
			continue
		}
		if info, err := os.Stat(resolved); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, true
		}
	}
	return "", false
}

func resolveDir(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return filepath.Clean(dir)
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
