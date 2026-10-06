package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func (s *Server) workspaceEvictionDelivery(result resourcemon.EvictionResult) persistence.EvictionDelivery {
	occurredAt := result.CompletedAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}
	return persistence.EvictionDelivery{
		ID:               persistence.EvictionDeliveryID(result.Target.WorkspaceID, result.Target.EvictionGeneration, result.Target.ContainerID),
		WorkspaceID:      result.Target.WorkspaceID,
		ProjectID:        s.projectIDForEviction(result.Target.WorkspaceID),
		NodeID:           strings.TrimSpace(s.config.NodeID),
		ContainerID:      result.Target.ContainerID,
		Generation:       result.Target.EvictionGeneration,
		Reason:           string(result.Target.Reason),
		SnapshotCaptured: result.SnapshotCaptured,
		ContainerStopped: result.ContainerStopped,
		OccurredAt:       occurredAt,
	}
}

// Caller holds lifecycle ownership through the subsequent Docker stop.
func (s *Server) prepareWorkspaceEvictionStop(ctx context.Context, target resourcemon.EvictionTarget) error {
	if s.store == nil {
		return fmt.Errorf("eviction delivery store unavailable")
	}
	runtime, err := s.evictionWorkspaceRuntimeSnapshot(target.WorkspaceID)
	if err != nil {
		return err
	}
	if err := s.writeWorkspaceMetadata(runtime); err != nil {
		return err
	}
	delivery := s.workspaceEvictionDelivery(resourcemon.EvictionResult{Target: target})
	if delivery.ProjectID == "" {
		return fmt.Errorf("workspace project identity unavailable; refusing eviction without a recoverable callback")
	}
	persistCtx, cancel := context.WithTimeout(ctx, s.config.EvictionResolveTimeout)
	defer cancel()
	applied, err := s.store.RecordWorkspaceEviction(persistCtx, delivery)
	if err != nil {
		return err
	}
	if !applied {
		return fmt.Errorf("eviction generation changed before stop intent")
	}
	return nil
}

// Reconcile a write-ahead intent after an interrupted/failed Docker stop. The
// durable generation and exact Docker ID protect a later workspace incarnation.
func (s *Server) reconcilePendingEvictionStop(ctx context.Context, delivery *persistence.EvictionDelivery) (bool, error) {
	if delivery.NodeID != strings.TrimSpace(s.config.NodeID) {
		return false, fmt.Errorf("eviction intent belongs to another node")
	}
	lock := s.workspaceLifecycleLock(delivery.WorkspaceID)
	if err := lock.Lock(ctx); err != nil {
		return false, err
	}
	defer lock.Unlock()
	meta, err := s.store.GetWorkspaceMetadata(delivery.WorkspaceID)
	if err != nil {
		return false, err
	}
	if meta == nil || meta.EvictionGeneration != delivery.Generation || !meta.Evicted {
		return true, nil // An explicit delete/restart superseded this intent.
	}
	currentID, err := s.latestEvictionContainer(ctx, meta.ContainerLabelVal)
	if err != nil {
		return false, err
	}
	if currentID != "" && !dockerContainerIdentityMatches(currentID, delivery.ContainerID) {
		return false, fmt.Errorf("pending eviction container no longer current")
	}
	if currentID != "" {
		if err := s.stopEvictionContainer(ctx, delivery.ContainerID); err != nil {
			return false, err
		}
	}
	delivery.ContainerStopped = true
	applied, err := s.store.RecordWorkspaceEviction(ctx, *delivery)
	if err != nil {
		return false, err
	}
	if !applied {
		return true, nil
	}
	s.finishLocalWorkspaceEviction(resourcemon.EvictionResult{
		Target: resourcemon.EvictionTarget{WorkspaceID: delivery.WorkspaceID, ContainerID: delivery.ContainerID,
			EvictionGeneration: delivery.Generation, Reason: resourcemon.EvictionReason(delivery.Reason)},
		ContainerStopped: true, SnapshotCaptured: delivery.SnapshotCaptured, CompletedAt: delivery.OccurredAt,
	})
	return false, nil
}

func (s *Server) notifyWorkspaceEvicted(ctx context.Context, result resourcemon.EvictionResult) error {
	if s.store == nil {
		return fmt.Errorf("eviction delivery store unavailable")
	}
	if !s.evictionDeliveryMu.TryLock() {
		return nil
	}
	defer s.evictionDeliveryMu.Unlock()
	id := persistence.EvictionDeliveryID(result.Target.WorkspaceID, result.Target.EvictionGeneration, result.Target.ContainerID)
	return s.deliverPendingWorkspaceEviction(ctx, id)
}

