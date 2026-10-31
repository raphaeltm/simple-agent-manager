package server

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Initialize the configured base one directory at a time. Every open is
// relative to its already-open parent and refuses symlinks, including races
// between mkdir and open. Never use MkdirAll on a user-replaceable ancestor.
func createOwnedWorkspaceDirectory(base, id string) (uint64, uint64, error) {
	if !filepath.IsAbs(base) || filepath.Clean(base) != base || base == "/" || id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
		return 0, 0, errors.New("unsafe workspace base or identifier")
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	parent, err := unix.Open("/", flags, 0)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = unix.Close(parent) }()
	for _, part := range strings.Split(strings.TrimPrefix(base, "/"), "/") {
		next, err := unix.Openat(parent, part, flags, 0)
		if errors.Is(err, unix.ENOENT) {
			if err := unix.Mkdirat(parent, part, 0755); err != nil && !errors.Is(err, unix.EEXIST) {
				return 0, 0, fmt.Errorf("initialize workspace base: %w", err)
			}
			next, err = unix.Openat(parent, part, flags, 0)
		}
		if err != nil {
			return 0, 0, fmt.Errorf("open workspace base without symlinks: %w", err)
		}
		_ = unix.Close(parent)
		parent = next
	}
	// Exclusive creation distinguishes SAM-created roots from unknown directories.
	if err := unix.Mkdirat(parent, id, 0755); err != nil {
		return 0, 0, err
	}
	child, err := unix.Openat(parent, id, flags, 0)
	if err != nil {
		return 0, 0, err
	}
	defer unix.Close(child)
	var identity unix.Stat_t
	if err := unix.Fstat(child, &identity); err != nil {
		return 0, 0, err
	}
	root := filepath.Join(base, id)
	if err := validateDeletionRoot(root); err != nil {
		return 0, 0, err
	}
	device, inode, err := deletionRootIdentity(root)
	if err != nil {
		return 0, 0, err
	}
	if device != uint64(identity.Dev) || inode != identity.Ino {
		return 0, 0, errors.New("workspace base changed during owned root creation")
	}
	return device, inode, nil
}
