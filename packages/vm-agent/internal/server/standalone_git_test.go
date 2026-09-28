package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runStandaloneCredScript writes the helper script to a temp file and runs it
// with the given argv[1] and stdin, returning trimmed stdout.
func runStandaloneCredScript(t *testing.T, arg, stdin, ghToken string) string {
	t.Helper()
	return runStandaloneCredScriptWithEnv(t, arg, stdin, map[string]string{"GH_TOKEN": ghToken})
}

func runStandaloneCredScriptWithEnv(t *testing.T, arg, stdin string, env map[string]string) string {
	t.Helper()
	script, err := renderStandaloneGitCredentialHelperScript(5 * time.Second)
	if err != nil {
		t.Fatalf("render script: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "git-credential-sam")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	cmd := exec.Command("/bin/sh", path, arg)
	cmd.Stdin = strings.NewReader(stdin)
	overrides := make([]string, 0, len(env))
	for key, value := range env {
		overrides = append(overrides, key+"="+value)
	}
	cmd.Env = hermeticEnv(overrides...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run script: %v (out=%q)", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestRenderStandaloneGitCredentialHelperScriptUsesConfiguredTimeout(t *testing.T) {
	t.Parallel()

	script, err := renderStandaloneGitCredentialHelperScript(1750 * time.Millisecond)
	if err != nil {
		t.Fatalf("render script: %v", err)
	}
	if !strings.Contains(script, "--max-time 1.75") {
		t.Fatalf("configured timeout missing from helper script: %q", script)
	}
}

// TestStandaloneGitCredentialFillExchangesInsteadOfServingSessionGHToken drives
// the credential lookup `git fetch` performs — git itself, configured the way
// ConfigureStandaloneGitCredentialHelper configures it — through the rendered
// helper and the real /git-credential handler. The session's GH_TOKEN is stale
// by construction: a GitHub App installation token expires an hour after the
// session starts, so git must get the freshly minted token instead.
func TestStandaloneGitCredentialFillExchangesInsteadOfServingSessionGHToken(t *testing.T) {
	t.Parallel()
	exchange := newStandaloneCredentialExchange(t, "ws-instant", http.StatusOK, "fresh-exchange-token")

	cmd := exec.Command("git",
		"-c", "credential.helper="+exchange.helperPath,
		"-c", "credential.useHttpPath=true",
		"credential", "fill")
	cmd.Stdin = strings.NewReader("url=https://github.com/octo/repo.git\n\n")
	cmd.Env = append(exchange.agentEnv("stale-session-token"),
		"HOME="+t.TempDir(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
	)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git credential fill: %v (out=%q)", err, out)
	}

	if !strings.Contains(string(out), "username=x-access-token\npassword=fresh-exchange-token\n") {
		t.Fatalf("git credential fill = %q, want the freshly exchanged token", out)
	}
	if strings.Contains(string(out), "stale-session-token") {
		t.Fatalf("git was served the stale session GH_TOKEN: %q", out)
	}
	if got := exchange.mintCalls.Load(); got != 1 {
		t.Fatalf("control plane token mints = %d, want 1", got)
	}
	query := exchange.lastRequestQuery()
	if query.Get("workspaceId") != "ws-instant" || query.Get("host") != "github.com" || query.Get("path") != "octo/repo.git" {
		t.Fatalf("exchange query = %v, want the workspace, host, and repository path", query)
	}
}

func TestWriteStandaloneGitCredentialHelperRestoresOwnerOnlyExecutableMode(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "git-credential-sam")
	if err := os.WriteFile(path, []byte("old helper"), 0o644); err != nil {
		t.Fatalf("seed helper: %v", err)
	}

	if err := writeStandaloneGitCredentialHelper(path, 5*time.Second); err != nil {
		t.Fatalf("write helper: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat helper: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("helper mode = %o, want 700", got)
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

func TestStandaloneGitCredentialHelperNoWorkspaceNoOutput(t *testing.T) {
	t.Parallel()
	out := runStandaloneCredScript(t, "get", "protocol=https\nhost=github.com\n\n", "session-token")
	if out != "" {
		t.Fatalf("expected no output without workspace context, got %q", out)
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
