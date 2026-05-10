package prompts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadPreset_Workspace(t *testing.T) {
	content, err := LoadPreset("workspace")
	if err != nil {
		t.Fatalf("LoadPreset(workspace): %v", err)
	}
	if !strings.Contains(content, "Workspace Coding Agent") {
		t.Error("workspace preset missing expected header")
	}
}

func TestLoadPreset_Orchestrator(t *testing.T) {
	content, err := LoadPreset("orchestrator")
	if err != nil {
		t.Fatalf("LoadPreset(orchestrator): %v", err)
	}
	if !strings.Contains(content, "Orchestrator Agent") {
		t.Error("orchestrator preset missing expected header")
	}
}

func TestLoadPreset_Invalid(t *testing.T) {
	_, err := LoadPreset("nonexistent")
	if err == nil {
		t.Error("expected error for invalid preset")
	}
	if !strings.Contains(err.Error(), "unknown preset") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestLoadFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "custom.md")
	if err := os.WriteFile(path, []byte("# Custom Prompt\nDo things."), 0o644); err != nil {
		t.Fatal(err)
	}

	content, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if !strings.Contains(content, "Custom Prompt") {
		t.Error("loaded content missing expected text")
	}
}

func TestLoadFile_NotFound(t *testing.T) {
	_, err := LoadFile("/nonexistent/path/prompt.md")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestResolve_Precedence(t *testing.T) {
	// promptFile takes precedence over preset and inline
	dir := t.TempDir()
	path := filepath.Join(dir, "file.md")
	os.WriteFile(path, []byte("from file"), 0o644)

	got, err := Resolve(path, "workspace", "inline prompt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "from file" {
		t.Errorf("expected 'from file', got %q", got)
	}

	// preset takes precedence over inline
	got, err = Resolve("", "workspace", "inline prompt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Workspace Coding Agent") {
		t.Error("expected workspace preset content")
	}

	// inline is fallback
	got, err = Resolve("", "", "inline prompt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "inline prompt" {
		t.Errorf("expected 'inline prompt', got %q", got)
	}
}