// retryPendingEvictionCallbacks delivers at most one due row per heartbeat.
// The TryLock caps delivery concurrency across heartbeats and immediate sends;
// the durable claim protects the row across restarts before any HTTP side effect.
func (s *Server) retryPendingEvictionCallbacks() {
	if s.store == nil || !s.evictionDeliveryMu.TryLock() {
		return
	}
	defer s.evictionDeliveryMu.Unlock()
	if err := s.deliverPendingWorkspaceEviction(context.Background(), ""); err != nil {
		slog.Warn("Workspace eviction callback remains queued", "error", err)
	}
}

func (s *Server) evictionDeliveryOperationTimeout() time.Duration {
	return s.config.HTTPCallbackTimeout + s.config.EvictionResolveTimeout +
		evictionDockerStopCommandTimeout(s.config.EvictionDockerStopTimeout) + s.config.EvictionDockerStopTimeout
}

func (s *Server) deliverPendingWorkspaceEviction(parent context.Context, id string) error {
	return s.deliverPendingWorkspaceEvictionAt(parent, id, time.Now().UTC())
}

func (s *Server) deliverPendingWorkspaceEvictionAt(parent context.Context, id string, now time.Time) error {
	if parent == nil {
		parent = context.Background()
	}
	if s.controlPlaneCallbacksStopped() {
		return nil
	} // Keep durable state for recovery.
	ctx, cancel := context.WithTimeout(parent, s.evictionDeliveryOperationTimeout())
	defer cancel()
	// One bounded cancellation watcher belongs to this attempt, never a retry
	// loop. Shutdown retains the claimed delivery until its next scheduled retry.
	go func() {
		select {
		case <-s.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	delivery, err := s.store.ClaimEvictionDelivery(ctx, id, now, s.config.EvictionDebounceWindow, s.config.EvictionCallbackRetryMaxInterval, s.evictionDeliveryOperationTimeout())
	if err != nil || delivery == nil {
		return err
	}
	if !delivery.ContainerStopped {
		obsolete, reconcileErr := s.reconcilePendingEvictionStop(ctx, delivery)
		if reconcileErr != nil {
			return reconcileErr
		}
		if obsolete {
			return s.store.CompleteEvictionDelivery(ctx, delivery.ID, delivery.Attempts, delivery.PayloadRevision)
		}
	}
	terminal, err := s.sendWorkspaceEvictionDelivery(ctx, *delivery)
	if err != nil {
		return err
	}
	if terminal {
		return s.store.CompleteEvictionDelivery(ctx, delivery.ID, delivery.Attempts, delivery.PayloadRevision)
	}
	return nil
}

func (s *Server) sendWorkspaceEvictionDelivery(ctx context.Context, delivery persistence.EvictionDelivery) (bool, error) {
	if strings.TrimSpace(s.config.ControlPlaneURL) == "" {
		return false, fmt.Errorf("control plane URL is not configured")
	}
	token := s.callbackTokenForWorkspace(delivery.WorkspaceID)
	if token == "" {
		return false, fmt.Errorf("workspace eviction callback token unavailable")
	}
	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/projects/" + url.PathEscape(delivery.ProjectID) +
		"/workspaces/" + url.PathEscape(delivery.WorkspaceID) + "/eviction"
	body := struct {
		NodeID             string `json:"nodeId"`
		WorkspaceID        string `json:"workspaceId"`
		Reason             string `json:"reason"`
		SnapshotCaptured   bool   `json:"snapshotCaptured"`
		ContainerStopped   bool   `json:"containerStopped"`
		EvictionGeneration string `json:"evictionGeneration,omitempty"`
	}{delivery.NodeID, delivery.WorkspaceID, delivery.Reason, delivery.SnapshotCaptured, delivery.ContainerStopped, delivery.Generation}
	payload, err := json.Marshal(body)
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	// Read only a bounded body and never retain it in SQLite or logs.
	_ = readBoundedResponseBody(resp.Body)
	if (resp.StatusCode >= 200 && resp.StatusCode < 300) || resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return true, nil
	}
	// Authentication may recover after node-token rotation. 409/429 and server
	// failures are also retryable; stale generations are explicitly 410 at API.
	return false, fmt.Errorf("workspace eviction callback returned HTTP %d", resp.StatusCode)
}
