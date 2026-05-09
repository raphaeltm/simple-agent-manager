package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// makeRegistry creates a tool registry with all file/search/shell tools rooted at dir.
func makeRegistry(dir string) *tools.Registry {
	r := tools.NewRegistry()
	r.Register(&tools.ReadFile{WorkDir: dir})
	r.Register(&tools.WriteFile{WorkDir: dir})
	r.Register(&tools.EditFile{WorkDir: dir})
	r.Register(&tools.Bash{WorkDir: dir})
	r.Register(&tools.Grep{WorkDir: dir})
	r.Register(&tools.Glob{WorkDir: dir})
	return r
}

// Eval Task 4: Multi-file edit
// The agent renames ComputeSum -> Add across 3 files (definition, caller, test).
func TestEval_MultiFileEdit(t *testing.T) {
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "multi-file-project"), dir)

	provider := llm.NewMockProvider(
		// Turn 1: grep for ComputeSum to find all occurrences
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "grep",
				Params: map[string]any{"pattern": "ComputeSum", "include": "*.go"},
			}},
		},
		// Turn 2: read calc.go to see the definition
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "read_file",
				Params: map[string]any{"path": "calc.go"},
			}},
		},
		// Turn 3: rename in calc.go (definition + comment)
		&llm.Response{
			ToolCalls: []llm.ToolCall{
				{
					ID:   "c3a",
					Name: "edit_file",
					Params: map[string]any{
						"path":       "calc.go",
						"old_string": "// ComputeSum adds two integers and returns the result.\nfunc ComputeSum(a, b int) int {",
						"new_string": "// Add adds two integers and returns the result.\nfunc Add(a, b int) int {",
					},
				},
			},
		},
		// Turn 4: rename in handler.go
		&llm.Response{
			ToolCalls: []llm.ToolCall{
				{
					ID:   "c4a",
					Name: "edit_file",
					Params: map[string]any{
						"path":       "handler.go",
						"old_string": "// FormatSum uses ComputeSum to format an addition result.\nfunc FormatSum(a, b int) string {\n\tresult := ComputeSum(a, b)",
						"new_string": "// FormatSum uses Add to format an addition result.\nfunc FormatSum(a, b int) string {\n\tresult := Add(a, b)",
					},
				},
			},
		},
		// Turn 5: rename in calc_test.go (function name, call, and error string)
		&llm.Response{
			ToolCalls: []llm.ToolCall{
				{
					ID:   "c5",
					Name: "edit_file",
					Params: map[string]any{
						"path":       "calc_test.go",
						"old_string": "func TestComputeSum(t *testing.T) {\n\tgot := ComputeSum(3, 4)\n\tif got != 7 {\n\t\tt.Errorf(\"ComputeSum(3, 4) = %d, want 7\", got)\n\t}\n}",
						"new_string": "func TestAdd(t *testing.T) {\n\tgot := Add(3, 4)\n\tif got != 7 {\n\t\tt.Errorf(\"Add(3, 4) = %d, want 7\", got)\n\t}\n}",
					},
				},
			},
		},
		// Turn 6: verify with grep
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c6",
				Name:   "grep",
				Params: map[string]any{"pattern": "ComputeSum", "include": "*.go"},
			}},
		},
		// Turn 7: done
		&llm.Response{Content: "Renamed ComputeSum to Add across all 3 files. No remaining references to old name."},
	)

	registry := makeRegistry(dir)
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 15}, "Rename ComputeSum to Add across all files")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: grep for old name finds 0 occurrences
	for _, fname := range []string{"calc.go", "handler.go", "calc_test.go"} {
		data, err := os.ReadFile(filepath.Join(dir, fname))
		if err != nil {
			t.Fatalf("reading %s: %v", fname, err)
		}
		if strings.Contains(string(data), "ComputeSum") {
			t.Errorf("%s still contains 'ComputeSum'", fname)
		}
	}

	// Assert: grep for new name finds occurrences in all 3 files
	filesWithAdd := 0
	for _, fname := range []string{"calc.go", "handler.go", "calc_test.go"} {
		data, _ := os.ReadFile(filepath.Join(dir, fname))
		if strings.Contains(string(data), "Add(") {
			filesWithAdd++
		}
	}
	if filesWithAdd != 3 {
		t.Errorf("found 'Add(' in %d files, want 3", filesWithAdd)
	}

	// Assert: ComputeProduct was NOT renamed (only ComputeSum should change)
	calcData, _ := os.ReadFile(filepath.Join(dir, "calc.go"))
	if !strings.Contains(string(calcData), "ComputeProduct") {
		t.Error("ComputeProduct was incorrectly renamed")
	}
}

