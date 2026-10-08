package server

import (
	"context"
	"github.com/workspace/vm-agent/internal/config"
	"path/filepath"
	"testing"
)

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
		for i, arg := range args {
			if arg == "https://example.test/repo.git" {
				args[i] = "file://" + remote
			}
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
