package deploy

import (
	"os"
	"syscall"
)

// deviceID returns the device ID (st_dev) for the given file info.
// Linux-specific: uses syscall.Stat_t.
func deviceID(info os.FileInfo) uint64 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0
	}
	return stat.Dev
}
