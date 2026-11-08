package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/workspace/vm-agent/internal/resourcemon"
)

// captureQuiescedEvictionSnapshot recaptures an evicted workspace after `docker stop`.
//
// The pre-stop capture is taken from the live container and cannot prove the agent's
// final dirty or untracked files were saved, so the control plane never lets it authorize
// deleting the source. This capture runs in a quiet helper built from the stopped
// container's writable layer and volumes. It is reported quiesced only when the source
// stayed stopped and no other container ran with the workspace's storage mounted meanwhile,
// which is what lets the control plane grant preservation and delete the source once the
// conversation is restored elsewhere. A failure leaves the pre-stop capture in place.
func (s *Server) captureQuiescedEvictionSnapshot(ctx context.Context, target resourcemon.EvictionTarget) (resourcemon.EvictionSnapshotOutcome, error) {
	if s.config.IsStandaloneMode() {
		return resourcemon.EvictionSnapshotOutcome{}, errors.New("final eviction snapshot requires a container runtime")
	}
	input, err := s.evictionSessionSnapshotInput(target.WorkspaceID)
	if err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	snapshotLock := s.sessionSnapshotLock(input.chatSessionID)
	if err := snapshotLock.Lock(ctx); err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	defer snapshotLock.Unlock()
	lifecycleLock := s.workspaceLifecycleLock(target.WorkspaceID)
	if err := lifecycleLock.Lock(ctx); err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	defer lifecycleLock.Unlock()
	// Same guard as every other capture path: a durable deletion intent owns the workspace.
	if err := s.requireNoWorkspaceDeletion(target.WorkspaceID); err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	if !s.evictionTargetIsCurrent(ctx, target) {
		return resourcemon.EvictionSnapshotOutcome{}, fmt.Errorf("eviction target is no longer current")
	}
	input.finalEvictionCapture = true
	outcome, err := s.runStoppedSourceSnapshot(ctx, input, target, false)
	if err != nil {
		s.releaseFailedEvictionCapture(input, err)
	}
	return outcome, err
}

// runStoppedSourceSnapshot captures an exact stopped source container through a helper.
// Callers hold the chat snapshot lock and the workspace lifecycle lock.
func (s *Server) runStoppedSourceSnapshot(ctx context.Context, input *sessionSnapshotHandlerInput, target resourcemon.EvictionTarget, requireOOM bool) (resourcemon.EvictionSnapshotOutcome, error) {
	windowStart := time.Now()
	before, err := s.inspectSnapshotSource(ctx, target.ContainerID)
	if err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	helper, cleanup, err := s.startStoppedSnapshotHelper(ctx, target.WorkspaceID, target.ContainerID, input.runtime, requireOOM)
	if err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	defer awaitSnapshotHelperCleanup(ctx, cleanup)
	hostRoot := input.runtime.ContainerLabelValue
	verify := func(checkCtx context.Context) error {
		return s.verifySnapshotSourceQuiesced(checkCtx, target, before, hostRoot, helper.containerID, windowStart)
	}
	// Checked before the capture and again just before completion: a source that restarts
	// or a writer present at either point makes this an ordinary (non-final) capture.
	preErr := verify(ctx)
	input.containerTarget = helper
	input.quiescence = func(checkCtx context.Context) error {
		if preErr != nil {
			return preErr
		}
		return verify(checkCtx)
	}
	result, err := s.runSessionSnapshot(ctx, input)
	if err != nil {
		return resourcemon.EvictionSnapshotOutcome{}, err
	}
	quiesced, _ := result["quiesced"].(bool)
	return resourcemon.EvictionSnapshotOutcome{Quiesced: quiesced}, nil
}

// verifySnapshotSourceQuiesced proves the source did not run since `before` and that no
// other container ran with the storage a later deletion destroys since windowStart.
func (s *Server) verifySnapshotSourceQuiesced(ctx context.Context, target resourcemon.EvictionTarget, before snapshotSourceState, hostRoot, helperID string, windowStart time.Time) error {
	now, err := s.inspectSnapshotSource(ctx, target.ContainerID)
	if err != nil {
		return err
	}
	if now.running || now.startedAt != before.startedAt || now.finishedAt != before.finishedAt {
		return errors.New("snapshot source ran during the capture")
	}
	return s.requireNoForeignWorkspaceWriters(ctx, target.WorkspaceID, hostRoot, windowStart, target.ContainerID, helperID)
}

// releaseFailedEvictionCapture tells the control plane a capture generation will never
// complete, so it is released and the previous complete generation stays authoritative.
func (s *Server) releaseFailedEvictionCapture(input *sessionSnapshotHandlerInput, err error) {
	generation := snapshotCaptureErrorGeneration(err)
	if generation == "" {
		return
	}
	reportCtx, cancel := context.WithTimeout(context.Background(), s.sessionSnapshotProgressReportTimeout())
	defer cancel()
	if reportErr := s.reportSnapshotFailure(reportCtx, input.workspaceID, input.chatSessionID, generation, err.Error(), input.callbackToken); reportErr != nil {
		slog.Warn("Final eviction snapshot failure report failed", "workspaceId", input.workspaceID, "chatSessionId", input.chatSessionID, "generation", generation, "error", reportErr)
	}
}

// errWorkspaceEvicting refuses an ordinary snapshot while the workspace is being evicted.
// A capture prepared then would replace the eviction's final generation as the snapshot
// the control plane evaluates, and it fails anyway once the container is stopped.
var errWorkspaceEvicting = errors.New("workspace eviction in progress; snapshot refused")

// markEvictionFinalizing covers the window from the eviction's write-ahead stop intent to
// the recorded eviction (markWorkspaceEvicted), which now spans the final capture. During it
// the intent's delivery must not be reconciled as an interrupted stop, and no other capture
// may start. The mark is in memory: after an agent restart nothing is in flight, so the
// reconciler owns the intent as before.
func (s *Server) markEvictionFinalizing(workspaceID string) {
	s.evictionFinalizing.Store(workspaceID, struct{}{})
}

func (s *Server) clearEvictionFinalizing(workspaceID string) {
	s.evictionFinalizing.Delete(workspaceID)
}

func (s *Server) isEvictionFinalizing(workspaceID string) bool {
	_, ok := s.evictionFinalizing.Load(workspaceID)
	return ok
}

// requireWorkspaceNotEvicting is checked by ordinary snapshot entry points under the
// workspace lifecycle lock, before anything is prepared on the control plane.
func (s *Server) requireWorkspaceNotEvicting(workspaceID string) error {
	if s.isEvictionFinalizing(workspaceID) {
		return errWorkspaceEvicting
	}
	s.workspaceMu.RLock()
	runtime := s.workspaces[workspaceID]
	evicted := runtime != nil && runtime.Status == "evicted"
	s.workspaceMu.RUnlock()
	if evicted {
		return errWorkspaceEvicting
	}
	return nil
}
