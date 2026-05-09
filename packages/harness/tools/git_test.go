package tools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initGitRepo creates a temporary directory with an initialized git repo and one commit.
func initGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		{"git", "commit", "--allow-empty", "-m", "initial commit"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git init setup (%v): %v\n%s", args, err, out)
		}
	}
	return dir
}

// --- GitStatus tests ---

func TestGitStatus_Clean(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitStatus{WorkDir: dir}

	result, err := tool.Execute(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if parsed["clean"] != true {
		t.Errorf("expected clean=true, got %v", parsed["clean"])
	}
}

func TestGitStatus_WithChanges(t *testing.T) {
	dir := initGitRepo(t)
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hello"), 0o644)

	tool := &GitStatus{WorkDir: dir}
	result, err := tool.Execute(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(result), &parsed); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if parsed["clean"] != false {
		t.Errorf("expected clean=false, got %v", parsed["clean"])
	}
	entries := parsed["entries"].([]any)
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
	entry := entries[0].(map[string]any)
	if entry["path"] != "new.txt" {
		t.Errorf("expected path=new.txt, got %v", entry["path"])
	}
}

func TestGitStatus_NotARepo(t *testing.T) {
	dir := t.TempDir()
	tool := &GitStatus{WorkDir: dir}
	_, err := tool.Execute(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error for non-git directory")
	}
}

// --- GitDiff tests ---

func TestGitDiff_NoChanges(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitDiff{WorkDir: dir}

	result, err := tool.Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	if parsed["empty"] != true {
		t.Errorf("expected empty=true, got %v", parsed["empty"])
	}
}

func TestGitDiff_UnstagedChanges(t *testing.T) {
	dir := initGitRepo(t)
	// Create and commit a file, then modify it
	fpath := filepath.Join(dir, "file.txt")
	os.WriteFile(fpath, []byte("original"), 0o644)
	cmd := exec.Command("git", "add", "-A")
	cmd.Dir = dir
	cmd.Run()
	cmd = exec.Command("git", "commit", "-m", "add file")
	cmd.Dir = dir
	cmd.Run()

	// Modify the file
	os.WriteFile(fpath, []byte("modified"), 0o644)

	tool := &GitDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	if parsed["empty"] != false {
		t.Errorf("expected empty=false")
	}
	diff := parsed["diff"].(string)
	if !strings.Contains(diff, "original") || !strings.Contains(diff, "modified") {
		t.Errorf("diff should contain old and new content: %s", diff)
	}
}

func TestGitDiff_Staged(t *testing.T) {
	dir := initGitRepo(t)
	fpath := filepath.Join(dir, "file.txt")
	os.WriteFile(fpath, []byte("staged content"), 0o644)
	cmd := exec.Command("git", "add", "file.txt")
	cmd.Dir = dir
	cmd.Run()

	tool := &GitDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"staged": true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	if parsed["empty"] != false {
		t.Errorf("expected staged diff to be non-empty")
	}
}

func TestGitDiff_PathContainment(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitDiff{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"path": "../../etc/passwd"})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error: %v", err)
	}
}

// --- GitLog tests ---

func TestGitLog_ReturnsCommits(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitLog{WorkDir: dir}

	result, err := tool.Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	commits := parsed["commits"].([]any)
	if len(commits) < 1 {
		t.Fatal("expected at least 1 commit")
	}
	first := commits[0].(map[string]any)
	if first["hash"] == "" {
		t.Error("commit hash should not be empty")
	}
	if first["message"] != "initial commit" {
		t.Errorf("expected 'initial commit', got %v", first["message"])
	}
}

