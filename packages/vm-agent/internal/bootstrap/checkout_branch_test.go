package bootstrap

import (
	"context"
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

func runCheckoutBranchGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	cmdArgs := append([]string{"-C", filepath.Clean(repo)}, args...)
	output, err := exec.Command("git", cmdArgs...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