// Eval Task 5: Bug fix via grep + test output
// Agent is given failing test output, must find the bug with grep, read the code, and fix it.
func TestEval_BugFixViaGrep(t *testing.T) {
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "buggy-project"), dir)

	failingOutput := `--- FAIL: TestAbs (0.00s)
    mathutil_test.go:15: Abs(-3) = -3, want 3
    mathutil_test.go:15: Abs(-100) = -100, want 100
FAIL`

	provider := llm.NewMockProvider(
		// Turn 1: grep for the Abs function definition
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "grep",
				Params: map[string]any{"pattern": "func Abs", "include": "*.go"},
			}},
		},
		// Turn 2: read the file containing Abs
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "read_file",
				Params: map[string]any{"path": "mathutil.go"},
			}},
		},
		// Turn 3: fix the bug — change "return n" to "return -n" inside the negative branch
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c3",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "mathutil.go",
					"old_string": "\t\treturn n // Bug: should be -n",
					"new_string": "\t\treturn -n",
				},
			}},
		},
		// Turn 4: verify the fix by reading the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c4",
				Name:   "read_file",
				Params: map[string]any{"path": "mathutil.go"},
			}},
		},
		// Turn 5: done
		&llm.Response{Content: "Fixed Abs() — the negative branch was returning n instead of -n."},
	)

	registry := makeRegistry(dir)
	log := transcript.NewLog()

	prompt := "The following test is failing. Find the bug and fix it:\n\n" + failingOutput
	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, prompt)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: the bug is fixed
	data, _ := os.ReadFile(filepath.Join(dir, "mathutil.go"))
	content := string(data)
	if strings.Contains(content, "return n // Bug") {
		t.Error("bug was not fixed — old buggy line still present")
	}
	if !strings.Contains(content, "return -n") {
		t.Error("fix not applied — expected 'return -n' in Abs function")
	}

	// Assert: Max and Clamp functions are unchanged
	if !strings.Contains(content, "func Max(a, b int) int") {
		t.Error("Max function was incorrectly modified")
	}
	if !strings.Contains(content, "func Clamp(v, lo, hi int) int") {
		t.Error("Clamp function was incorrectly modified")
	}
}

// Eval Task 6: Refactor with git commit
// Agent exports unexported functions and creates a git commit.
func TestEval_RefactorWithGitCommit(t *testing.T) {
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "refactor-project"), dir)

	// Initialize a git repo in the temp dir so git commands work.
	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		{"git", "add", "."},
		{"git", "commit", "-m", "initial"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git setup %v: %s — %v", args, out, err)
		}
	}

	provider := llm.NewMockProvider(
		// Turn 1: read the file to understand current state
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "read_file",
				Params: map[string]any{"path": "stringutil.go"},
			}},
		},
		// Turn 2: rename reverse to Reverse
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c2",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "stringutil.go",
					"old_string": "// reverse returns s reversed character by character.\nfunc reverse(s string) string {",
					"new_string": "// Reverse returns s reversed character by character.\nfunc Reverse(s string) string {",
				},
			}},
		},
		// Turn 3: update the call site in isPalindrome
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c3",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "stringutil.go",
					"old_string": "return lower == reverse(lower)",
					"new_string": "return lower == Reverse(lower)",
				},
			}},
		},
		// Turn 4: update the test
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c4",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "stringutil_test.go",
					"old_string": "func TestReverse(t *testing.T) {\n\ttests := []struct {\n\t\tinput, want string\n\t}{\n\t\t{\"hello\", \"olleh\"},\n\t\t{\"\", \"\"},\n\t\t{\"a\", \"a\"},\n\t}\n\tfor _, tt := range tests {\n\t\tgot := reverse(tt.input)",
					"new_string": "func TestReverse(t *testing.T) {\n\ttests := []struct {\n\t\tinput, want string\n\t}{\n\t\t{\"hello\", \"olleh\"},\n\t\t{\"\", \"\"},\n\t\t{\"a\", \"a\"},\n\t}\n\tfor _, tt := range tests {\n\t\tgot := Reverse(tt.input)",
				},
			}},
		},
		// Turn 5: stage and commit
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c5",
				Name: "bash",
				Params: map[string]any{
					"command": "git add -A && git commit -m 'refactor: export Reverse function for external use'",
				},
			}},
		},
		// Turn 6: verify with git log
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c6",
				Name:   "bash",
				Params: map[string]any{"command": "git log --oneline -2"},
			}},
		},
		// Turn 7: done
		&llm.Response{Content: "Exported reverse as Reverse and committed the refactor."},
	)

	registry := makeRegistry(dir)
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 15}, "Export the reverse function as Reverse and commit the change")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: git log shows the commit
	gitLog := exec.Command("git", "log", "--oneline", "-5")
	gitLog.Dir = dir
	logOut, err := gitLog.Output()
	if err != nil {
		t.Fatalf("git log: %v", err)
	}
	if !strings.Contains(string(logOut), "refactor") {
		t.Errorf("git log does not contain refactor commit: %s", logOut)
	}

	// Assert: working tree is clean (all changes committed)
	gitStatus := exec.Command("git", "status", "--porcelain")
	gitStatus.Dir = dir
	statusOut, _ := gitStatus.Output()
	if len(strings.TrimSpace(string(statusOut))) > 0 {
		t.Errorf("working tree is not clean after commit: %s", statusOut)
	}

	// Assert: the refactor was applied correctly
	data, _ := os.ReadFile(filepath.Join(dir, "stringutil.go"))
	content := string(data)
	if strings.Contains(content, "func reverse(") {
		t.Error("reverse is still unexported")
	}
	if !strings.Contains(content, "func Reverse(") {
		t.Error("Reverse export not found")
	}
}

