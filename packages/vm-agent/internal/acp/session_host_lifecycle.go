package acp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	DefaultCredentialSyncInterval = 2 * time.Second
	DefaultCredentialSyncTimeout  = 10 * time.Second
)

func credentialContentHash(content string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(content)))
	return fmt.Sprintf("%x", sum)
}

// credSyncSnapshot holds credential metadata captured under the lock for
// safe use by syncCredentialOnStop after the lock is released.
type credSyncSnapshot struct {
	injectionMode string
	authFilePath  string
	credKind      string
	agentType     string
	previousHash  string
}

func (h *SessionHost) credentialSyncSnapshotLocked() credSyncSnapshot {
	h.credentialMu.RLock()
	baseline := h.credentialBaseline
	h.credentialMu.RUnlock()
	return credSyncSnapshot{
		injectionMode: h.credInjectionMode,
		authFilePath:  h.credAuthFilePath,
		credKind:      h.credKind,
		agentType:     h.agentType,
		previousHash:  credentialContentHash(baseline),
	}
}

func (h *SessionHost) setCredentialBaseline(content string) {
	h.credentialMu.Lock()
	h.credentialBaseline = strings.TrimSpace(content)
	h.credentialMu.Unlock()
}

func (h *SessionHost) currentCredential(cred *agentCredential) *agentCredential {
	if cred == nil || cred.credentialKind != "oauth-token" {
		return cred
	}
	h.credentialMu.RLock()
	baseline := h.credentialBaseline
	h.credentialMu.RUnlock()
	if baseline == "" {
		return cred
	}
	copy := *cred
	copy.credential = baseline
	return &copy
}

func (h *SessionHost) readCredentialFile(ctx context.Context, authFilePath string) (string, error) {
	containerID := ""
	if h.config.ContainerResolver != nil {
		resolved, err := h.config.ContainerResolver()
		if err != nil {
			return "", err
		}
		containerID = resolved
	}
	if h.config.CredentialFileReader != nil {
		return h.config.CredentialFileReader(ctx, containerID, authFilePath)
	}
	if containerID == "" {
		return "", fmt.Errorf("container resolver is not configured")
	}
	return readAuthFileFromContainer(ctx, containerID, h.config.ContainerUser, authFilePath)
}

func (h *SessionHost) startCredentialWatcher(snap credSyncSnapshot, initialCredential string) {
	if snap.injectionMode != "auth-file" || snap.agentType != "openai-codex" ||
		h.config.CredentialSyncer == nil {
		return
	}
	if h.credentialWatchCancel != nil {
		h.credentialWatchCancel()
	}
	watchCtx, cancel := context.WithCancel(h.ctx)
	h.credentialWatchCancel = cancel
	interval := h.config.CredentialSyncInterval
	if interval <= 0 {
		interval = DefaultCredentialSyncInterval
	}
	baseline := strings.TrimSpace(initialCredential)
	h.setCredentialBaseline(baseline)
	go h.watchCredentialChanges(watchCtx, snap, baseline, interval)
}

