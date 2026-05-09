package repomap

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGenerate_GoAST(t *testing.T) {
	dir := filepath.Join("testdata", "sample")
	out, err := Generate(dir, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	// Go file should be parsed with AST — check for known declarations.
	assertContains(t, out, "func Run(ctx context.Context, opts Options)")
	assertContains(t, out, "type Options struct")
	assertContains(t, out, "type Result struct")
	assertContains(t, out, "type Runner interface")
	assertContains(t, out, "const MaxRetries")
	// Method with receiver
	assertContains(t, out, "func (*Result) String()")
}

func TestGenerate_TypeScriptRegex(t *testing.T) {
	dir := filepath.Join("testdata", "sample")
	out, err := Generate(dir, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	assertContains(t, out, "export interface Provider")
	assertContains(t, out, "export type Config")
	assertContains(t, out, "export class AgentLoop")
	assertContains(t, out, "export const DEFAULT_MODEL")
	assertContains(t, out, "export function createAgent")
	assertContains(t, out, "export async function processTask")
	// Non-exported declarations should also appear.
	assertContains(t, out, "interface InternalState")
	assertContains(t, out, "type RequestBody")
}

func TestGenerate_PythonRegex(t *testing.T) {
	dir := filepath.Join("testdata", "sample")
	out, err := Generate(dir, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	assertContains(t, out, "class TokenBudget")
	assertContains(t, out, "def count_tokens")
	assertContains(t, out, "async def fetch_data")
	assertContains(t, out, "class Config")
}

func TestGenerate_SkipDirs(t *testing.T) {
	tmp := t.TempDir()
	// Create files in directories that should be skipped.
	for _, skip := range []string{".git", "node_modules", "vendor", "dist"} {
		dir := filepath.Join(tmp, skip)
		os.MkdirAll(dir, 0o755)
		os.WriteFile(filepath.Join(dir, "file.go"), []byte("package skip\nfunc Skipped() {}\n"), 0o644)
	}
	// Create a file that should be included.
	os.WriteFile(filepath.Join(tmp, "main.go"), []byte("package main\nfunc Included() {}\n"), 0o644)

	out, err := Generate(tmp, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	assertContains(t, out, "func Included()")
	assertNotContains(t, out, "func Skipped()")
}

func TestGenerate_TokenBudget(t *testing.T) {
	tmp := t.TempDir()
	// Create several files with declarations.
	for i := 0; i < 20; i++ {
		content := fmt.Sprintf("package gen\n\nfunc Func%d() {}\nfunc Func%d_B() {}\n", i, i)
		os.WriteFile(filepath.Join(tmp, fmt.Sprintf("file%02d.go", i)), []byte(content), 0o644)
	}

	// Use a tiny budget — should truncate.
	out, err := Generate(tmp, &Options{TokenBudget: 200})
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if len(out) > 250 {
		t.Errorf("output length %d exceeds budget+slack; output:\n%s", len(out), out)
	}
	// Should still have at least one file.
	if !strings.Contains(out, "func Func") {
		t.Error("expected at least one func declaration in truncated output")
	}
}

func TestGenerate_LargeDirectory(t *testing.T) {
	tmp := t.TempDir()
	// Create 500+ files.
	for i := 0; i < 550; i++ {
		subdir := filepath.Join(tmp, fmt.Sprintf("pkg%03d", i/10))
		os.MkdirAll(subdir, 0o755)
		content := fmt.Sprintf("package pkg%03d\n\nfunc Handler%d() error { return nil }\ntype Model%d struct{}\n", i/10, i, i)
		os.WriteFile(filepath.Join(subdir, fmt.Sprintf("f%d.go", i)), []byte(content), 0o644)
	}

	start := time.Now()
	_, err := Generate(tmp, &Options{TokenBudget: 8000})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("large directory took %v (must be <2s)", elapsed)
	}
}

func TestGenerate_EmptyDir(t *testing.T) {
	tmp := t.TempDir()
	out, err := Generate(tmp, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if out != "" {
		t.Errorf("expected empty output for empty dir, got: %q", out)
	}
}

func TestGenerate_LineNumbers(t *testing.T) {
	dir := filepath.Join("testdata", "sample")
	out, err := Generate(dir, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	// Line numbers should appear in the format " :N"
	if !strings.Contains(out, ":") {
		t.Error("output should contain line numbers")
	}
	// Options struct is on line 6 in main.go fixture.
	assertContains(t, out, "type Options struct :6")
}

func TestGenerate_SortsByDeclCount(t *testing.T) {
	tmp := t.TempDir()
	// File with many declarations.
	var big strings.Builder
	big.WriteString("package big\n\n")
	for i := 0; i < 10; i++ {
		fmt.Fprintf(&big, "func BigFunc%d() {}\n", i)
	}
	os.WriteFile(filepath.Join(tmp, "big.go"), []byte(big.String()), 0o644)

	// File with one declaration.
	os.WriteFile(filepath.Join(tmp, "small.go"), []byte("package small\n\nfunc SmallFunc() {}\n"), 0o644)

	out, err := Generate(tmp, nil)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	bigIdx := strings.Index(out, "big.go:")
	smallIdx := strings.Index(out, "small.go:")
	if bigIdx < 0 || smallIdx < 0 {
		t.Fatalf("expected both files in output:\n%s", out)
	}
	if bigIdx > smallIdx {
		t.Error("big.go (more declarations) should appear before small.go")
	}
}

func assertContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected output to contain %q\nfull output:\n%s", needle, haystack)
	}
}

func assertNotContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("expected output NOT to contain %q\nfull output:\n%s", needle, haystack)
	}
}
