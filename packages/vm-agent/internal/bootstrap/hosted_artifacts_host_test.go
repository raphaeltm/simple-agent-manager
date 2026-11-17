package bootstrap

import (
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

// A self-hosted SAM install serves artifacts-provider repositories from its own git
// server at api.<domain>; the control plane binds that host as RepositoryHost.
func TestWithGitTokenSelfHostedArtifactsHost(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{RepoProvider: "artifacts", RepositoryHost: "api.sam.example"}
	got, err := withGitToken("https://api.sam.example/git/demo-01abc.git", "samgit1.tok", cfg)
	if err != nil {
		t.Fatalf("withGitToken: %v", err)
	}
	if got != "https://x:samgit1.tok@api.sam.example/git/demo-01abc.git" {
		t.Fatalf("unexpected tokenized url: %s", got)
	}

	// Control: a different host is never given the token.
	other, err := withGitToken("https://evil.example/git/demo.git", "samgit1.tok", cfg)
	if err != nil {
		t.Fatalf("withGitToken other host: %v", err)
	}
	if other != "https://evil.example/git/demo.git" {
		t.Fatalf("token leaked to unbound host: %s", other)
	}

	// Control: the same host bound to a non-artifacts provider is not treated as hosted.
	github := &config.Config{RepoProvider: "github", RepositoryHost: "api.sam.example"}
	plain, err := withGitToken("https://api.sam.example/git/demo.git", "samgit1.tok", github)
	if err != nil {
		t.Fatalf("withGitToken github provider: %v", err)
	}
	if plain != "https://api.sam.example/git/demo.git" {
		t.Fatalf("token attached for non-artifacts provider: %s", plain)
	}
}

func TestNeedsCredentialHelperSelfHostedArtifacts(t *testing.T) {
	t.Parallel()

	hosted := &config.Config{
		RepoProvider:   "artifacts",
		RepositoryHost: "api.sam.example",
		CloneURL:       "https://api.sam.example/git/demo-01abc.git",
	}
	if !needsCredentialHelperForConfig(hosted) {
		t.Fatal("expected credential helper for a bound self-hosted artifacts host")
	}
	unbound := &config.Config{RepoProvider: "artifacts", CloneURL: "https://api.sam.example/git/demo.git"}
	if needsCredentialHelperForConfig(unbound) {
		t.Fatal("unbound artifacts host must not enable the credential helper")
	}
}

// Cloudflare Artifacts is unchanged: recognized by name, no bound host needed,
// and a bound self-hosted host does not widen to other hosts.
func TestWithGitTokenCloudflareArtifactsUnchanged(t *testing.T) {
	t.Parallel()

	cf := "https://acct.artifacts.cloudflare.net/git/repo.git"
	for _, cfg := range []*config.Config{
		nil,
		{RepoProvider: "artifacts"},
		{RepoProvider: "artifacts", RepositoryHost: "api.sam.example"},
	} {
		got, err := withGitToken(cf, "cf.tok", cfg)
		if err != nil {
			t.Fatalf("withGitToken: %v", err)
		}
		if got != "https://x:cf.tok@acct.artifacts.cloudflare.net/git/repo.git" {
			t.Fatalf("cloudflare artifacts url changed (cfg=%+v): %s", cfg, got)
		}
	}
	if !needsCredentialHelperForConfig(&config.Config{RepoProvider: "artifacts", Repository: cf}) {
		t.Fatal("cloudflare artifacts must keep the credential helper")
	}
}

// The bound host matches exactly: a different port or a look-alike subdomain is
// a different host and never receives the token.
func TestWithGitTokenBoundHostIsExact(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{RepoProvider: "artifacts", RepositoryHost: "api.sam.example"}
	for _, u := range []string{
		"https://api.sam.example:8443/git/demo.git",
		"https://api.sam.example.evil.test/git/demo.git",
		"https://evil.api.sam.example/git/demo.git",
		"http://api.sam.example/git/demo.git",
	} {
		got, err := withGitToken(u, "samgit1.tok", cfg)
		if err != nil {
			t.Fatalf("withGitToken(%s): %v", u, err)
		}
		if got != u {
			t.Fatalf("token attached to unbound url %s: %s", u, got)
		}
	}
}