func (h *SessionHost) watchCredentialChanges(ctx context.Context, snap credSyncSnapshot, baseline string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			timeout := h.config.CredentialSyncTimeout
			if timeout <= 0 {
				timeout = DefaultCredentialSyncTimeout
			}
			readCtx, cancel := context.WithTimeout(ctx, timeout)
			content, err := h.readCredentialFile(readCtx, snap.authFilePath)
			cancel()
			if err != nil {
				slog.Warn("Credential rotation check failed", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
				continue
			}
			content = strings.TrimSpace(content)
			if content == "" || content == baseline || !json.Valid([]byte(content)) {
				continue
			}
			syncCtx, syncCancel := context.WithTimeout(ctx, timeout)
			if rotationSyncer, ok := h.config.CredentialSyncer.(CredentialRotationSyncer); ok {
				err = rotationSyncer.SyncCredentialRotation(
					syncCtx,
					h.config.WorkspaceID,
					snap.agentType,
					snap.credKind,
					content,
					credentialContentHash(baseline),
				)
			} else {
				err = h.config.CredentialSyncer.SyncCredential(syncCtx, h.config.WorkspaceID, snap.agentType, snap.credKind, content)
			}
			syncCancel()
			if err != nil {
				if errors.Is(err, ErrCredentialSuperseded) {
					baseline = content
					slog.Warn("Active credential rotation was superseded", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
					continue
				}
				slog.Warn("Active credential sync failed", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
				continue
			}
			baseline = content
			h.setCredentialBaseline(content)
			slog.Info("Active credential rotation synced", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
		}
	}
}

// syncCredentialOnStop reads the auth file from the container (if the agent
// used file-based injection) and syncs any refreshed tokens back to the
// control plane. This must be called AFTER the agent process exits but BEFORE
// the container is removed. Best-effort: errors are logged, not returned.
//
// The snap parameter must be captured under h.mu before unlocking, to avoid
// a data race with concurrent agent restarts.
func (h *SessionHost) syncCredentialOnStop(snap credSyncSnapshot) {
	if snap.injectionMode != "auth-file" || h.config.CredentialSyncer == nil {
		return
	}

	// Use a short timeout — the container is about to be stopped/removed.
	// This budget is shared between docker exec and the HTTP callback retry.
	timeout := h.config.CredentialSyncTimeout
	if timeout <= 0 {
		timeout = DefaultCredentialSyncTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	content, err := h.readCredentialFile(ctx, snap.authFilePath)
	if err != nil {
		slog.Warn("Failed to read credential file for sync-back", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
		return
	}

	content = strings.TrimSpace(content)
	if content == "" {
		slog.Debug("Credential file is empty, skipping sync-back", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
		return
	}

	var syncErr error
	if rotationSyncer, ok := h.config.CredentialSyncer.(CredentialRotationSyncer); ok {
		syncErr = rotationSyncer.SyncCredentialRotation(ctx, h.config.WorkspaceID, snap.agentType, snap.credKind, content, snap.previousHash)
	} else {
		syncErr = h.config.CredentialSyncer.SyncCredential(ctx, h.config.WorkspaceID, snap.agentType, snap.credKind, content)
	}
	if syncErr != nil {
		if errors.Is(syncErr, ErrCredentialSuperseded) {
			slog.Warn("Final credential rotation was superseded", "agentType", snap.agentType, "workspaceId", h.config.WorkspaceID)
			return
		}
		slog.Warn("Failed to sync credential back to control plane",
			"agentType", snap.agentType,
			"workspaceId", h.config.WorkspaceID,
		)
		return
	}

	slog.Info("Synced refreshed credential back to control plane",
		"agentType", snap.agentType,
		"workspaceId", h.config.WorkspaceID,
	)
}

// Suspend stops the agent process and releases in-memory resources while
// preserving the AcpSessionID for later resumption via LoadSession.
// Unlike Stop(), the session is NOT marked as stopped — it enters a
// "suspended" state where the process is freed but context is recoverable.
//
// Returns the preserved AcpSessionID and agent type for the caller to
// use when transitioning the session status.
func (h *SessionHost) Suspend() (acpSessionID string, agentType string) {
	h.mu.Lock()
	if h.status == HostStopped {
		h.mu.Unlock()
		return "", ""
	}

	// Capture the session state we need to preserve before stopping.
	acpSessionID = string(h.sessionID)
	agentType = h.agentType

	// Mark the host as stopped so no further operations occur.
	h.status = HostStopped
	h.statusErr = ""
	// Snapshot credential metadata while still holding the lock.
	snap := h.credentialSyncSnapshotLocked()

	// Stop the agent process only after capturing the metadata; stopping clears it.
	h.stopCurrentAgentLocked()
	h.mu.Unlock()

	// Sync refreshed credentials back to the control plane before cleanup.
	h.syncCredentialOnStop(snap)

	// Report idle to the control plane so the browser status bar clears.
	h.reportActivity("idle")

	h.cancel()

	h.reportLifecycle("info", "SessionHost suspended", map[string]interface{}{
		"sessionId":    h.config.SessionID,
		"acpSessionId": acpSessionID,
		"agentType":    agentType,
	})

	// Disconnect all viewers with a specific close reason.
	h.viewerMu.Lock()
	for id, viewer := range h.viewers {
		viewer.once.Do(func() { close(viewer.done) })
		_ = viewer.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "session suspended"),
			time.Now().Add(5*time.Second),
		)
		_ = viewer.conn.Close()
		delete(h.viewers, id)
	}
	h.viewerMu.Unlock()

	return acpSessionID, agentType
}
