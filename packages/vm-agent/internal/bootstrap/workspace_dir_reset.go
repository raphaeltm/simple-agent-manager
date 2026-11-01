package bootstrap

import (
	"fmt"
	"os"
	"path/filepath"
)

// clearWorkspaceDirForClone empties a workspace directory before a fresh clone
// while keeping the directory itself. The server records the root's
// device/inode when it creates a SAM-owned workspace root
// (createOwnedWorkspaceRoot), and physical deletion refuses to remove a root
// whose identity no longer matches that proof. Replacing the directory here
// gave every freshly cloned workspace a new inode, so automatic deletion
// returned 409 "host workspace root ownership is unproven" on every attempt.
//
// Git clones into an existing empty directory. A symlink or non-directory at
// the path is still removed outright and never followed.
func clearWorkspaceDirForClone(dir string) error {
	info, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return os.RemoveAll(dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		// RemoveAll removes a symlink entry itself, not its target.
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return fmt.Errorf("remove %s: %w", entry.Name(), err)
		}
	}
	return nil
}
