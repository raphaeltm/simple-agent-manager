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

// --- ReadFile tests ---

func TestReadFile_Success(t *testing.T) {
	dir := tmpDir(t)
	writeTestFile(t, dir, "hello.txt", "line one\nline two\n")

	tool := &ReadFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"path": "hello.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "File: hello.txt (2 lines)") {
		t.Errorf("missing file header: %s", result)
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

func TestReadFile_Truncation(t *testing.T) {
	dir := tmpDir(t)
	// Create a file with more lines than maxReadLines.
	var b strings.Builder
	lineCount := maxReadLines + 50
	for i := 0; i < lineCount; i++ {
		b.WriteString("line content\n")
	}
	writeTestFile(t, dir, "big.txt", b.String())

	tool := &ReadFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"path": "big.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "[truncated") {
		t.Errorf("expected truncation notice, got: %s", result[:200])
	}
	if !strings.Contains(result, "lines omitted") {
		t.Errorf("expected omitted count in truncation notice, got: %s", result[len(result)-200:])
	}
}

// --- WriteFile tests ---

func TestWriteFile_CreatesDirectories(t *testing.T) {
	dir := tmpDir(t)
	tool := &WriteFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
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
	if !strings.Contains(result, "Created") {
		t.Errorf("expected 'Created' in result for new file, got: %s", result)
	}
}

func TestWriteFile_CreateVsOverwrite(t *testing.T) {
	dir := tmpDir(t)
	tool := &WriteFile{WorkDir: dir}

	// First write — should say "Created".
	result, err := tool.Execute(context.Background(), map[string]any{
		"path":    "test.txt",
		"content": "first\nsecond\nthird\n",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(result, "Created") {
		t.Errorf("expected 'Created' prefix, got: %s", result)
	}
	if !strings.Contains(result, "3 lines") {
		t.Errorf("expected '3 lines', got: %s", result)
	}

	// Second write — should say "Overwrote".
	result, err = tool.Execute(context.Background(), map[string]any{
		"path":    "test.txt",
		"content": "one\ntwo\nthree\nfour\nfive\n",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(result, "Overwrote") {
		t.Errorf("expected 'Overwrote' prefix, got: %s", result)
	}
	if !strings.Contains(result, "was 3 lines") {
		t.Errorf("expected 'was 3 lines', got: %s", result)
	}
	if !strings.Contains(result, "5 lines") {
		t.Errorf("expected '5 lines' for new content, got: %s", result)
	}
}

// --- EditFile tests ---

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
	if !strings.Contains(result, "Edited code.go") {
		t.Errorf("expected 'Edited code.go' in result, got: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "code.go"))
	if !strings.Contains(string(data), "\"world\"") {
		t.Error("edit did not apply")
	}
}

func TestEditFile_ContextAroundEdit(t *testing.T) {
	dir := tmpDir(t)
	content := "line1\nline2\nline3\nTARGET\nline5\nline6\nline7\n"
	writeTestFile(t, dir, "ctx.txt", content)

	tool := &EditFile{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"path":       "ctx.txt",
		"old_string": "TARGET",
		"new_string": "REPLACED",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should show the replaced line with arrow marker.
	if !strings.Contains(result, "→") {
		t.Errorf("expected arrow marker for edited line, got: %s", result)
	}
	// Should show context lines with pipe marker.
	if !strings.Contains(result, "│") {
		t.Errorf("expected pipe marker for context lines, got: %s", result)
	}
	// Should show surrounding lines.
	if !strings.Contains(result, "line2") || !strings.Contains(result, "line6") {
		t.Errorf("expected context lines around edit, got: %s", result)
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

func TestEditFile_SimilarLineSuggestions(t *testing.T) {
	dir := tmpDir(t)
	content := "func handleRequest(w http.ResponseWriter, r *http.Request) {\n\tw.Write([]byte(\"ok\"))\n}\n"
	writeTestFile(t, dir, "handler.go", content)

	tool := &EditFile{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{
		"path":       "handler.go",
		"old_string": "func handleRequest(w ResponseWriter",
		"new_string": "something",
	})
	if err == nil {
		t.Fatal("expected error for non-matching string")
	}
	// The error should contain a "Did you mean" suggestion.
	if !strings.Contains(err.Error(), "Did you mean") {
		t.Errorf("expected similar-line suggestion, got: %v", err)
	}
	if !strings.Contains(err.Error(), "handleRequest") {
		t.Errorf("expected suggestion to mention the similar line, got: %v", err)
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

// --- Bash tests ---

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

func TestBash_IncludesDuration(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "echo hi",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "(completed in") {
		t.Errorf("expected duration in output, got: %s", result)
	}
}

func TestBash_IncludesWorkingDir(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "echo test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "[cwd:") {
		t.Errorf("expected working directory in output, got: %s", result)
	}
}

func TestBash_DangerousCommandRejected(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}

	tests := []struct {
		cmd  string
		desc string
	}{
		{"rm -rf /", "rm -rf root"},
		{"rm -rf /*", "rm -rf root wildcard"},
		{"mkfs.ext4 /dev/sda", "mkfs"},
		{"dd if=/dev/zero of=/dev/sda", "dd"},
		{"chmod -R 777 /", "chmod 777 root"},
	}

	for _, tc := range tests {
		t.Run(tc.desc, func(t *testing.T) {
			_, err := tool.Execute(context.Background(), map[string]any{
				"command": tc.cmd,
			})
			if err == nil {
				t.Fatalf("expected rejection for %q", tc.cmd)
			}
			if !strings.Contains(err.Error(), "command rejected") {
				t.Errorf("expected 'command rejected' error, got: %v", err)
			}
		})
	}
}

func TestBash_SafeCommandAllowed(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	// "rm -rf ./build" should be allowed (no root path).
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "echo 'rm -rf ./build would be fine'",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "would be fine") {
		t.Errorf("expected output, got: %s", result)
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

func TestBash_OutputTruncation(t *testing.T) {
	dir := tmpDir(t)
	tool := &Bash{WorkDir: dir}
	// Generate more lines than maxOutputLines.
	result, err := tool.Execute(context.Background(), map[string]any{
		"command": "seq 1 500",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "[output truncated") {
		t.Errorf("expected truncation notice, got last 200 chars: %s", result[len(result)-200:])
	}
	if !strings.Contains(result, "500") {
		t.Errorf("expected last line (500) in truncated output, got last 200 chars: %s", result[len(result)-200:])
	}
}

// --- Path traversal tests ---

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
