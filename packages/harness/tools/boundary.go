package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var skippedSearchDirs = map[string]struct{}{
	".git":         {},
	"node_modules": {},
	"vendor":       {},
}

type workspaceBoundary struct {
	root string
}

func newWorkspaceBoundary(workDir string) (workspaceBoundary, error) {
	if strings.TrimSpace(workDir) == "" {
		return workspaceBoundary{}, fmt.Errorf("workdir must not be empty")
	}
	abs, err := filepath.Abs(workDir)
	if err != nil {
		return workspaceBoundary{}, fmt.Errorf("resolving workdir: %w", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return workspaceBoundary{}, fmt.Errorf("resolving workdir symlinks: %w", err)
	}
	info, err := os.Stat(real)
	if err != nil {
		return workspaceBoundary{}, fmt.Errorf("stat workdir: %w", err)
	}
	if !info.IsDir() {
		return workspaceBoundary{}, fmt.Errorf("workdir must be a directory")
	}
	return workspaceBoundary{root: real}, nil
}

func (b workspaceBoundary) existingFile(userPath string) (string, error) {
	lexical, err := b.lexicalPath(userPath)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(lexical)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("path %q is a symlink and is not allowed", userPath)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path %q is a directory", userPath)
	}
	return b.existingPath(userPath)
}

func (b workspaceBoundary) existingSearchRoot(userPath string) (string, error) {
	if strings.TrimSpace(userPath) == "." {
		return b.root, nil
	}
	lexical, err := b.lexicalPath(userPath)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(lexical)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("path %q is a symlink and is not allowed", userPath)
	}
	return b.existingPath(userPath)
}

func (b workspaceBoundary) writePath(userPath string) (string, error) {
	lexical, err := b.lexicalPath(userPath)
	if err != nil {
		return "", err
	}
	if info, err := os.Lstat(lexical); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("path %q is a symlink and is not allowed", userPath)
		}
		if info.IsDir() {
			return "", fmt.Errorf("path %q is a directory", userPath)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}

	parent := filepath.Dir(lexical)
	if err := b.ensureExistingAncestorsSafe(parent); err != nil {
		return "", err
	}
	return lexical, nil
}

func (b workspaceBoundary) lexicalPath(userPath string) (string, error) {
	if strings.TrimSpace(userPath) == "" {
		return "", fmt.Errorf("path must not be empty")
	}
	if filepath.IsAbs(userPath) {
		return "", fmt.Errorf("path %q escapes working directory", userPath)
	}
	clean := filepath.Clean(userPath)
	if clean == "." {
		return "", fmt.Errorf("path must not be empty")
	}
	resolved := filepath.Join(b.root, clean)
	if !b.contains(resolved) {
		return "", fmt.Errorf("path %q escapes working directory", userPath)
	}
	return resolved, nil
}

func (b workspaceBoundary) existingPath(userPath string) (string, error) {
	lexical, err := b.lexicalPath(userPath)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(lexical)
	if err != nil {
		return "", err
	}
	if !b.contains(real) {
		return "", fmt.Errorf("path %q escapes working directory", userPath)
	}
	return real, nil
}

func (b workspaceBoundary) ensureExistingAncestorsSafe(parent string) error {
	current := parent
	for {
		info, err := os.Lstat(current)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("parent path %q is not a directory", current)
			}
			real, err := filepath.EvalSymlinks(current)
			if err != nil {
				return err
			}
			if !b.contains(real) {
				return fmt.Errorf("path escapes working directory")
			}
			return nil
		}
		if !os.IsNotExist(err) {
			return err
		}
		next := filepath.Dir(current)
		if next == current {
			return fmt.Errorf("path escapes working directory")
		}
		current = next
	}
}

func (b workspaceBoundary) contains(path string) bool {
	rel, err := filepath.Rel(b.root, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func validateRelativePattern(pattern string) (string, error) {
	if strings.TrimSpace(pattern) == "" {
		return "", fmt.Errorf("pattern must not be empty")
	}
	if filepath.IsAbs(pattern) {
		return "", fmt.Errorf("path %q escapes working directory", pattern)
	}
	for _, part := range strings.Split(filepath.ToSlash(pattern), "/") {
		if part == ".." {
			return "", fmt.Errorf("path %q escapes working directory", pattern)
		}
	}
	clean := filepath.Clean(pattern)
	return filepath.ToSlash(clean), nil
}
