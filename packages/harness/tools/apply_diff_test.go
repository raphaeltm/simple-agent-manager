package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyDiff_SingleHunk(t *testing.T) {
	dir := t.TempDir()
	original := "package main\n\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n"
	os.WriteFile(filepath.Join(dir, "main.go"), []byte(original), 0o644)

	diff := `--- a/main.go
+++ b/main.go
@@ -3,3 +3,3 @@
 func main() {
-	fmt.Println("hello")
+	fmt.Println("goodbye")
 }`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Applied 1 hunks to 1 files") {
		t.Errorf("unexpected result: %s", result)
	}
	if !strings.Contains(result, "+1/-1") {
		t.Errorf("expected +1/-1 in result: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if !strings.Contains(string(data), `fmt.Println("goodbye")`) {
		t.Errorf("file not patched correctly: %s", data)
	}
	if strings.Contains(string(data), `fmt.Println("hello")`) {
		t.Error("old line still present")
	}
}

func TestApplyDiff_MultiHunkSingleFile(t *testing.T) {
	dir := t.TempDir()
	original := "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n"
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte(original), 0o644)

	diff := `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
-line1
+LINE1
 line2
 line3
@@ -8,3 +8,3 @@
 line8
-line9
+LINE9
 line10`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Applied 2 hunks to 1 files") {
		t.Errorf("unexpected result: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "file.txt"))
	content := string(data)
	if !strings.Contains(content, "LINE1") {
		t.Error("first hunk not applied")
	}
	if !strings.Contains(content, "LINE9") {
		t.Error("second hunk not applied")
	}
	if strings.Contains(content, "\nline1\n") {
		t.Error("old line1 still present")
	}
}

func TestApplyDiff_MultiFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa\nbbb\nccc\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("xxx\nyyy\nzzz\n"), 0o644)

	diff := `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 aaa
-bbb
+BBB
 ccc
--- a/b.txt
+++ b/b.txt
@@ -1,3 +1,3 @@
 xxx
-yyy
+YYY
 zzz`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "2 files") {
		t.Errorf("unexpected result: %s", result)
	}

	dataA, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	if !strings.Contains(string(dataA), "BBB") {
		t.Error("a.txt not patched")
	}
	dataB, _ := os.ReadFile(filepath.Join(dir, "b.txt"))
	if !strings.Contains(string(dataB), "YYY") {
		t.Error("b.txt not patched")
	}
}

func TestApplyDiff_FuzzyMatch(t *testing.T) {
	dir := t.TempDir()
	// File has content shifted by 2 lines from what the diff expects.
	original := "extra1\nextra2\nfoo\nbar\nbaz\n"
	os.WriteFile(filepath.Join(dir, "fuzzy.txt"), []byte(original), 0o644)

	// Diff says the hunk starts at line 1, but the actual content starts at line 3.
	diff := `--- a/fuzzy.txt
+++ b/fuzzy.txt
@@ -1,3 +1,3 @@
 foo
-bar
+BAR
 baz`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "Applied 1 hunks") {
		t.Errorf("unexpected result: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "fuzzy.txt"))
	content := string(data)
	if !strings.Contains(content, "BAR") {
		t.Error("fuzzy match did not apply")
	}
	if !strings.Contains(content, "extra1") {
		t.Error("prefix lines lost")
	}
}

func TestApplyDiff_NewFile(t *testing.T) {
	dir := t.TempDir()

	diff := `--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,3 @@
+hello
+world
+!`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "+3/-0") {
		t.Errorf("unexpected result: %s", result)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "newfile.txt"))
	if string(data) != "hello\nworld\n!\n" {
		t.Errorf("new file content = %q", data)
	}
}

func TestApplyDiff_DeleteFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "gone.txt"), []byte("bye\n"), 0o644)

	diff := `--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye`

	tool := &ApplyDiff{WorkDir: dir}
	result, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "deleted") {
		t.Errorf("unexpected result: %s", result)
	}

	if _, err := os.Stat(filepath.Join(dir, "gone.txt")); !os.IsNotExist(err) {
		t.Error("file was not deleted")
	}
}

func TestApplyDiff_ContextMismatch(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "mismatch.txt"), []byte("aaa\nbbb\nccc\n"), 0o644)

	diff := `--- a/mismatch.txt
+++ b/mismatch.txt
@@ -1,3 +1,3 @@
 xxx
-yyy
+YYY
 zzz`

	tool := &ApplyDiff{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err == nil {
		t.Fatal("expected error for context mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "context mismatch") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestApplyDiff_PathTraversal(t *testing.T) {
	dir := t.TempDir()

	diff := `--- a/../../../etc/passwd
+++ b/../../../etc/passwd
@@ -1 +1 @@
-root
+hacked`

	tool := &ApplyDiff{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err == nil {
		t.Fatal("expected error for path traversal, got nil")
	}
	if !strings.Contains(err.Error(), "escapes working directory") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestApplyDiff_NewFileInSubdir(t *testing.T) {
	dir := t.TempDir()

	diff := `--- /dev/null
+++ b/sub/dir/new.txt
@@ -0,0 +1,1 @@
+content`

	tool := &ApplyDiff{WorkDir: dir}
	_, err := tool.Execute(context.Background(), map[string]any{"diff": diff})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "sub", "dir", "new.txt"))
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}
	if string(data) != "content\n" {
		t.Errorf("content = %q", data)
	}
}

func TestApplyDiff_MissingParam(t *testing.T) {
	tool := &ApplyDiff{WorkDir: t.TempDir()}
	_, err := tool.Execute(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing param")
	}
}

func TestApplyDiff_EmptyDiff(t *testing.T) {
	tool := &ApplyDiff{WorkDir: t.TempDir()}
	_, err := tool.Execute(context.Background(), map[string]any{"diff": ""})
	if err == nil {
		t.Fatal("expected error for empty diff")
	}
}
