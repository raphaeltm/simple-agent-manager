package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGlob_SimplePattern(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "")
	writeTestFile(t, dir, "main_test.go", "")
	writeTestFile(t, dir, "readme.md", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "main.go") {
		t.Errorf("expected main.go, got: %s", result)
	}
	if !strings.Contains(result, "main_test.go") {
		t.Errorf("expected main_test.go, got: %s", result)
	}
	if strings.Contains(result, "readme.md") {
		t.Errorf("should not include readme.md, got: %s", result)
	}
}

func TestGlob_DoubleStarPattern(t *testing.T) {
	dir := tmpDir(t)
	if err := os.MkdirAll(filepath.Join(dir, "src", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, "root.go", "")
	writeTestFile(t, dir, "src/app.go", "")
	writeTestFile(t, dir, "src/pkg/lib.go", "")
	writeTestFile(t, dir, "src/pkg/lib.ts", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "**/*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "root.go") {
		t.Errorf("expected root.go, got: %s", result)
	}
	if !strings.Contains(result, "src/app.go") {
		t.Errorf("expected src/app.go, got: %s", result)
	}
	if !strings.Contains(result, filepath.Join("src", "pkg", "lib.go")) {
		t.Errorf("expected src/pkg/lib.go, got: %s", result)
	}
	if strings.Contains(result, "lib.ts") {
		t.Errorf("should not include .ts files, got: %s", result)
	}
}

func TestGlob_PrefixedPattern(t *testing.T) {
	dir := tmpDir(t)
	if err := os.MkdirAll(filepath.Join(dir, "src", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, "src/a.ts", "")
	writeTestFile(t, dir, "src/sub/b.ts", "")
	writeTestFile(t, dir, "other/c.ts", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "src/**/*.ts",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, filepath.Join("src", "a.ts")) {
		t.Errorf("expected src/a.ts, got: %s", result)
	}
	if !strings.Contains(result, filepath.Join("src", "sub", "b.ts")) {
		t.Errorf("expected src/sub/b.ts, got: %s", result)
	}
	if strings.Contains(result, "other") {
		t.Errorf("should not include other/ files, got: %s", result)
	}
}

func TestGlob_NoMatch(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "main.go", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.xyz",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "No files found matching") {
		t.Errorf("expected no-match message, got: %s", result)
	}
	if !strings.Contains(result, "*.xyz") {
		t.Errorf("expected pattern in message, got: %s", result)
	}
}

func TestGlob_FileCount(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "a.go", "")
	writeTestFile(t, dir, "b.go", "")
	writeTestFile(t, dir, "c.go", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Found 3 files matching pattern") {
		t.Errorf("expected file count summary, got: %s", result)
	}
}

func TestGlob_SkipsGitDir(t *testing.T) {
	dir := tmpDir(t)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, ".git/config", "")
	writeTestFile(t, dir, "main.go", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "**/*",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, ".git") {
		t.Errorf("should skip .git directory, got: %s", result)
	}
	if !strings.Contains(result, "main.go") {
		t.Errorf("should find main.go, got: %s", result)
	}
}

func TestGlob_PathTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &Glob{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "../../etc/*",
	})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestGlob_AbsolutePathRejected(t *testing.T) {
	dir := tmpDir(t)
	tool := &Glob{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "/etc/*.conf",
	})
	if err == nil {
		t.Fatal("expected error for absolute path")
	}
}
