// Package cache provides opportunistic devcontainer image caching via container registries.
// All operations are best-effort: failures are logged as warnings and never block workspace creation.
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// ParseGitHubRepo extracts the owner and repo name from a GitHub repository URL or owner/repo string.
// Returns ok=false for non-GitHub URLs or unparseable input.
func ParseGitHubRepo(repoURL string) (owner, repo string, ok bool) {
	repoURL = strings.TrimSpace(repoURL)
	if repoURL == "" {
		return "", "", false
	}

	// Handle SSH URLs: git@github.com:owner/repo.git
	if strings.HasPrefix(repoURL, "git@github.com:") {
		path := strings.TrimPrefix(repoURL, "git@github.com:")
		path = strings.TrimSuffix(path, ".git")
		return splitOwnerRepo(path)
	}

	// Handle HTTPS URLs: https://github.com/owner/repo.git
	if strings.Contains(repoURL, "://") {
		parsed, err := url.Parse(repoURL)
		if err != nil {
			return "", "", false
		}
		if parsed.Hostname() != "github.com" {
			return "", "", false
		}
		path := strings.Trim(parsed.Path, "/")
		path = strings.TrimSuffix(path, ".git")
		return splitOwnerRepo(path)
	}

	// Handle bare owner/repo format
	return splitOwnerRepo(repoURL)
}

func splitOwnerRepo(path string) (owner, repo string, ok bool) {
	parts := strings.SplitN(path, "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// CacheRef constructs a container image reference for caching.
// For unnamed configs: ghcr.io/<owner>/<repo>:devcontainer-cache
// For named configs:   ghcr.io/<owner>/<repo>:devcontainer-cache-<configName>
// The configName is sanitized to the OCI tag character set.
func CacheRef(registry, owner, repo, configName string) string {
	tag := "devcontainer-cache"
	if configName != "" {
		tag = "devcontainer-cache-" + sanitizeTagComponent(configName)
	}
	return fmt.Sprintf("%s/%s/%s:%s", registry, strings.ToLower(owner), strings.ToLower(repo), tag)
}

// sanitizeTagComponent replaces characters invalid in OCI image tags with hyphens.
// OCI tags may contain: [a-zA-Z0-9_.-]
func sanitizeTagComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// DockerLogin authenticates to a container registry using docker login.
// Returns an error if the login fails.
func DockerLogin(ctx context.Context, registry, username, token string) error {
	if token == "" {
		return fmt.Errorf("no token provided for registry login")
	}
	if username == "" {
		username = "x-access-token"
	}

	cmd := exec.CommandContext(ctx, "docker", "login", registry,
		"--username", username,
		"--password-stdin")
	cmd.Stdin = strings.NewReader(token)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker login failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// PullCacheImage pulls a cache image from the registry.
// Returns an error if the pull fails (caller decides whether this is fatal).
func PullCacheImage(ctx context.Context, ref string) error {
	start := time.Now()
	cmd := exec.CommandContext(ctx, "docker", "pull", ref)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker pull failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	slog.Info("Cache image pulled successfully", "ref", ref, "duration", time.Since(start).Round(time.Second))
	return nil
}

// PushCacheImage finds the image used by the running devcontainer, tags it with the
// cache reference, and pushes it to the registry. This is designed to be called in
// a background goroutine after a successful build.
func PushCacheImage(ctx context.Context, containerLabelKey, containerLabelValue, cacheRef string) error {
	// Find the running container by label.
	filter := fmt.Sprintf("label=%s=%s", containerLabelKey, containerLabelValue)
	psCmd := exec.CommandContext(ctx, "docker", "ps", "-q", "--filter", filter)
	psOutput, err := psCmd.Output()
	if err != nil {
		return fmt.Errorf("failed to find devcontainer: %w", err)
	}

	containers := strings.Fields(string(psOutput))
	if len(containers) == 0 {
		return fmt.Errorf("no running devcontainer found for label %s=%s", containerLabelKey, containerLabelValue)
	}
	if len(containers) > 1 {
		slog.Warn("Multiple containers found for label; using first match",
			"label", fmt.Sprintf("%s=%s", containerLabelKey, containerLabelValue),
			"count", len(containers),
			"selected", containers[0])
	}
	containerID := containers[0]

	// Get the image ID from the container.
	inspectCmd := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{.Image}}", containerID)
	inspectOutput, err := inspectCmd.Output()
	if err != nil {
		return fmt.Errorf("failed to inspect container image: %w", err)
	}
	imageID := strings.TrimSpace(string(inspectOutput))
	if imageID == "" {
		return fmt.Errorf("container %s has no image ID", containerID)
	}

	// Tag the image.
	tagCmd := exec.CommandContext(ctx, "docker", "tag", imageID, cacheRef)
	if tagOutput, tagErr := tagCmd.CombinedOutput(); tagErr != nil {
		return fmt.Errorf("docker tag failed: %w: %s", tagErr, strings.TrimSpace(string(tagOutput)))
	}

	// Push the tagged image.
	start := time.Now()
	pushCmd := exec.CommandContext(ctx, "docker", "push", cacheRef)
	pushOutput, err := pushCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker push failed: %w: %s", err, strings.TrimSpace(string(pushOutput)))
	}

	slog.Info("Cache image pushed successfully", "ref", cacheRef, "duration", time.Since(start).Round(time.Second))
	return nil
}
