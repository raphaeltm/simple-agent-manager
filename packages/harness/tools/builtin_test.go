package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func tmpDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return dir
}

func writeTestFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadFile_Success(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "hello.txt", "line one\nline two\n")

	tool := &ReadFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"path": "hello.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "1\tline one") {
		t.Errorf("result missing line numbers: %s", result)
	}
	if !strings.Contains(result, "2\tline two") {
		t.Errorf("result missing second line: %s", result)
	}
}

func TestReadFile_NotFound(t *testing.T) {
	dir := tmpDir(t)
	tool := &ReadFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"path": "nope.txt"})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestWriteFile_CreatesDirectories(t *testing.T) {
	dir := tmpDir(t)
	tool := &WriteFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":    "sub/dir/file.txt",
		"content": "hello",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "sub/dir/file.txt"))
	if string(data) != "hello" {
		t.Errorf("file content = %q, want %q", string(data), "hello")
	}
}

func TestEditFile_UniqueMatch(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "code.go", "func hello() {\n\treturn \"hello\"\n}\n")

	tool := &EditFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"path":       "code.go",
		"old_string": "\"hello\"",
		"new_string": "\"world\"",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "replaced 1") {
		t.Errorf("unexpected result: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "code.go"))
	if !strings.Contains(string(data), "\"world\"") {
		t.Error("edit did not apply")
	}
}

func TestEditFile_NotFound(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "code.go", "abc")

	tool := &EditFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":       "code.go",
		"old_string": "xyz",
		"new_string": "123",
	})
	if err == nil {
		t.Fatal("expected error for non-matching string")
	}
}

func TestEditFile_NonUnique(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "code.go", "aaa bbb aaa")

	tool := &EditFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":       "code.go",
		"old_string": "aaa",
		"new_string": "ccc",
	})
	if err == nil {
		t.Fatal("expected error for non-unique match")
	}
	if !strings.Contains(err.Error(), "2 times") {
		t.Errorf("error should mention count: %v", err)
	}
}

func TestBash_SimpleCommand(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "echo hello",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "hello") {
		t.Errorf("result = %q, want to contain 'hello'", result)
	}
}

func TestBash_Timeout(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir, Timeout: 100 * time.Millisecond}
	_, err := tool.Execute(context.Background(), map[string]any{
		"command": "sleep 10",
	})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %v, want timeout error", err)
	}
}

func TestBash_Cancellation(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir, Timeout: 10 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after a very short delay.
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err := tool.Execute(ctx, map[string]any{
		"command": "sleep 10",
	})
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("error = %v, want cancellation error", err)
	}
}

func TestBash_FailingCommand(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "exit 1",
	})
	if err != nil {
		t.Fatalf("bash tool should not return Go error for non-zero exit: %v", err)
	}
	if !strings.Contains(result, "exit") {
		t.Errorf("result should contain exit info: %q", result)
	}
}

func TestBash_WorkingDirectory(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "marker.txt", "found it")

	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "cat marker.txt",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "found it") {
		t.Errorf("command did not run in correct directory: %q", result)
	}
}