// Eval Task 7: Large codebase navigation
// Agent uses glob/grep to answer a question about a 20+ file codebase
// without reading every file.
func TestEval_LargeCodebaseNavigation(t *testing.T) {
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "large-project"), dir)

	provider := llm.NewMockProvider(
		// Turn 1: glob to list all files
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "glob",
				Params: map[string]any{"pattern": "**/*.go"},
			}},
		},
		// Turn 2: grep for "password" to find password-related code
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "grep",
				Params: map[string]any{"pattern": "[Pp]assword", "include": "*.go"},
			}},
		},
		// Turn 3: read the specific file (auth/password.go) to confirm
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "read_file",
				Params: map[string]any{"path": "auth/password.go"},
			}},
		},
		// Turn 4: answer the question
		&llm.Response{Content: "Password hashing is handled in auth/password.go. It contains HashPassword() and CheckPassword() functions."},
	)

	registry := makeRegistry(dir)
	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, "Which file handles password hashing in this project?")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: the agent identified the correct file
	if !strings.Contains(result.FinalMessage, "auth/password.go") {
		t.Errorf("agent did not identify correct file. Got: %s", result.FinalMessage)
	}

	// Assert: the agent did NOT read every file (efficiency check)
	// Count read_file calls in the transcript
	readCount := 0
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolCall {
			if d, ok := e.Data.(map[string]any); ok {
				if name, _ := d["name"].(string); name == "read_file" {
					readCount++
				}
			}
		}
	}
	totalFiles := 21
	if readCount > totalFiles/2 {
		t.Errorf("agent read %d files out of %d — should navigate efficiently using grep/glob", readCount, totalFiles)
	}
}

// Eval Task 8: Failing test diagnosis
// Agent is given test output and the test file, must identify root cause and propose a fix.
func TestEval_FailingTestDiagnosis(t *testing.T) {
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "buggy-project"), dir)

	failingOutput := `--- FAIL: TestAbs (0.00s)
    mathutil_test.go:15: Abs(-3) = -3, want 3
    mathutil_test.go:15: Abs(-100) = -100, want 100
FAIL
exit status 1
FAIL	example/mathutil	0.001s`

	provider := llm.NewMockProvider(
		// Turn 1: read the test file to understand what's expected
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "read_file",
				Params: map[string]any{"path": "mathutil_test.go"},
			}},
		},
		// Turn 2: read the implementation
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "read_file",
				Params: map[string]any{"path": "mathutil.go"},
			}},
		},
		// Turn 3: apply the fix
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c3",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "mathutil.go",
					"old_string": "\t\treturn n // Bug: should be -n",
					"new_string": "\t\treturn -n",
				},
			}},
		},
		// Turn 4: explain the diagnosis
		&llm.Response{Content: "Root cause: In the Abs function (mathutil.go:5), the negative branch returns `n` instead of `-n`. When n is negative, returning n unchanged means Abs(-3) returns -3 instead of 3. Fix: change `return n` to `return -n` in the `if n < 0` branch."},
	)

	registry := makeRegistry(dir)
	log := transcript.NewLog()

	prompt := "Diagnose the following test failure and fix it:\n\n" + failingOutput
	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, prompt)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Assert: diagnosis mentions the root cause
	msg := strings.ToLower(result.FinalMessage)
	if !strings.Contains(msg, "return") || !strings.Contains(msg, "n") {
		t.Errorf("diagnosis does not explain root cause: %s", result.FinalMessage)
	}

	// Assert: the fix was applied
	data, _ := os.ReadFile(filepath.Join(dir, "mathutil.go"))
	content := string(data)
	if !strings.Contains(content, "return -n") {
		t.Error("fix was not applied — expected 'return -n'")
	}
	if strings.Contains(content, "return n // Bug") {
		t.Error("buggy line still present")
	}

	// Assert: the agent read both files (test + impl) for proper diagnosis
	readFiles := map[string]bool{}
	for _, e := range log.Events() {
		if e.Type == transcript.EventToolCall {
			if d, ok := e.Data.(map[string]any); ok {
				if name, _ := d["name"].(string); name == "read_file" {
					if params, ok := d["params"].(map[string]any); ok {
						if path, _ := params["path"].(string); path != "" {
							readFiles[path] = true
						}
					}
				}
			}
		}
	}
	if !readFiles["mathutil_test.go"] {
		t.Error("agent did not read the test file")
	}
	if !readFiles["mathutil.go"] {
		t.Error("agent did not read the implementation file")
	}
}
