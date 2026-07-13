package server

import (
	"net/http"
	"net/http/httptest"
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
	return runStandaloneCredScriptWithEnv(t, arg, stdin, map[string]string{"GH_TOKEN": ghToken})
}

func runStandaloneCredScriptWithEnv(t *testing.T, arg, stdin string, env map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "git-credential-sam")
	if err := os.WriteFile(path, []byte(standaloneGitCredentialHelperScript), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	cmd := exec.Command("/bin/sh", path, arg)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = os.Environ()
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
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

func TestWriteStandaloneGitCredentialHelperRestoresExecutableMode(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "git-credential-sam")
	if err := os.WriteFile(path, []byte("old helper"), 0o644); err != nil {
		t.Fatalf("seed helper: %v", err)
	}

	if err := writeStandaloneGitCredentialHelper(path); err != nil {
		t.Fatalf("write helper: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat helper: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("helper mode = %o, want 755", got)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read helper: %v", err)
	}
	if !strings.Contains(string(data), "SAM_WORKSPACE_ID") {
		t.Fatalf("helper script was not written: %q", string(data))
	}
}

func TestStandaloneGitCredentialHelperRejectsNonGitHubHost(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "get", "protocol=https\nhost=evil.example.com\n\n", "ghs_secret123")
	if out != "" {
		t.Fatalf("expected no creds for non-github host, got %q", out)
	}
}

func TestStandaloneGitCredentialHelperDelegatesGitLabToLocalExchange(t *testing.T) {
	t.Parallel()

	var gotWorkspaceID string
	var gotHost string
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/git-credential" {
			t.Fatalf("request path = %q, want /git-credential", r.URL.Path)
		}
		gotWorkspaceID = r.URL.Query().Get("workspaceId")
		gotHost = r.URL.Query().Get("host")
		gotPath = r.URL.Query().Get("path")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("username=oauth2\npassword=gl_token\n"))
	}))
	t.Cleanup(server.Close)

	out := runStandaloneCredScriptWithEnv(t, "get", "protocol=https\nhost=gitlab.com\npath=group/project.git\n\n", map[string]string{
		"SAM_WORKSPACE_ID":            "ws-gitlab",
		"SAM_GIT_CREDENTIAL_ENDPOINT": server.URL + "/git-credential",
		"GH_TOKEN":                    "ghs_should_not_be_used",
	})

	if !strings.Contains(out, "username=oauth2") || !strings.Contains(out, "password=gl_token") {
		t.Fatalf("expected delegated gitlab creds, got %q", out)
	}
	if gotWorkspaceID != "ws-gitlab" {
		t.Fatalf("workspaceId query = %q, want ws-gitlab", gotWorkspaceID)
	}
	if gotHost != "gitlab.com" {
		t.Fatalf("host query = %q, want gitlab.com", gotHost)
	}
	if gotPath != "group/project.git" {
		t.Fatalf("path query = %q, want group/project.git", gotPath)
	}
}

func TestStandaloneGitCredentialHelperRequiresPathForGitLab(t *testing.T) {
	t.Parallel()
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	t.Cleanup(server.Close)

	out := runStandaloneCredScriptWithEnv(t, "get", "protocol=https\nhost=gitlab.com\n\n", map[string]string{
		"SAM_WORKSPACE_ID":            "ws-gitlab",
		"SAM_GIT_CREDENTIAL_ENDPOINT": server.URL + "/git-credential",
	})
	if out != "" {
		t.Fatalf("expected no creds without path, got %q", out)
	}
	if called {
		t.Fatal("credential endpoint should not be called without a path")
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
