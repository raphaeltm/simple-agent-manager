package acp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var runtimeEnvKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type RuntimeEnvVar struct {
	Key      string
	Value    string
	IsSecret bool
}

type RuntimeFile struct {
	Path     string
	Content  string
	IsSecret bool
}

type RuntimeAssets struct {
	EnvVars []RuntimeEnvVar
	Files   []RuntimeFile
}

type RuntimeAssetsProvider func(context.Context) (RuntimeAssets, error)

func appendRuntimeEnvVars(envVars []string, secretKeys map[string]bool, runtimeEnvVars []RuntimeEnvVar) ([]string, error) {
	for _, envVar := range runtimeEnvVars {
		key := strings.TrimSpace(envVar.Key)
		if !runtimeEnvKeyPattern.MatchString(key) {
			return envVars, fmt.Errorf("invalid runtime env var key %q", envVar.Key)
		}
		envVars = removeEnvVar(envVars, key)
		envVars = append(envVars, key+"="+envVar.Value)
		if envVar.IsSecret {
			secretKeys[key] = true
		}
	}
	return envVars, nil
}

func applyStandaloneRuntimeFiles(workDir string, files []RuntimeFile) error {
	for _, file := range files {
		targetPath, err := resolveStandaloneRuntimeFilePath(workDir, file.Path)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if file.IsSecret {
			mode = 0o600
		}
		if err := writeRuntimeFile(targetPath, []byte(file.Content), mode); err != nil {
			return fmt.Errorf("failed to write runtime file %s: %w", sanitizedRuntimePath(file.Path), err)
		}
	}
	return nil
}

func resolveStandaloneRuntimeFilePath(workDir, rawPath string) (string, error) {
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		return "", fmt.Errorf("runtime file path is required")
	}

	slashed := strings.ReplaceAll(trimmed, "\\", "/")
	for _, segment := range strings.Split(slashed, "/") {
		if segment == ".." {
			return "", fmt.Errorf("runtime file path must not contain dot-dot segments")
		}
	}

	normalized := filepath.Clean(trimmed)
	if normalized == "." {
		return "", fmt.Errorf("runtime file path must not be current directory")
	}
	if strings.HasPrefix(normalized, "~") && normalized != "~" && !strings.HasPrefix(normalized, "~/") {
		return "", fmt.Errorf("runtime file path has unsupported home-relative form")
	}
	if normalized == "~" {
		return "", fmt.Errorf("runtime file path must not be home directory")
	}

	if strings.HasPrefix(normalized, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return "", fmt.Errorf("failed to resolve home directory for runtime file")
		}
		return filepath.Join(home, strings.TrimPrefix(normalized, "~/")), nil
	}

	if filepath.IsAbs(normalized) {
		return normalized, nil
	}

	base := strings.TrimSpace(workDir)
	if base == "" {
		return "", fmt.Errorf("workspace workdir is required for relative runtime file path")
	}
	return filepath.Join(base, normalized), nil
}

func writeRuntimeFile(targetPath string, content []byte, mode os.FileMode) error {
	targetDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(targetDir, ".sam-runtime-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return os.Chmod(targetPath, mode)
}

func sanitizedRuntimePath(path string) string {
	return strings.TrimSpace(path)
}