func TestGitLog_WithCount(t *testing.T) {
	dir := initGitRepo(t)
	// Add more commits
	for i := 0; i < 5; i++ {
		cmd := exec.Command("git", "commit", "--allow-empty", "-m", "commit")
		cmd.Dir = dir
		cmd.Run()
	}

	tool := &GitLog{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"count": float64(3)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	commits := parsed["commits"].([]any)
	if len(commits) != 3 {
		t.Errorf("expected 3 commits, got %d", len(commits))
	}
}

func TestGitLog_NotARepo(t *testing.T) {
	dir := t.TempDir()
	tool := &GitLog{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("expected error for non-git directory")
	}
}

// --- GitCommit tests ---

func TestGitCommit_Success(t *testing.T) {
	dir := initGitRepo(t)
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("content"), 0o644)

	tool := &GitCommit{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"message": "add new file",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	hash := parsed["hash"].(string)
	if len(hash) < 7 {
		t.Errorf("expected commit hash, got %q", hash)
	}
	if parsed["message"] != "add new file" {
		t.Errorf("expected message 'add new file', got %v", parsed["message"])
	}

	// Verify the commit exists in git log
	cmd := exec.Command("git", "log", "--oneline", "-1")
	cmd.Dir = dir
	out, _ := cmd.Output()
	if !strings.Contains(string(out), "add new file") {
		t.Errorf("commit not found in log: %s", out)
	}
}

func TestGitCommit_SpecificPaths(t *testing.T) {
	dir := initGitRepo(t)
	os.WriteFile(filepath.Join(dir, "include.txt"), []byte("yes"), 0o644)
	os.WriteFile(filepath.Join(dir, "exclude.txt"), []byte("no"), 0o644)

	tool := &GitCommit{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"message": "only include.txt",
		"paths":   []any{"include.txt"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify exclude.txt is still untracked
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, _ := cmd.Output()
	if !strings.Contains(string(out), "exclude.txt") {
		t.Error("exclude.txt should still be untracked")
	}
}

func TestGitCommit_NothingToCommit(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitCommit{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"message": "empty commit",
	})
	if err == nil {
		t.Fatal("expected error when nothing to commit")
	}
}

func TestGitCommit_EmptyMessage(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitCommit{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"message": "",
	})
	if err == nil {
		t.Fatal("expected error for empty message")
	}
}

func TestGitCommit_PathTraversal(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitCommit{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"message": "evil",
		"paths":   []any{"../../etc/passwd"},
	})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error: %v", err)
	}
}

// --- GitBranch tests ---

func TestGitBranch_List(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitBranch{WorkDir: dir}

	result, err := tool.Execute(context.Background(), map[string]any{"action": "list"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	branches := parsed["branches"].([]any)
	if len(branches) < 1 {
		t.Fatal("expected at least 1 branch")
	}
	current := parsed["current"].(string)
	if current == "" {
		t.Error("expected a current branch")
	}
}

func TestGitBranch_Create(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitBranch{WorkDir: dir}

	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "create",
		"name":   "feature/test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	if parsed["created"] != "feature/test" {
		t.Errorf("expected created=feature/test, got %v", parsed["created"])
	}

	// Verify branch exists
	cmd := exec.Command("git", "branch")
	cmd.Dir = dir
	out, _ := cmd.Output()
	if !strings.Contains(string(out), "feature/test") {
		t.Error("branch not created")
	}
}

func TestGitBranch_Checkout(t *testing.T) {
	dir := initGitRepo(t)
	// Create branch first
	cmd := exec.Command("git", "branch", "dev")
	cmd.Dir = dir
	cmd.Run()

	tool := &GitBranch{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"action": "checkout",
		"name":   "dev",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal([]byte(result), &parsed)
	if parsed["checked_out"] != "dev" {
		t.Errorf("expected checked_out=dev, got %v", parsed["checked_out"])
	}

	// Verify current branch
	headCmd := exec.Command("git", "branch", "--show-current")
	headCmd.Dir = dir
	out, _ := headCmd.Output()
	if strings.TrimSpace(string(out)) != "dev" {
		t.Errorf("expected current branch=dev, got %s", out)
	}
}

func TestGitBranch_CheckoutNonexistent(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitBranch{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"action": "checkout",
		"name":   "nonexistent",
	})
	if err == nil {
		t.Fatal("expected error for nonexistent branch")
	}
}

func TestGitBranch_InvalidAction(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitBranch{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"action": "delete",
	})
	if err == nil {
		t.Fatal("expected error for invalid action")
	}
}

func TestGitBranch_CreateMissingName(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitBranch{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"action": "create",
	})
	if err == nil {
		t.Fatal("expected error when name is missing")
	}
}
