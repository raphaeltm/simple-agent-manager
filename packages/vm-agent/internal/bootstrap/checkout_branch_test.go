package bootstrap

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateCheckoutBranchCreatesTaskBranchFromCloneBase(t *testing.T) {
	t.Parallel()

	repo := t.TempDir()
	runCheckoutBranchGit(t, repo, "init", "--initial-branch=main")
	runCheckoutBranchGit(t, repo, "config", "user.name", "SAM Test")
	runCheckoutBranchGit(t, repo, "config", "user.email", "sam@example.invalid")
	runCheckoutBranchGit(t, repo, "commit", "--allow-empty", "-m", "base")
	baseCommit := runCheckoutBranchGit(t, repo, "rev-parse", "HEAD")

	const outputBranch = "sam/staging-verification-output"
	if err := createCheckoutBranch(context.Background(), repo, "main", outputBranch); err != nil {
		t.Fatalf("create checkout branch: %v", err)
	}

	if got := runCheckoutBranchGit(t, repo, "branch", "--show-current"); got != outputBranch {
		t.Fatalf("current branch = %q, want %q", got, outputBranch)
	}
	if got := runCheckoutBranchGit(t, repo, "rev-parse", "HEAD"); got != baseCommit {
		t.Fatalf("checkout branch commit = %q, want base commit %q", got, baseCommit)
	}
}

func TestCreateCheckoutBranchKeepsExistingExplicitBranch(t *testing.T) {
	t.Parallel()

	repo := t.TempDir()
	runCheckoutBranchGit(t, repo, "init", "--initial-branch=feature/existing")
	runCheckoutBranchGit(t, repo, "config", "user.name", "SAM Test")
	runCheckoutBranchGit(t, repo, "config", "user.email", "sam@example.invalid")
	runCheckoutBranchGit(t, repo, "commit", "--allow-empty", "-m", "base")

	if err := createCheckoutBranch(context.Background(), repo, "feature/existing", "feature/existing"); err != nil {
		t.Fatalf("keep explicit branch: %v", err)
	}
	if got := runCheckoutBranchGit(t, repo, "branch", "--show-current"); got != "feature/existing" {
		t.Fatalf("current branch = %q, want feature/existing", got)
	}
}

func TestCreateCheckoutBranchTracksExistingRemoteBranch(t *testing.T) {
	t.Parallel()

	remote := filepath.Join(t.TempDir(), "remote.git")
	runCheckoutBranchGit(t, filepath.Dir(remote), "init", "--bare", remote)
	seed := t.TempDir()
	runCheckoutBranchGit(t, seed, "init", "--initial-branch=main")
	runCheckoutBranchGit(t, seed, "config", "user.name", "SAM Test")
	runCheckoutBranchGit(t, seed, "config", "user.email", "sam@example.invalid")
	runCheckoutBranchGit(t, seed, "commit", "--allow-empty", "-m", "main")
	runCheckoutBranchGit(t, seed, "remote", "add", "origin", remote)
	runCheckoutBranchGit(t, seed, "push", "-u", "origin", "main")
	runCheckoutBranchGit(t, seed, "checkout", "-b", "sam/saved-task")
	if err := os.WriteFile(filepath.Join(seed, "saved.txt"), []byte("saved"), 0o600); err != nil {
		t.Fatal(err)
	}
	runCheckoutBranchGit(t, seed, "add", "saved.txt")
	runCheckoutBranchGit(t, seed, "commit", "-m", "saved task state")
	savedCommit := runCheckoutBranchGit(t, seed, "rev-parse", "HEAD")
	runCheckoutBranchGit(t, seed, "push", "-u", "origin", "sam/saved-task")

	workspace := filepath.Join(t.TempDir(), "workspace")
	runCheckoutBranchGit(t, filepath.Dir(workspace), "clone", "--branch", "main", remote, workspace)
	if err := createCheckoutBranch(context.Background(), workspace, "main", "sam/saved-task"); err != nil {
		t.Fatalf("create checkout branch: %v", err)
	}

	if got := runCheckoutBranchGit(t, workspace, "rev-parse", "HEAD"); got != savedCommit {
		t.Fatalf("checkout branch commit = %q, want saved remote commit %q", got, savedCommit)
	}
	if got := runCheckoutBranchGit(t, workspace, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); got != "origin/sam/saved-task" {
		t.Fatalf("checkout upstream = %q, want origin/sam/saved-task", got)
	}
}

func TestCreateCheckoutBranchDoesNotTreatInspectionFailureAsMissingBranch(t *testing.T) {
	workspace := t.TempDir()
	err := createCheckoutBranch(context.Background(), workspace, "main", "sam/saved-task")
	if err == nil || !strings.Contains(err.Error(), "failed to inspect remote checkout branch") {
		t.Fatalf("createCheckoutBranch() error = %v, want remote inspection failure", err)
	}
}

func runCheckoutBranchGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	cmdArgs := append([]string{"-C", filepath.Clean(repo)}, args...)
	output, err := exec.Command("git", cmdArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
