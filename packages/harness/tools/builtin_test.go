package tools

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatal(err)
	}
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
	if err == nil {
		t.Fatal("bash tool should return Go error for non-zero exit")
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

func TestBash_RejectsEmptyWorkDir(t *testing.T) {
	tool := &Bash{}
	_, err := tool.Execute(context.Background(), map[string]any{
		"command": "pwd",
	})
	if err == nil {
		t.Fatal("expected error for empty workdir")
	}
	if !strings.Contains(err.Error(), "workdir must not be empty") {
		t.Errorf("error = %v, want empty workdir error", err)
	}
}

func TestBash_RejectsInvalidWorkDir(t *testing.T) {
	tool := &Bash{WorkDir: filepath.Join(t.TempDir(), "missing")}
	_, err := tool.Execute(context.Background(), map[string]any{
		"command": "pwd",
	})
	if err == nil {
		t.Fatal("expected error for invalid workdir")
	}
	if !strings.Contains(err.Error(), "resolving workdir symlinks") && !strings.Contains(err.Error(), "stat workdir") {
		t.Errorf("error = %v, want invalid workdir error", err)
	}
}

func TestBash_CleansSuccessfulBackgroundChild(t *testing.T) {
	dir := tmpDir(t)
	pidFile := filepath.Join(dir, "bg.pid")
	tool := &Bash{WorkDir: dir}

	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "sleep 30 </dev/null >/dev/null 2>&1 & printf '%s\n' \"$!\" > bg.pid; echo done",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "done") {
		t.Fatalf("result = %q, want successful command output", result)
	}

	pidData, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("expected background pid file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil {
		t.Fatalf("invalid background pid %q: %v", pidData, err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	})

	if !waitForProcessExit(pid, 1*time.Second) {
		t.Fatalf("background child pid %d is still alive after Bash.Execute returned", pid)
	}
}

func TestReadFile_PathTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &ReadFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"path": "../../etc/passwd"})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestReadFile_AbsolutePathRejected(t *testing.T) {
	dir := tmpDir(t)
	tool := &ReadFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"path": "/etc/passwd"})
	if err == nil {
		t.Fatal("expected error for absolute path")
	}
}

func TestWriteFile_PathTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &WriteFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":    "../../tmp/evil.txt",
		"content": "pwned",
	})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestEditFile_PathTraversal(t *testing.T) {
	dir := tmpDir(t)
	tool := &EditFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":       "../../tmp/evil.txt",
		"old_string": "foo",
		"new_string": "bar",
	})
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestReadFile_RejectsSymlinkEscape(t *testing.T) {
	dir := tmpDir(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("external secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	tool := &ReadFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"path": "link.txt"})
	if err == nil {
		t.Fatal("expected symlink rejection")
	}
	if strings.Contains(result, "external secret") {
		t.Fatalf("leaked external content: %q", result)
	}
}

func TestReadFile_TruncatesLargeFile(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "large.txt", strings.Repeat("a", MaxReadFileBytes+128))

	tool := &ReadFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"path": "large.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "truncated: showing first") {
		t.Fatalf("expected truncation message, got tail: %q", result[len(result)-80:])
	}
}

func TestWriteFile_RejectsFinalPathSymlink(t *testing.T) {
	dir := tmpDir(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	tool := &WriteFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":    "link.txt",
		"content": "overwrite",
	})
	if err == nil {
		t.Fatal("expected symlink rejection")
	}
	data, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "keep" {
		t.Fatalf("external symlink target was modified: %q", string(data))
	}
}

func TestEditFile_RejectsSymlinkBeforeReading(t *testing.T) {
	dir := tmpDir(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	tool := &EditFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"path":       "link.txt",
		"old_string": "secret",
		"new_string": "public",
	})
	if err == nil {
		t.Fatal("expected symlink rejection")
	}
	if strings.Contains(result, "secret") {
		t.Fatalf("leaked external content: %q", result)
	}
}

func TestEditFile_RejectsEmptyOldString(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "code.go", "abc")

	tool := &EditFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":       "code.go",
		"old_string": "",
		"new_string": "x",
	})
	if err == nil {
		t.Fatal("expected error for empty old_string")
	}
}

func TestBash_TruncatesStdoutAndStderr(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "printf '%*s' 70000 '' | tr ' ' a; printf '%*s' 70000 '' | tr ' ' b >&2",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "truncated stdout") {
		t.Fatalf("expected stdout truncation message")
	}
	if !strings.Contains(result, "truncated stderr") {
		t.Fatalf("expected stderr truncation message")
	}
}

func waitForProcessExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !processExists(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func processExists(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
