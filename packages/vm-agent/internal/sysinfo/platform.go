package sysinfo

import (
	"os"
	"syscall"
)

// defaultReadFile reads a file and returns its content as a string.
func defaultReadFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// defaultStatFS calls syscall.Statfs on the given path.
func defaultStatFS(path string) (*syscall.Statfs_t, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, err
	}
	return &stat, nil
}
