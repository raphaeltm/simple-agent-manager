package server

import (
	"context"
	"encoding/json"
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
	for _, payload := range items {
		var d workspaceDeletionIntent
		if json.Unmarshal([]byte(payload), &d) != nil || d.Finalized {
			continue
		}
		lock := s.workspaceLifecycleLock(d.WorkspaceID)
		if lock.Lock(ctx) != nil {
			return
		}
		attemptCtx, cancel := context.WithTimeout(ctx, s.workspaceDeletionAttemptTimeout())
		err := s.applyWorkspaceDeletion(attemptCtx, &d)
		cancel()
		if err != nil {
			_ = s.saveWorkspaceDeletion(&d)
		}
		lock.Unlock()
		if err != nil {
			slog.Warn("Workspace physical cleanup remains pending", "workspace", d.WorkspaceID, "error", err)
		}
	}
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
