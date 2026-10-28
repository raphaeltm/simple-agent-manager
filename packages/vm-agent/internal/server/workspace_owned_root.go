package server

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
)

// Initialize the configured base one directory at a time. Every open is
// relative to its already-open parent and refuses symlinks, including races
// between mkdir and open. Never use MkdirAll on a user-replaceable ancestor.
func createOwnedWorkspaceDirectory(base, id string) (uint64, uint64, error) {
	if !filepath.IsAbs(base) || filepath.Clean(base) != base || base == "/" || id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
		return 0, 0, errors.New("unsafe workspace base or identifier")
	}
	flags := syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	parent, err := syscall.Open("/", flags, 0)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = syscall.Close(parent) }()
	for _, part := range strings.Split(strings.TrimPrefix(base, "/"), "/") {
		next, err := syscall.Openat(parent, part, flags, 0)
		if errors.Is(err, syscall.ENOENT) {
			if err := syscall.Mkdirat(parent, part, 0755); err != nil && !errors.Is(err, syscall.EEXIST) {
				return 0, 0, fmt.Errorf("initialize workspace base: %w", err)
			}
			next, err = syscall.Openat(parent, part, flags, 0)
		}
		if err != nil {
			return 0, 0, fmt.Errorf("open workspace base without symlinks: %w", err)
		}
		_ = syscall.Close(parent)
		parent = next
	}
	// Exclusive creation distinguishes SAM-created roots from unknown directories.
	if err := syscall.Mkdirat(parent, id, 0755); err != nil {
		return 0, 0, err
	}
	child, err := syscall.Openat(parent, id, flags, 0)
	if err != nil {
		return 0, 0, err
	}
	defer syscall.Close(child)
	var identity syscall.Stat_t
	if err := syscall.Fstat(child, &identity); err != nil {
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
