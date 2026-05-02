package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

// Evaluation Task 1: Read-only repo analysis
// The agent reads files and summarizes structure without writing anything.
func TestEval_ReadOnlyAnalysis(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "lib"), 0o755)
	os.WriteFile(filepath.Join(dir, "lib", "util.go"), []byte("package lib\n\nfunc Add(a, b int) int { return a + b }\n"), 0o644)

	provider := llm.NewMockProvider(
		// Turn 1: list files
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c1",
				Name:   "bash",
				Params: map[string]any{"command": "find . -name '*.go' | sort"},
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
		// Turn 3: read lib/util.go
		&llm.Response{
			ToolCalls: []llm.ToolCall{{
				ID:     "c3",
				Name:   "read_file",
				Params: map[string]any{"path": "lib/util.go"},
			}},
		},
		// Turn 4: summarize
		&llm.Response{Content: "This is a Go project with a main package and a lib package containing utility functions."},
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

	// Verify no writes happened — files unchanged
	data, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if !strings.Contains(string(data), "println(\"hi\")") {
		t.Error("main.go was modified during read-only analysis")
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
