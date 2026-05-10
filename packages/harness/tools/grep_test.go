package tools

import (
	"context"
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
	if !strings.Contains(result, "No matches found") {
		t.Errorf("expected no-match message, got: %s", result)
	}
	if !strings.Contains(result, "nonexistent") {
		t.Errorf("expected pattern in hint message, got: %s", result)
	}
	if !strings.Contains(result, "Try a broader pattern") {
		t.Errorf("expected helpful hint, got: %s", result)
	}
}

func TestGrep_MatchCount(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "a.go", "func hello() {}\nfunc world() {}\n")
	writeTestFile(t, dir, "b.go", "func hello() {}\n")

	tool := &Grep{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "func",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Found 3 matches across 2 files") {
		t.Errorf("expected match count summary, got: %s", result)
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
