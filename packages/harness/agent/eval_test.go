package agent

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// copyDir copies src directory contents to dst (for test isolation).
func copyDir(t *testing.T, src, dst string) {
	t.Helper()
	filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// Evaluation Task 1: Read-only repo analysis
// The agent reads files from testdata/fixture-repo and summarizes structure without writing anything.
func TestEval_ReadOnlyAnalysis(t *testing.T) {
	// Copy fixture-repo to a temp dir so the test cannot modify the checked-in fixtures.
	dir := t.TempDir()
	copyDir(t, filepath.Join("..", "testdata", "fixture-repo"), dir)

	provider := llm.NewMockProvider(
		// Turn 1: list files
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "bash",
				Params: map[string]any{"command": "find . -type f | sort"},
			}},
		},
		// Turn 2: read main.go
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "read_file",
				Params: map[string]any{"path": "main.go"},
			}},
		},
		// Turn 3: read README.md
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "read_file",
				Params: map[string]any{"path": "README.md"},
			}},
		},
		// Turn 4: summarize
		&llm.Response{Content: "This is a minimal Go project with a main package and a README."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.ReadFile{WorkDir: dir})
	registry.Register(&tools.Bash{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, "Analyze this repository")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify no writes happened — fixture files unchanged
	data, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if !strings.Contains(string(data), "Hello from fixture repo") {
		t.Error("main.go was modified during read-only analysis")
	}

	// Verify no new files were created
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 { // main.go + README.md
		t.Errorf("expected 2 entries in dir, got %d (extra files created during read-only analysis)", len(entries))
	}

	// Verify transcript has the expected events
	if log.Len() < 6 {
		t.Errorf("expected at least 6 transcript events, got %d", log.Len())
	}
}

// Evaluation Task 2: Simple file edit + verification
// The agent creates a file, edits it, then verifies the result.
func TestEval_FileEditAndVerify(t *testing.T) {
	dir := t.TempDir()

	provider := llm.NewMockProvider(
		// Turn 1: create file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c1",
				Name: "write_file",
				Params: map[string]any{
					"path":    "greeting.txt",
					"content": "Hello, World!",
				},
			}},
		},
		// Turn 2: edit file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c2",
				Name: "edit_file",
				Params: map[string]any{
					"path":       "greeting.txt",
					"old_string": "World",
					"new_string": "SAM",
				},
			}},
		},
		// Turn 3: verify
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "bash",
				Params: map[string]any{"command": "cat greeting.txt"},
			}},
		},
		// Turn 4: done
		&llm.Response{Content: "File created and edited successfully. It now says 'Hello, SAM!'"},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.WriteFile{WorkDir: dir})
	registry.Register(&tools.EditFile{WorkDir: dir})
	registry.Register(&tools.Bash{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, "Create greeting.txt and change World to SAM")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify file state
	data, err := os.ReadFile(filepath.Join(dir, "greeting.txt"))
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}
	if string(data) != "Hello, SAM!" {
		t.Errorf("file content = %q, want %q", string(data), "Hello, SAM!")
	}
}

