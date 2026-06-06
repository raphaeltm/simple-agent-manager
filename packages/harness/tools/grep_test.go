package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGrep_BasicMatch(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "package main\n\nfunc hello() {}\nfunc world() {}\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "func.*hello",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "main.go:3:func hello()") {
		t.Errorf("expected match with file:line format, got: %s", result)
	}
}

func TestGrep_NoMatch(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "package main\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "nonexistent",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "No matches found." {
		t.Errorf("expected no-match message, got: %s", result)
	}
}

func TestGrep_IncludeFilter(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "func hello() {}\n")
	writeTestFile(t, dir, "main.ts", "function hello() {}\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "hello",
		"include": "*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "main.go") {
		t.Errorf("expected main.go in results, got: %s", result)
	}
	if strings.Contains(result, "main.ts") {
		t.Errorf("should not include main.ts with *.go filter, got: %s", result)
	}
}

func TestGrep_IncludeFilterMatchesRelativePath(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "src/app/main.go", "needle\n")
	writeTestFile(t, dir, "src/app/main.ts", "needle\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"include": "src/**/*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "src/app/main.go") {
		t.Fatalf("expected Go match, got:\n%s", result)
	}
	if strings.Contains(result, "main.ts") {
		t.Fatalf("unexpected TypeScript match:\n%s", result)
	}
}

func TestGrep_ContextLines(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "code.go", "line1\nline2\nMATCH\nline4\nline5\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern":       "MATCH",
		"context_lines": float64(1),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "line2") {
		t.Errorf("expected context line before match, got: %s", result)
	}
	if !strings.Contains(result, "line4") {
		t.Errorf("expected context line after match, got: %s", result)
	}
	if !strings.Contains(result, "> code.go:3:MATCH") {
		t.Errorf("expected match line with > prefix, got: %s", result)
	}
}

func TestGrep_Subdirectory(t *testing.T) {
	dir := tmpDir(t)
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, "src/app.go", "func main() {}\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "main",
		"path":    "src",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "src/app.go") {
		t.Errorf("expected src/app.go in results, got: %s", result)
	}
}

func TestGrep_SkipsGitDir(t *testing.T) {
	dir := tmpDir(t)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, ".git/config", "secret content\n")
	writeTestFile(t, dir, "main.go", "secret content\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "secret",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, ".git") {
		t.Errorf("should skip .git directory, got: %s", result)
	}
	if !strings.Contains(result, "main.go") {
		t.Errorf("should find match in main.go, got: %s", result)
	}
}

func TestGrep_InvalidRegex(t *testing.T) {
	dir := tmpDir(t)
	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "[invalid",
	})
	if err == nil {
		t.Fatal("expected error for invalid regex")
	}
	if !strings.Contains(err.Error(), "invalid regex") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestGrep_PathTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "anything",
		"path":    "../../etc",
	})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestGrep_AbsolutePathRejected(t *testing.T) {
	dir := tmpDir(t)
	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "anything",
		"path":    "/etc/passwd",
	})
	if err == nil {
		t.Fatal("expected error for absolute path")
	}
}

func TestGrep_RejectsSymlinkSearchRoot(t *testing.T) {
	dir := tmpDir(t)
	outside := t.TempDir()
	writeTestFile(t, outside, "secret.txt", "secret\n")
	if err := os.Symlink(outside, filepath.Join(dir, "linked")); err != nil {
		t.Fatal(err)
	}

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "secret",
		"path":    "linked",
	})
	if err == nil {
		t.Fatal("expected symlink root rejection")
	}
	if strings.Contains(result, "secret") {
		t.Fatalf("leaked external content: %q", result)
	}
}

func TestGrep_SkipsSymlinkFilesAndDirectories(t *testing.T) {
	dir := tmpDir(t)
	outside := t.TempDir()
	writeTestFile(t, outside, "secret.txt", "secret\n")
	writeTestFile(t, dir, "real.txt", "secret\n")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked-dir")); err != nil {
		t.Fatal(err)
	}

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "secret",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, "link.txt") || strings.Contains(result, "linked-dir") || strings.Contains(result, "secret.txt") {
		t.Fatalf("grep should skip symlinks, got:\n%s", result)
	}
	if !strings.Contains(result, "real.txt") {
		t.Fatalf("expected real.txt match, got:\n%s", result)
	}
}

func TestGrep_DeterministicOrdering(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "z.txt", "needle\n")
	writeTestFile(t, dir, "a.txt", "needle\n")
	writeTestFile(t, dir, "m.txt", "needle\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "needle",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := strings.Split(result, "\n")
	want := []string{"a.txt:1:needle", "m.txt:1:needle", "z.txt:1:needle"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("result order = %v, want prefix %v", got, want)
		}
	}
}

func TestGrep_RejectsNegativeContextLines(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "needle\n")

	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern":       "needle",
		"context_lines": float64(-1),
	})
	if err == nil {
		t.Fatal("expected error for negative context_lines")
	}
}

func TestGrep_RejectsNonIntegerContextLines(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "needle\n")

	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern":       "needle",
		"context_lines": float64(1.5),
	})
	if err == nil {
		t.Fatal("expected error for non-integer context_lines")
	}
}

func TestGrep_RejectsInvalidInclude(t *testing.T) {
	dir := tmpDir(t)
	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"include": "../*.go",
	})
	if err == nil {
		t.Fatal("expected error for invalid include")
	}
}

func TestGrep_RejectsNormalizedTraversalInclude(t *testing.T) {
	dir := tmpDir(t)
	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "needle",
		"include": "src/../*.go",
	})
	if err == nil {
		t.Fatal("expected error for traversal include")
	}
}

func TestGrep_ReturnsScannerErrors(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "long.txt", strings.Repeat("a", MaxGrepLineBytes+1))

	tool := &Grep{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "a",
	})
	if err == nil {
		t.Fatal("expected scanner error for long line")
	}
	if !strings.Contains(err.Error(), "scanning long.txt") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGrep_TruncatesMatches(t *testing.T) {
	dir := tmpDir(t)
	var content strings.Builder
	for i := 0; i < MaxGrepMatches+10; i++ {
		fmt.Fprintf(&content, "needle %03d\n", i)
	}
	writeTestFile(t, dir, "many.txt", content.String())

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "needle",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "truncated: showing first") {
		t.Fatalf("expected truncation message")
	}
}
