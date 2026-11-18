package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestStandaloneCloneUsesCallbackUsername(t *testing.T) {
	original := runStandaloneGitCommand
	t.Cleanup(func() { runStandaloneGitCommand = original })
	for _, tc := range []struct {
		name, cloneURL, username, wantUsername string
	}{
		{"hosted fallback", "https://hosted.example.test/git/repo.git", " x ", "x"},
		{"GitHub default", "https://github.com/owner/repo.git", "", "x-access-token"},
		{"Artifacts default", "https://acct.artifacts.cloudflare.net/git/default/repo.git", "", "x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const token = "standalone-clone-test-token"
			called := false
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/workspaces/ws/git-token" || r.Header.Get("Authorization") != "Bearer callback" {
					t.Error("clone requested credentials without its workspace binding")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				called = true
				_ = json.NewEncoder(w).Encode(gitTokenResponse{Token: token, CloneURL: tc.cloneURL, Username: tc.username})
			}))
			defer controlPlane.Close()
			cloned := false
			runStandaloneGitCommand = func(_ context.Context, _ string, env []string, args ...string) (string, error) {
				if !slices.Contains(args, "clone") {
					return "", nil
				}
				cloned = true
				if !slices.Contains(args, tc.cloneURL) || !envContains(env, "SAM_CLONE_CREDENTIAL_USERNAME="+tc.wantUsername) || !envContains(env, "SAM_CLONE_CREDENTIAL_TOKEN="+token) {
					t.Error("clone did not receive the callback URL and matching credential pair")
				}
				if strings.Contains(strings.Join(args, " "), token) {
					t.Error("clone exposed its token in command arguments")
				}
				return "", nil
			}
			s := &Server{config: &config.Config{ControlPlaneURL: controlPlane.URL}}
			runtime := &WorkspaceRuntime{ID: "ws", Repository: "owner/repo", CallbackToken: "callback"}
			if err := s.cloneStandaloneRepository(context.Background(), runtime, filepath.Join(t.TempDir(), "repo")); err != nil {
				t.Fatal(err)
			}
			if !called || !cloned {
				t.Fatal("credential callback and standalone clone must both run")
			}
		})
	}
}

func TestStandaloneCloneWarnings(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{name: "no warnings", output: "Cloning into '/workspaces/repo'...\ndone.", want: ""},
		{
			name:   "filter ignored warning surfaces",
			output: "Cloning into '/workspaces/repo'...\nwarning: filtering not recognized by server, ignoring\ndone.",
			want:   "warning: filtering not recognized by server, ignoring",
		},
		{
			name:   "multiple warnings joined",
			output: "warning: one\nprogress line\nWarning: two",
			want:   "warning: one; Warning: two",
		},
		{name: "empty output", output: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := standaloneCloneWarnings(tc.output); got != tc.want {
				t.Fatalf("standaloneCloneWarnings(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}

func TestStandaloneCloneWarningsBounded(t *testing.T) {
	long := "warning: " + string(make([]byte, 4096))
	if got := standaloneCloneWarnings(long); len(got) > 1024 {
		t.Fatalf("warnings length = %d, want <= 1024", len(got))
	}
}

func TestStandaloneCloneBaseAndOutputBranches(t *testing.T) {
	repo, remote := initSnapshotRemoteRepo(t)
	runGit(t, remote, "symbolic-ref", "HEAD", "refs/heads/main")
	runGit(t, remote, "config", "uploadpack.allowFilter", "true")
	mainTip := gitOutput(t, repo, "rev-parse", "HEAD")
	runGit(t, repo, "checkout", "-b", "existing-output")
	mustWriteSnapshotFile(t, repo, "output.txt", "existing output work")
	runGit(t, repo, "add", "output.txt")
	runGit(t, repo, "commit", "-m", "existing output work")
	existingTip := gitOutput(t, repo, "rev-parse", "HEAD")
	runGit(t, repo, "push", "origin", "existing-output")
	original := runStandaloneGitCommand
	t.Cleanup(func() { runStandaloneGitCommand = original })
	// Only replace the transport URL. Every clone/ref/checkout operation runs real git.
	runStandaloneGitCommand = func(ctx context.Context, dir string, env []string, args ...string) (string, error) {
		if i := slices.Index(args, "https://example.test/repo.git"); i >= 0 {
			args[i] = "file://" + remote
		}
		return original(ctx, dir, env, args...)
	}
	for _, tc := range []struct{ name, base, branch, wantBranch, wantTip string }{
		{"generated", "main", "sam/generated-output", "sam/generated-output", mainTip},
		{"existing", "main", "existing-output", "existing-output", existingTip},
		{"same", "main", "main", "main", mainTip},
		{"legacy", "", "existing-output", "existing-output", existingTip},
		{"default", "", "", "main", mainTip},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "checkout")
			s := &Server{config: &config.Config{StandaloneCloneFilter: "blob:none"}}
			runtime := &WorkspaceRuntime{ID: "test", Repository: "https://example.test/repo.git", BaseBranch: tc.base, Branch: tc.branch}
			if err := s.cloneStandaloneRepository(context.Background(), runtime, dir); err != nil {
				t.Fatal(err)
			}
			if got := gitOutput(t, dir, "branch", "--show-current"); got != tc.wantBranch {
				t.Fatalf("branch = %s, want %s", got, tc.wantBranch)
			}
			if got := gitOutput(t, dir, "rev-parse", "HEAD"); got != tc.wantTip {
				t.Fatalf("HEAD = %s, want %s", got, tc.wantTip)
			}
			if got := gitOutput(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD"); got != "refs/remotes/origin/main" {
				t.Fatalf("default ref = %s", got)
			}
		})
	}
}

func TestStandaloneCheckoutKeepsCredentialsAndRedactsFailure(t *testing.T) {
	original := runStandaloneGitCommand
	t.Cleanup(func() { runStandaloneGitCommand = original })
	const token = "checkout-secret-canary"
	helper := ""
	checkoutCalled := false
	runStandaloneGitCommand = func(_ context.Context, _ string, env []string, args ...string) (string, error) {
		if !slices.Contains(args, "checkout") {
			return "", nil
		}
		checkoutCalled = true
		helper = standaloneCloneCredentialHelperPath(env)
		if helper == "" || !strings.Contains(strings.Join(args, " "), "credential.helper="+helper) {
			t.Fatal("partial checkout lost credential helper")
		}
		if !envContains(env, "SAM_CLONE_CREDENTIAL_TOKEN="+token) {
			t.Fatal("checkout lost scoped token")
		}
		if _, err := os.Stat(helper); err != nil {
			t.Fatalf("helper removed before checkout: %v", err)
		}
		return "remote rejected " + token, errors.New("checkout rejected")
	}
	s := &Server{config: &config.Config{StandaloneCloneFilter: "blob:none"}}
	runtime := &WorkspaceRuntime{Repository: "https://user:" + token + "@example.test/repo.git", BaseBranch: "main", Branch: "output"}
	workDir := filepath.Join(t.TempDir(), "checkout")
	if err := os.MkdirAll(filepath.Join(workDir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	err := s.cloneStandaloneRepository(context.Background(), runtime, workDir)
	if _, statErr := os.Stat(workDir); !os.IsNotExist(statErr) {
		t.Fatalf("failed checkout remains reusable on retry: %v", statErr)
	}
	if !checkoutCalled || err == nil {
		t.Fatalf("checkout failure was not exercised: %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Fatal("checkout error leaked credential")
	}
	if _, err := os.Stat(helper); !os.IsNotExist(err) {
		t.Fatalf("temporary credential helper remains: %v", err)
	}
}
