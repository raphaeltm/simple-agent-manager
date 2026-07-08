package gitrepo

import (
	"net/url"
	"strings"
)

// NormalizeURL converts owner/repo shorthands into a GitHub HTTPS URL while
// preserving fully qualified HTTP(S) repository URLs.
func NormalizeURL(repo string) string {
	repo = strings.TrimSpace(repo)
	if strings.HasPrefix(repo, "http://") || strings.HasPrefix(repo, "https://") {
		if !strings.HasSuffix(repo, ".git") {
			return repo + ".git"
		}
		return repo
	}

	repo = strings.TrimPrefix(repo, "github.com/")
	repo = strings.TrimPrefix(repo, "https://github.com/")
	repo = strings.TrimPrefix(repo, "http://github.com/")
	repo = strings.TrimSuffix(repo, ".git")
	return "https://github.com/" + repo + ".git"
}

func IsGitHubRepo(repo string) bool {
	if strings.TrimSpace(repo) == "" {
		return false
	}
	normalized := NormalizeURL(repo)
	u, err := url.Parse(normalized)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, "github.com")
}

func IsGitHubCredentialHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "github.com" || host == "api.github.com"
}

// IsArtifactsHost returns true if host is a Cloudflare Artifacts git host.
func IsArtifactsHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "artifacts.cloudflare.net" ||
		strings.HasSuffix(host, ".artifacts.cloudflare.net")
}

func HostMatches(expected, requested string) bool {
	expected = strings.ToLower(strings.TrimSpace(expected))
	requested = strings.ToLower(strings.TrimSpace(requested))
	return expected != "" && requested != "" && expected == requested
}

// IsKnownGitHost returns true if host is one SAM vends tokens for.
func IsKnownGitHost(host string) bool {
	return IsGitHubCredentialHost(host) || IsArtifactsHost(host)
}
