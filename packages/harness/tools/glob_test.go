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

func TestGlob_DoubleStarMiddleSegment(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "src/test/root_test.go", "")
	writeTestFile(t, dir, "src/pkg/test/pkg_test.go", "")
	writeTestFile(t, dir, "src/pkg/deep/test/deep_test.go", "")
	writeTestFile(t, dir, "src/pkg/deep/not-test/nope.go", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "src/**/test/*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"src/pkg/deep/test/deep_test.go",
		"src/pkg/test/pkg_test.go",
		"src/test/root_test.go",
	} {
		if !strings.Contains(result, want) {
			t.Fatalf("expected %s, got:\n%s", want, result)
		}
	}
	if strings.Contains(result, "not-test") {
		t.Fatalf("matched non-test directory:\n%s", result)
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

func TestGlob_RootLevelMatching(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "root.ts", "")
	writeTestFile(t, dir, "src/app.ts", "")
	writeTestFile(t, dir, "src/nested/app.ts", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "src/**/*.ts",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, "root.ts") {
		t.Fatalf("src pattern matched root file:\n%s", result)
	}
	if !strings.Contains(result, "src/app.ts") || !strings.Contains(result, "src/nested/app.ts") {
		t.Fatalf("missing src matches:\n%s", result)
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
	if result != "No files matched." {
		t.Errorf("expected no-match message, got: %s", result)
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

func TestGlob_SkipsSymlinkFilesAndDirectories(t *testing.T) {
	dir := tmpDir(t)
	outside := t.TempDir()
	writeTestFile(t, outside, "secret.go", "")
	writeTestFile(t, dir, "real.go", "")
	if err := os.Symlink(filepath.Join(outside, "secret.go"), filepath.Join(dir, "link.go")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked-dir")); err != nil {
		t.Fatal(err)
	}

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "**/*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, "link.go") || strings.Contains(result, "linked-dir") || strings.Contains(result, "secret.go") {
		t.Fatalf("glob should skip symlinks, got:\n%s", result)
	}
	if !strings.Contains(result, "real.go") {
		t.Fatalf("expected real.go, got:\n%s", result)
	}
}

func TestGlob_DeterministicOrdering(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "z.go", "")
	writeTestFile(t, dir, "a.go", "")
	writeTestFile(t, dir, "m.go", "")

	tool := &Glob{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "*.go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := strings.Split(result, "\n")
	want := []string{"a.go", "m.go", "z.go"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("result order = %v, want prefix %v", got, want)
		}
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

func TestGlob_RejectsNormalizedTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &Glob{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "src/../*.go",
	})
	if err == nil {
		t.Fatal("expected error for traversal segment")
	}
}

func TestGlob_RejectsEmptyPattern(t *testing.T) {
	dir := tmpDir(t)
	tool := &Glob{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"pattern": "",
	})
	if err == nil {
		t.Fatal("expected error for empty pattern")
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
