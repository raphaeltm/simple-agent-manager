// Package prompts provides system prompt loading from files and embedded presets.
package prompts

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed workspace.md orchestrator.md
var embedded embed.FS

// ValidPresets lists the recognized preset names.
var ValidPresets = []string{"workspace", "orchestrator"}

// LoadPreset loads a built-in prompt preset by name.
func LoadPreset(name string) (string, error) {
	filename := name + ".md"
	data, err := embedded.ReadFile(filename)
	if err != nil {
		return "", fmt.Errorf("unknown preset %q (valid: %s)", name, strings.Join(ValidPresets, ", "))
	}
	return string(data), nil
}

// LoadFile loads a prompt from an arbitrary file path.
func LoadFile(path string) (string, error) {
	absPath := path
	if !filepath.IsAbs(path) {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolving prompt file path: %w", err)
		}
		absPath = filepath.Join(wd, path)
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("reading prompt file %q: %w", absPath, err)
	}
	return string(data), nil
}

// Resolve determines the system prompt from CLI flags.
// Precedence: promptFile > promptPreset > systemPrompt (inline).
func Resolve(promptFile, promptPreset, systemPrompt string) (string, error) {
	if promptFile != "" {
		return LoadFile(promptFile)
	}
	if promptPreset != "" {
		return LoadPreset(promptPreset)
	}
	return systemPrompt, nil
}
