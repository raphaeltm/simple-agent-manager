package deploy

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
)

// ImageGCConfig configures the rollback-aware image garbage collector.
type ImageGCConfig struct {
	// ComposeCmd is the docker compose command (e.g. "docker compose").
	ComposeCmd string
	// DryRun logs what would be pruned without actually removing images.
	DryRun bool
}

// ImageGCResult reports what was pruned and what was protected.
type ImageGCResult struct {
	ProtectedImages []string // Images kept (current + previous release)
	PrunedImages    []string // Images removed
	Errors          []string // Non-fatal errors during pruning
}

// ExecRunner abstracts command execution for testing.
type ExecRunner interface {
	// Run executes a command and returns combined stdout, or an error.
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// defaultExecRunner uses os/exec.
type defaultExecRunner struct{}

func (d *defaultExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil && stderr.Len() > 0 {
		return strings.TrimSpace(string(out)), fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), err
}

// PruneUnusedImages removes Docker images not referenced by the current or
// previous (rollback-target) release. It never prunes images for the two
// most recent successfully-applied releases.
//
// The function:
// 1. Reads disk state to find images used by current and previous releases
// 2. Lists all local Docker images
// 3. Removes images not in the protected set
func PruneUnusedImages(ctx context.Context, disk *DiskState, runner ExecRunner, cfg ImageGCConfig) (*ImageGCResult, error) {
	if runner == nil {
		runner = &defaultExecRunner{}
	}

	result := &ImageGCResult{}

	// Step 1: Identify protected images from current and previous releases.
	protectedImages, err := collectProtectedImages(disk)
	if err != nil {
		return nil, fmt.Errorf("imagegc: collect protected images: %w", err)
	}
	result.ProtectedImages = protectedImages

	if len(protectedImages) == 0 {
		slog.Info("imagegc: no releases on disk, skipping prune")
		return result, nil
	}

	// Build a set for fast lookup
	protectedSet := make(map[string]bool, len(protectedImages))
	for _, img := range protectedImages {
		protectedSet[img] = true
	}

	// Step 2: List all local Docker images (repository:tag and ID).
	allImages, err := listLocalImages(ctx, runner)
	if err != nil {
		return nil, fmt.Errorf("imagegc: list images: %w", err)
	}

	// Step 3: Identify and remove unprotected images.
	for _, img := range allImages {
		if protectedSet[img] {
			continue
		}
		// Skip base images (no repository) and dangling images handled separately
		if img == "<none>:<none>" || img == "" {
			continue
		}

		if cfg.DryRun {
			slog.Info("imagegc: would prune", "image", img)
			result.PrunedImages = append(result.PrunedImages, img)
			continue
		}

		slog.Info("imagegc: pruning image", "image", img)
		_, rmErr := runner.Run(ctx, "docker", "rmi", img)
		if rmErr != nil {
			// Non-fatal: image might be in use by a running container
			errMsg := fmt.Sprintf("failed to remove %s: %v", img, rmErr)
			slog.Warn("imagegc: prune failed", "image", img, "error", rmErr)
			result.Errors = append(result.Errors, errMsg)
		} else {
			result.PrunedImages = append(result.PrunedImages, img)
		}
	}

	// Step 4: Prune dangling images (no tag, no container reference).
	if !cfg.DryRun {
		_, _ = runner.Run(ctx, "docker", "image", "prune", "-f")
	}

	slog.Info("imagegc: complete",
		"protected", len(result.ProtectedImages),
		"pruned", len(result.PrunedImages),
		"errors", len(result.Errors))

	return result, nil
}

// collectProtectedImages reads the disk state to find all image references
// used by the current release and the one immediately before it.
func collectProtectedImages(disk *DiskState) ([]string, error) {
	currentSeq, err := disk.CurrentSeq()
	if err != nil {
		return nil, fmt.Errorf("imagegc: read current seq: %w", err)
	}
	if currentSeq <= 0 {
		return nil, nil
	}

	var protected []string

	// Protect current release images
	currentImages, err := extractImagesFromRelease(disk, currentSeq)
	if err != nil {
		slog.Warn("imagegc: failed to read current release images", "seq", currentSeq, "error", err)
	} else {
		protected = append(protected, currentImages...)
	}

	// Protect previous release images (rollback target)
	prevSeq := findPreviousSeq(disk, currentSeq)
	if prevSeq > 0 {
		prevImages, err := extractImagesFromRelease(disk, prevSeq)
		if err != nil {
			slog.Warn("imagegc: failed to read previous release images", "seq", prevSeq, "error", err)
		} else {
			protected = append(protected, prevImages...)
		}
	}

	// Deduplicate
	seen := make(map[string]bool)
	var deduped []string
	for _, img := range protected {
		if !seen[img] {
			seen[img] = true
			deduped = append(deduped, img)
		}
	}

	return deduped, nil
}

// extractImagesFromRelease reads the compose YAML for a release and extracts
// all image references. We parse the compose file line-by-line looking for
// `image:` directives rather than importing a full YAML parser to keep
// the vm-agent binary small.
func extractImagesFromRelease(disk *DiskState, seq int64) ([]string, error) {
	composeContent, err := disk.ReadComposeFile(seq)
	if err != nil {
		return nil, err
	}

	var images []string
	for _, line := range strings.Split(composeContent, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "image:") {
			img := strings.TrimSpace(strings.TrimPrefix(trimmed, "image:"))
			// Remove surrounding quotes if present
			img = strings.Trim(img, "\"'")
			if img != "" {
				images = append(images, img)
			}
		}
	}
	return images, nil
}

// findPreviousSeq finds the highest release sequence number below currentSeq
// that exists on disk.
func findPreviousSeq(disk *DiskState, currentSeq int64) int64 {
	seqs := disk.ListReleaseSeqs()
	var best int64
	for _, s := range seqs {
		if s < currentSeq && s > best {
			best = s
		}
	}
	return best
}

// listLocalImages returns all Docker image references (repository:tag) on the host.
func listLocalImages(ctx context.Context, runner ExecRunner) ([]string, error) {
	out, err := runner.Run(ctx, "docker", "images", "--format", "{{.Repository}}:{{.Tag}}")
	if err != nil {
		return nil, err
	}

	var images []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			images = append(images, line)
		}
	}
	return images, nil
}
