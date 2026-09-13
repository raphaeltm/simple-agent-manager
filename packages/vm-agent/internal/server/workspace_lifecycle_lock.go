package server

import "context"

type workspaceLifecycleEntry struct {
	semaphore sessionSnapshotLock
	users     int // Holders and waiters, protected by workspaceLifecycleMu.
}

// Each handle belongs to one operation. Entries are shared by workspace and
// reclaimed only after all holders and waiters finish, preventing split locks.
type workspaceLifecycleHandle struct {
	server      *Server
	workspaceID string
	entry       *workspaceLifecycleEntry
}

func (s *Server) workspaceLifecycleLock(workspaceID string) *workspaceLifecycleHandle {
	return &workspaceLifecycleHandle{server: s, workspaceID: workspaceID}
}

func (l *workspaceLifecycleHandle) Lock(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s := l.server
	s.workspaceLifecycleMu.Lock()
	if s.workspaceLifecycleLocks == nil {
		s.workspaceLifecycleLocks = make(map[string]*workspaceLifecycleEntry)
	}
	entry := s.workspaceLifecycleLocks[l.workspaceID]
	if entry == nil {
		entry = &workspaceLifecycleEntry{semaphore: newSessionSnapshotLock()}
		s.workspaceLifecycleLocks[l.workspaceID] = entry
	}
	entry.users++
	s.workspaceLifecycleMu.Unlock()
	if err := entry.semaphore.Lock(ctx); err != nil {
		l.release(entry)
		return err
	}
	if err := ctx.Err(); err != nil {
		entry.semaphore.Unlock()
		l.release(entry)
		return err
	}
	l.entry = entry
	return nil
}

func (l *workspaceLifecycleHandle) Unlock() {
	entry := l.entry
	if entry == nil {
		panic("unlock of unlocked workspace lifecycle lock")
	}
	l.entry = nil
	entry.semaphore.Unlock()
	l.release(entry)
}

func (l *workspaceLifecycleHandle) release(entry *workspaceLifecycleEntry) {
	l.server.workspaceLifecycleMu.Lock()
	defer l.server.workspaceLifecycleMu.Unlock()
	entry.users--
	if entry.users == 0 {
		delete(l.server.workspaceLifecycleLocks, l.workspaceID)
	}
}
