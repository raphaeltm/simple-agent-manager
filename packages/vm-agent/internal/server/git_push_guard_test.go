package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func runPushGuardGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func setupPushGuardRepository(t *testing.T, branch string) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	workDir := filepath.Join(root, "workspace")
	runPushGuardGit(t, root, "init", "--bare", remote)
	runPushGuardGit(t, root, "clone", remote, workDir)
	runPushGuardGit(t, workDir, "config", "user.name", "SAM Test")
	runPushGuardGit(t, workDir, "config", "user.email", "sam-test@example.com")
	if err := os.WriteFile(filepath.Join(workDir, "README.md"), []byte("initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runPushGuardGit(t, workDir, "add", "README.md")
	runPushGuardGit(t, workDir, "commit", "-m", "initial")
	runPushGuardGit(t, workDir, "branch", "-M", "main")
	runPushGuardGit(t, workDir, "push", "-u", "origin", "main")
	if branch != "main" {
		runPushGuardGit(t, workDir, "switch", "-c", branch)
	}
	return remote, workDir
}

func newStandalonePushGuardServer(workDir, branch string) *Server {
	workspaceID := "workspace-1"
	return &Server{
		config: &config.Config{Role: config.RoleStandalone, WorkspaceDir: workDir},
		workspaces: map[string]*WorkspaceRuntime{
			workspaceID: {
				ID: workspaceID, Status: "running", WorkspaceDir: workDir,
				Branch: branch, DefaultBranch: "main",
			},
		},
	}
}

func writeAgentChange(t *testing.T, workDir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(workDir, "agent-change.txt"), []byte("agent work\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCreateWorkspaceRuntimeOptionsCarriesDefaultBranch(t *testing.T) {
	opts := createWorkspaceRuntimeOptions(createWorkspaceRequest{
		Branch: "sam/task-output", DefaultBranch: " main ",
	}, "")
	if opts.DefaultBranch != "main" {
		t.Fatalf("DefaultBranch = %q, want main", opts.DefaultBranch)
	}
}
