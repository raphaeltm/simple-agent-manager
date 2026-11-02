package bootstrap

import (
	"errors"
	"fmt"
	"os"
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
// the path is still removed outright and never followed. Entries are removed
// through an os.Root, so a symlink inside the directory, or the directory being
// swapped after it was inspected, cannot redirect the removal elsewhere. No
// mount is expected below a workspace root at clone time: containers receive
// the root (or a named volume) as their mount, never a host path beneath it.
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
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	opened, err := root.Stat(".")
	if err != nil {
		return err
	}
	if !os.SameFile(info, opened) {
		return errors.New("workspace directory changed while clearing it")
	}
	handle, err := root.Open(".")
	if err != nil {
		return err
	}
	names, err := handle.Readdirnames(-1)
	_ = handle.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := root.RemoveAll(name); err != nil {
			return fmt.Errorf("remove %s: %w", name, err)
		}
	}
	return nil
}