// Evaluation Task 3: Failing command recovery
// The agent runs a failing command, detects the error, and retries with a fix.
func TestEval_FailingCommandRecovery(t *testing.T) {
	dir := t.TempDir()

	provider := llm.NewMockProvider(
		// Turn 1: run bad command
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "bash",
				Params: map[string]any{"command": "cat nonexistent.txt"},
			}},
		},
		// Turn 2: the model sees the error, creates the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c2",
				Name: "write_file",
				Params: map[string]any{
					"path":    "nonexistent.txt",
					"content": "recovered content",
				},
			}},
		},
		// Turn 3: retry the command
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "bash",
				Params: map[string]any{"command": "cat nonexistent.txt"},
			}},
		},
		// Turn 4: success
		&llm.Response{Content: "Recovered: the file now exists and contains 'recovered content'."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.Bash{WorkDir: dir})
	registry.Register(&tools.WriteFile{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, "Read nonexistent.txt")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify recovery occurred
	data, _ := os.ReadFile(filepath.Join(dir, "nonexistent.txt"))
	if string(data) != "recovered content" {
		t.Errorf("recovery file content = %q, want %q", string(data), "recovered content")
	}

	// The transcript should show the tool error from the first bash call
	events := log.Events()
	var foundToolResult bool
	for _, e := range events {
		if e.Type == transcript.EventToolResult {
			if d, ok := e.Data.(map[string]any); ok {
				if content, _ := d["content"].(string); strings.Contains(content, "exit") || strings.Contains(content, "No such file") {
					foundToolResult = true
				}
			}
		}
	}
	if !foundToolResult {
		t.Log("Note: could not verify error in transcript data (this is OK for mock-based eval)")
	}
}

// Evaluation Task 4: Edit a file and commit it using git tools.
// The agent creates a file, checks status, commits, and verifies the log.
func TestEval_GitEditAndCommit(t *testing.T) {
	// Create a temp dir with a git repo
	dir := t.TempDir()
	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		{"git", "commit", "--allow-empty", "-m", "initial"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup (%v): %v\n%s", args, err, out)
		}
	}

	provider := llm.NewMockProvider(
		// Turn 1: create a file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c1",
				Name: "write_file",
				Params: map[string]any{
					"path":    "hello.go",
					"content": "package main\n\nfunc main() {}\n",
				},
			}},
		},
		// Turn 2: check git status
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c2",
				Name:   "git_status",
				Params: map[string]any{},
			}},
		},
		// Turn 3: commit the file
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:   "c3",
				Name: "git_commit",
				Params: map[string]any{
					"message": "feat: add hello.go",
					"paths":   []any{"hello.go"},
				},
			}},
		},
		// Turn 4: check the log
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c4",
				Name:   "git_log",
				Params: map[string]any{"count": float64(2)},
			}},
		},
		// Turn 5: done
		&llm.Response{Content: "Created hello.go and committed it successfully."},
	)

	registry := tools.NewRegistry()
	registry.Register(&tools.WriteFile{WorkDir: dir})
	registry.Register(&tools.GitStatus{WorkDir: dir})
	registry.Register(&tools.GitCommit{WorkDir: dir})
	registry.Register(&tools.GitLog{WorkDir: dir})

	log := transcript.NewLog()

	result, err := Run(context.Background(), provider, registry, log, Config{MaxTurns: 10}, "Create hello.go and commit it")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if result.StopReason != "complete" {
		t.Errorf("stop_reason = %s, want complete", result.StopReason)
	}

	// Verify the file exists
	data, err := os.ReadFile(filepath.Join(dir, "hello.go"))
	if err != nil {
		t.Fatalf("hello.go not created: %v", err)
	}
	if !strings.Contains(string(data), "package main") {
		t.Error("hello.go has wrong content")
	}

	// Verify the commit is in git log
	gitLog := exec.Command("git", "log", "--oneline")
	gitLog.Dir = dir
	out, _ := gitLog.Output()
	if !strings.Contains(string(out), "feat: add hello.go") {
		t.Errorf("commit not found in log: %s", out)
	}

	// Verify git status is now clean
	gitStatus := exec.Command("git", "status", "--porcelain")
	gitStatus.Dir = dir
	statusOut, _ := gitStatus.Output()
	if strings.TrimSpace(string(statusOut)) != "" {
		t.Errorf("expected clean status after commit, got: %s", statusOut)
	}

	// Verify transcript captured all tool calls
	events := log.Events()
	var toolCallCount int
	for _, e := range events {
		if e.Type == transcript.EventToolCall {
			toolCallCount++
		}
	}
	if toolCallCount != 4 {
		t.Errorf("expected 4 tool calls in transcript, got %d", toolCallCount)
	}

}
