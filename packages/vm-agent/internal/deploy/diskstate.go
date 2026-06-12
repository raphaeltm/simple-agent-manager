package deploy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// DiskState manages the on-disk layout for deployment releases.
//
// Layout:
//
//	{baseDir}/
//	  desired/
//	    releases/
//	      {seq}/
//	        metadata.json   — ReleaseState
//	        docker-compose.yml
//	    current             — symlink to releases/{seq}
type DiskState struct {
	baseDir string
}

// NewDiskState creates a DiskState rooted at baseDir.
// It creates the directory structure if it doesn't exist.
func NewDiskState(baseDir string) (*DiskState, error) {
	releasesDir := filepath.Join(baseDir, "desired", "releases")
	if err := os.MkdirAll(releasesDir, 0755); err != nil {
		return nil, fmt.Errorf("create releases directory: %w", err)
	}
	return &DiskState{baseDir: baseDir}, nil
}

// CurrentSeq returns the sequence number of the currently applied release,
// or 0 if no release has been applied.
func (d *DiskState) CurrentSeq() (int64, error) {
	currentPath := d.currentSymlink()
	target, err := os.Readlink(currentPath)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read current symlink: %w", err)
	}

	// target is a relative path like "releases/42" or just "42"
	base := filepath.Base(target)
	seq, err := strconv.ParseInt(base, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse sequence from symlink target %q: %w", target, err)
	}
	return seq, nil
}

// CurrentState returns the ReleaseState for the currently applied release,
// or nil if no release has been applied.
func (d *DiskState) CurrentState() (*ReleaseState, error) {
	seq, err := d.CurrentSeq()
	if err != nil {
		return nil, err
	}
	if seq == 0 {
		return nil, nil
	}
	return d.ReadState(seq)
}

// ReadState reads the metadata for a specific release sequence.
func (d *DiskState) ReadState(seq int64) (*ReleaseState, error) {
	metadataPath := filepath.Join(d.releaseDir(seq), "metadata.json")
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		return nil, fmt.Errorf("read metadata for seq %d: %w", seq, err)
	}
	var state ReleaseState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parse metadata for seq %d: %w", seq, err)
	}
	return &state, nil
}

// WriteRelease atomically writes a release's compose file, Caddyfile, and metadata to disk.
func (d *DiskState) WriteRelease(state *ReleaseState, composeYAML string, caddyfile string) error {
	dir := d.releaseDir(state.Seq)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create release directory: %w", err)
	}

	// Write compose file
	composePath := filepath.Join(dir, "docker-compose.yml")
	if err := writeFileAtomic(composePath, composeYAML, 0644); err != nil {
		return fmt.Errorf("write compose file: %w", err)
	}

	caddyPath := d.CaddyfilePath(state.Seq)
	if err := writeFileAtomic(caddyPath, caddyfile, 0644); err != nil {
		return fmt.Errorf("write Caddyfile: %w", err)
	}

	// Compute and store compose hash
	hash := sha256.Sum256([]byte(composeYAML))
	state.ComposeHash = hex.EncodeToString(hash[:])

	// Write metadata
	metadataPath := filepath.Join(dir, "metadata.json")
	metaBytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	if err := writeFileAtomic(metadataPath, string(metaBytes), 0644); err != nil {
		return fmt.Errorf("write metadata: %w", err)
	}

	return nil
}

// UpdateState updates only the metadata for a release (e.g., after status change).
func (d *DiskState) UpdateState(state *ReleaseState) error {
	metadataPath := filepath.Join(d.releaseDir(state.Seq), "metadata.json")
	metaBytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	if err := writeFileAtomic(metadataPath, string(metaBytes), 0644); err != nil {
		return fmt.Errorf("write metadata: %w", err)
	}
	return nil
}

// SetCurrent atomically updates the "current" symlink to point to the given sequence.
func (d *DiskState) SetCurrent(seq int64) error {
	currentPath := d.currentSymlink()
	tmpPath := currentPath + ".tmp"

	// Remove old temp symlink if it exists
	os.Remove(tmpPath)

	// Create new symlink (relative path)
	relTarget := filepath.Join("releases", strconv.FormatInt(seq, 10))
	if err := os.Symlink(relTarget, tmpPath); err != nil {
		return fmt.Errorf("create temp symlink: %w", err)
	}

	// Atomic rename
	if err := os.Rename(tmpPath, currentPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename symlink: %w", err)
	}
	return nil
}

// ComposeFilePath returns the path to the docker-compose.yml for a given release.
func (d *DiskState) ComposeFilePath(seq int64) string {
	return filepath.Join(d.releaseDir(seq), "docker-compose.yml")
}

// CaddyfilePath returns the path to the Caddyfile for a given release.
func (d *DiskState) CaddyfilePath(seq int64) string {
	return filepath.Join(d.releaseDir(seq), "Caddyfile")
}

// CurrentComposeFilePath returns the compose file path for the currently applied release.
func (d *DiskState) CurrentComposeFilePath() (string, error) {
	seq, err := d.CurrentSeq()
	if err != nil {
		return "", err
	}
	if seq == 0 {
		return "", fmt.Errorf("no current release")
	}
	return d.ComposeFilePath(seq), nil
}

func (d *DiskState) releaseDir(seq int64) string {
	return filepath.Join(d.baseDir, "desired", "releases", strconv.FormatInt(seq, 10))
}

func (d *DiskState) currentSymlink() string {
	return filepath.Join(d.baseDir, "desired", "current")
}
