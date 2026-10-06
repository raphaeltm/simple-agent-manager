//go:build !linux

package deploy

import "os"

// deviceID returns 0 on non-Linux platforms. The mount guard comparison
// will always see parent == child (both 0), so IsMountpoint returns false.
// This is correct: the mount guard is a Linux-only production check. On
// non-Linux hosts (developer machines, macOS CI), the guard degrades to
// "not mounted" which is safe — the real check runs on the Linux VM.
func deviceID(_ os.FileInfo) uint64 { return 0 }
