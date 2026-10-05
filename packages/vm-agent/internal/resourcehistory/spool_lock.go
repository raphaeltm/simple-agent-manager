package resourcehistory

import (
	"path/filepath"
	"sync"
)

type spoolLock struct {
	mu    sync.Mutex
	users int
}

// A successor collector can share a spool directory. Keep ownership across the
// entire publish/upload/remove operation, and release unused registry entries.
var spoolLocks = struct {
	sync.Mutex
	byDir map[string]*spoolLock
}{byDir: make(map[string]*spoolLock)}

func acquireSpoolLock(dir string) func() {
	key, err := filepath.Abs(dir)
	if err != nil {
		key = filepath.Clean(dir)
	}
	spoolLocks.Lock()
	lock := spoolLocks.byDir[key]
	if lock == nil {
		lock = &spoolLock{}
		spoolLocks.byDir[key] = lock
	}
	lock.users++
	spoolLocks.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		spoolLocks.Lock()
		lock.users--
		if lock.users == 0 {
			delete(spoolLocks.byDir, key)
		}
		spoolLocks.Unlock()
	}
}
