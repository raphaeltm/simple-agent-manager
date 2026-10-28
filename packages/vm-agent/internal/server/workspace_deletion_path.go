package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func deletionRootIdentity(path string) (uint64, uint64, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, errors.New("filesystem identity unavailable")
	}
	return uint64(st.Dev), st.Ino, nil
}

// Reject all symlink ancestors and all mounts at or under the target. User and
// nested Docker mount trees are preserved even when the workspace owns its root.
func validateDeletionRoot(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return errors.New("unsafe workspace root")
	}
	current := "/"
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("workspace path is not an owned directory: %s", current)
		}
	}
	mounts, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(mounts), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		mount := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(fields[4])
		if mount == path || strings.HasPrefix(mount, path+"/") {
			return errors.New("workspace root contains a mount; preserving it")
		}
	}
	return nil
}

// Each attempt makes bounded progress and can resume after interruption. os.Root
// confines traversal to the captured directory even if child symlinks change.
func removeDeletionRoot(ctx context.Context, path string, device, inode uint64, budget int) error {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	}
	return removeDeletionRootWithOpener(ctx, path, device, inode, budget, os.OpenRoot)
}

func removeDeletionRootWithOpener(ctx context.Context, path string, device, inode uint64, budget int, open func(string) (*os.Root, error)) error {
	root, err := open(path)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Stat(".")
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(stat.Dev) != device || stat.Ino != inode {
		return errors.New("opened workspace root does not match deletion identity")
	}
	var removeChildren func(string) error
	removeChildren = func(dir string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := validateDeletionRoot(filepath.Join(path, dir)); err != nil {
			return err
		}
		file, err := root.Open(dir)
		if err != nil {
			return err
		}
		entries, err := file.ReadDir(budget + 1)
		file.Close()
		if err != nil && err != io.EOF {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if budget <= 0 {
				return errors.New("workspace filesystem cleanup budget exhausted; retry required")
			}
			budget--
			name := filepath.Join(dir, entry.Name())
			info, err := root.Lstat(name)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			if info.IsDir() {
				if err := removeChildren(name); err != nil {
					return err
				}
			}
			if err := root.Remove(name); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		return nil
	}
	if err := removeChildren("."); err != nil {
		return err
	}
	dev, ino, err := deletionRootIdentity(path)
	if err != nil {
		return err
	}
	if dev != device || ino != inode {
		return errors.New("workspace root changed before final removal")
	}
	parent, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Remove(filepath.Base(path))
}
