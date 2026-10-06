package config

import (
	"net/url"
	"path/filepath"
	"strings"
)

func deriveWorkspaceDir(workspaceBaseDir, repository string) string {
	baseDir := strings.TrimSpace(workspaceBaseDir)
	if baseDir == "" {
		baseDir = "/workspace"
	}

	repoDirName := DeriveRepoDirName(repository)
	if repoDirName == "" {
		// Preserve legacy behavior when the repo is unknown: a fixed base directory.
		return baseDir
	}

	return filepath.Join(baseDir, repoDirName)
}

func deriveContainerWorkDir(workspaceDir string) string {
	if strings.TrimSpace(workspaceDir) == "" {
		return "/workspaces"
	}
	base := filepath.Base(workspaceDir)
	if base == "" || base == "." || base == "/" {
		return "/workspaces"
	}
	return filepath.Join("/workspaces", base)
}

// DeriveRepoDirName extracts a filesystem-safe directory name from a repository
// URL or owner/repo string. Exported for use by the bootstrap package.
func DeriveRepoDirName(repository string) string {
	repo := strings.TrimSpace(repository)
	if repo == "" {
		return ""
	}

	// Handle full URLs (https://github.com/org/repo.git).
	if strings.Contains(repo, "://") {
		if parsed, err := url.Parse(repo); err == nil {
			repo = parsed.Path
		}
	}

	repo = strings.Trim(repo, "/")
	if repo == "" {
		return ""
	}

	parts := strings.Split(repo, "/")
	name := parts[len(parts)-1]
	name = strings.TrimSuffix(name, ".git")
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}

	// Keep the name filesystem-safe. This is intentionally conservative.
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
