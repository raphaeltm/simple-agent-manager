package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runStandaloneCredScript writes the helper script to a temp file and runs it
// with the given argv[1] and stdin, returning trimmed stdout.
func runStandaloneCredScript(t *testing.T, arg, stdin, ghToken string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "git-credential-sam")
	if err := os.WriteFile(path, []byte(standaloneGitCredentialHelperScript), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	cmd := exec.Command("/bin/sh", path, arg)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = append(os.Environ(), "GH_TOKEN="+ghToken)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run script: %v (out=%q)", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestStandaloneGitCredentialHelperServesTokenForGitHub(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "get", "protocol=https\nhost=github.com\n\n", "ghs_secret123")
	if !strings.Contains(out, "username=x-access-token") || !strings.Contains(out, "password=ghs_secret123") {
		t.Fatalf("expected github creds, got %q", out)
	}
}

func TestStandaloneGitCredentialHelperRejectsNonGitHubHost(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "get", "protocol=https\nhost=evil.example.com\n\n", "ghs_secret123")
	if out != "" {
		t.Fatalf("expected no creds for non-github host, got %q", out)
	}
}

func TestStandaloneGitCredentialHelperNoTokenNoOutput(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "get", "protocol=https\nhost=github.com\n\n", "")
	if out != "" {
		t.Fatalf("expected no output without GH_TOKEN, got %q", out)
	}
}

func TestStandaloneGitCredentialHelperIgnoresStoreAction(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "store", "protocol=https\nhost=github.com\n\n", "ghs_secret123")
	if out != "" {
		t.Fatalf("expected no output for store action, got %q", out)
	}
}

func TestStandaloneCloneSpecStripsEmbeddedCredentials(t *testing.T) {
	t.Parallel()

	spec, err := standaloneCloneSpecForURL(
		"https://x:art_token@acct.artifacts.cloudflare.net/git/default/repo.git",
		&gitTokenResponse{Token: "art_token"},
	)
	if err != nil {
		t.Fatalf("standaloneCloneSpecForURL returned error: %v", err)
	}
	if spec.URL != "https://acct.artifacts.cloudflare.net/git/default/repo.git" {
		t.Fatalf("clone URL = %q", spec.URL)
	}
	if strings.Contains(spec.URL, "art_token") {
		t.Fatalf("clone URL leaked token: %q", spec.URL)
	}
	if spec.Username != "x" {
		t.Fatalf("username = %q, want x", spec.Username)
	}
	if spec.Token != "art_token" {
		t.Fatalf("token = %q, want art_token", spec.Token)
	}
}
