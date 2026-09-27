package server

import (
	"context"
	"fmt"
)

// An accepted restore owns its lifetime and the workspace lifecycle lock. HTTP
// retries can stop waiting, but teardown must wait until filesystem/host effects
// finish. Shutdown cancels and joins the jobs before closing their dependencies.
func (s *Server) completeSessionRestore(ctx context.Context, attempt *sessionRestoreAttempt, input *sessionSnapshotHandlerInput, admittedRuntime *WorkspaceRuntime, restore func(context.Context) map[string]interface{}) {
	defer attempt.cancel()
	defer func() {
		if recover() != nil {
			// Panic values may contain credentials; cache only an opaque failure.
			attempt.result = nil
			attempt.err = fmt.Errorf("session restore aborted unexpectedly")
		}
		close(attempt.done)
		s.clearRemovedWorkspaceRestores(input.workspaceID)
	}()
	lock := s.workspaceLifecycleLock(input.workspaceID)
	if err := lock.Lock(ctx); err != nil {
		attempt.err = err
		return
	}
	defer lock.Unlock()
	runtime, exists := s.getWorkspaceRuntime(input.workspaceID)
	if !exists || runtime != admittedRuntime {
		attempt.err = fmt.Errorf("workspace changed before session restore")
		return
	}
	snapshot := s.snapshotWorkspaceRuntime(runtime)
	if snapshot.Status != "running" && snapshot.Status != "recovery" {
		attempt.err = fmt.Errorf("workspace is not available for session restore")
		return
	}
	if err := ctx.Err(); err != nil {
		attempt.err = err
		return
	}
	// Persist a non-adoption fence before token, HOME/WIP, or ACP effects.
	if err := s.persistSessionRestoreFence(input.workspaceID, input.sessionID); err != nil {
		attempt.err = err
		return
	}
	if input.workspaceCallbackToken != "" {
		s.upsertWorkspaceRuntime(input.workspaceID, "", "", "", input.workspaceCallbackToken)
	}
	attempt.result = restore(ctx)
	attempt.err = ctx.Err()
}

// Admission checks done under the same mutex, so after Stop closes done this
// snapshot includes every accepted attempt. No mutex is held while joining.
func (s *Server) cancelAndWaitSessionRestores() {
	s.sessionHostMu.Lock()
	attempts := make([]*sessionRestoreAttempt, 0, len(s.sessionRestores))
	for _, attempt := range s.sessionRestores {
		attempt.cancel()
		attempts = append(attempts, attempt)
	}
	s.sessionHostMu.Unlock()
	for _, attempt := range attempts {
		<-attempt.done
	}
}
