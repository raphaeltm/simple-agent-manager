package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/transferscratch"
)

func (s *Server) reconcileWorkspaceDeletions(ctx context.Context) {
	if s.store == nil {
		return
	}
	batch := s.config.WorkspaceDeletionBatchSize
	if batch <= 0 {
		batch = config.DefaultWorkspaceDeletionBatchSize
	}
	items, err := s.store.WorkspaceDeletions(batch)
	if err != nil {
		return
	}
	for id := range items {
		if err := s.reconcileWorkspaceDeletion(ctx, id); err != nil {
			slog.Warn("Workspace physical cleanup remains pending", "workspace", id, "error", err)
		}
	}
}

func (s *Server) reconcileWorkspaceDeletion(ctx context.Context, id string) error {
	lock := s.workspaceLifecycleLock(id)
	if err := lock.Lock(ctx); err != nil {
		return err
	}
	defer lock.Unlock()
	// The list is only a work queue. An inline delete may have finalized the
	// record while we waited for its lock; never act on or write that old copy.
	payload, err := s.store.GetWorkspaceDeletion(id)
	if err != nil || payload == "" {
		return err
	}
	var d workspaceDeletionIntent
	if err := json.Unmarshal([]byte(payload), &d); err != nil {
		return err
	}
	if d.WorkspaceID != id {
		return errors.New("deletion record workspace identity mismatch")
	}
	if d.Finalized {
		return nil
	}
	attemptCtx, cancel := context.WithTimeout(ctx, s.workspaceDeletionAttemptTimeout())
	defer cancel()
	// The deletion steps persist their own progress. Rotate failed attempts
	// without rewriting their payload or regressing a completion tombstone.
	if err := s.applyWorkspaceDeletion(attemptCtx, &d); err != nil {
		return errors.Join(err, s.store.TouchWorkspaceDeletion(id))
	}
	return nil
}

func (s *Server) startWorkspaceDeletionReconciler() {
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	s.workspaceLifecycleMu.Lock()
	if s.workspaceDeletionDone != nil {
		s.workspaceLifecycleMu.Unlock()
		cancelLifetime()
		return
	}
	s.workspaceDeletionCancel = cancelLifetime
	s.workspaceDeletionDone = make(chan struct{})
	s.workspaceDeletionWake = make(chan struct{}, 1)
	done, wake := s.workspaceDeletionDone, s.workspaceDeletionWake
	s.workspaceLifecycleMu.Unlock()
	go func() {
		defer close(done)
		interval := s.config.WorkspaceDeletionRetryInterval
		if interval <= 0 {
			interval = config.DefaultWorkspaceDeletionRetryInterval
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			ctx, cancel := context.WithTimeout(lifetime, interval)
			s.reconcileWorkspaceDeletions(ctx)
			s.inventoryWorkspaceCleanup(ctx)
			if s.config.Role == config.RoleWorkspace && !s.config.IsStandaloneMode() {
				if err := s.reapStaleSnapshotHelpers(ctx, time.Now()); err != nil {
					slog.Warn("Stale snapshot helper reap failed", "error", err)
				}
			}
			retention := s.config.WorkspaceDeletionTombstoneRetention
			if retention <= 0 {
				retention = config.DefaultWorkspaceDeletionTombstoneRetention
			}
			batch := s.config.WorkspaceDeletionBatchSize
			if batch <= 0 {
				batch = config.DefaultWorkspaceDeletionBatchSize
			}
			if s.store != nil {
				if _, err := s.store.PruneFinalizedWorkspaceDeletions(time.Now().Add(-retention), batch); err != nil {
					slog.Warn("Workspace deletion tombstone cleanup failed", "error", err)
				}
			}
			transferscratch.SweepFromEnvironment(ctx)
			cancel()
			select {
			case <-s.done:
				return
			case <-lifetime.Done():
				return
			case <-ticker.C:
			case <-wake:
			}
		}
	}()
}

// wakeWorkspaceDeletionReconciler runs the next reconcile pass now instead of on the
// next tick. It never blocks: one pending wake already covers every durable intent.
func (s *Server) wakeWorkspaceDeletionReconciler() {
	s.workspaceLifecycleMu.Lock()
	wake := s.workspaceDeletionWake
	s.workspaceLifecycleMu.Unlock()
	if wake == nil {
		return
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *Server) stopWorkspaceDeletionReconciler() {
	s.workspaceLifecycleMu.Lock()
	cancel, done := s.workspaceDeletionCancel, s.workspaceDeletionDone
	s.workspaceLifecycleMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}
