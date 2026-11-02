package bootstrap

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func dirInode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

func TestClearWorkspaceDirForCloneKeepsDirectoryIdentity(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "workspace-1")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Hold the directory open so a replacement could not reuse its inode number.
	held, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	before := dirInode(t, dir)

	outside := t.TempDir()
	keep := filepath.Join(outside, "keep")
	if err := os.WriteFile(keep, []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "partial.pack"), []byte("junk"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link-out")); err != nil {
		t.Fatal(err)
	}

	if err := clearWorkspaceDirForClone(dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("directory not emptied: %d entries remain", len(entries))
	}
	if after := dirInode(t, dir); after != before {
		t.Fatalf("directory was replaced: inode %d -> %d", before, after)
	}
	if got, err := os.ReadFile(keep); err != nil || string(got) != "user data" {
		t.Fatalf("symlink entry was followed: %q %v", got, err)
	}
}

func TestClearWorkspaceDirForCloneNonDirectoryPaths(t *testing.T) {
	base := t.TempDir()

	missing := filepath.Join(base, "missing")
	if err := clearWorkspaceDirForClone(missing); err != nil {
		t.Fatalf("missing path: %v", err)
	}

	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := clearWorkspaceDirForClone(file); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		t.Fatalf("file at workspace path survived: %v", err)
	}

	target := t.TempDir()
	keep := filepath.Join(target, "keep")
	if err := os.WriteFile(keep, []byte("user data"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := clearWorkspaceDirForClone(link); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("symlink at workspace path survived: %v", err)
	}
	if got, err := os.ReadFile(keep); err != nil || string(got) != "user data" {
		t.Fatalf("symlinked workspace path was followed: %q %v", got, err)
	}
}
