package bootstrap

import (
	"net"
	"strconv"
	"strings"

	"github.com/workspace/vm-agent/internal/config"
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
	bound := canonicalHostedArtifactsAuthority(cfg.RepositoryHost)
	// WHATWG URL.host in the control plane omits HTTPS's default port, while
	// Go's URL.Host preserves it. Other ports still require an exact match.
	return bound != "" && strings.EqualFold(bound, canonicalHostedArtifactsAuthority(host))
}

func canonicalHostedArtifactsAuthority(authority string) string {
	authority = strings.TrimSpace(authority)
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		return authority
	}
	if port == "" {
		return strings.TrimSuffix(authority, ":")
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return ""
	}
	if number == 443 {
		return strings.TrimSuffix(authority, ":"+port)
	}
	return net.JoinHostPort(host, strconv.FormatUint(number, 10))
}
