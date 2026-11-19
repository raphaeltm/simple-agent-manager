package bootstrap

import (
	"strings"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/gitrepo"
)

// isBoundHostedArtifactsHost reports whether host is the repository host the
// control plane bound to an artifacts-provider workspace. Cloudflare Artifacts
// hosts are recognized by name (gitrepo.IsArtifactsHost) and are never bound;
// a self-hosted SAM install serves its own repositories at api.<domain>, which
// the control plane passes as RepositoryHost (resolveWorkspaceGitSource in
// apps/api/src/services/workspace-git-source.ts). Only that exact host receives
// the workspace's git token.
func isBoundHostedArtifactsHost(cfg *config.Config, host string) bool {
	if cfg == nil || !strings.EqualFold(strings.TrimSpace(cfg.RepoProvider), "artifacts") {
		return false
	}
	// WHATWG URL.host in the control plane omits HTTPS's default port, while
	// Go's URL.Host preserves it. Other ports still require an exact match.
	return gitrepo.HTTPSAuthoritiesEqual(cfg.RepositoryHost, host)
}
