package acp

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/workspace/vm-agent/internal/config"
)

// credSyncSnapshot holds credential metadata captured under the lock for
// safe use by syncCredentialOnStop after the lock is released.
type credSyncSnapshot struct {
	injectionMode string
	authFilePath  string
	credKind      string
	agentType     string
}

// lifecycleContext returns the context that lives for as long as this
// SessionHost does. It is created in NewSessionHost and cancelled only by
// Stop().
//
// Any work that OUTLIVES the request which started it must use this instead of
// the caller's context. The canonical case is monitorProcessExit: it is spawned
// during startup but drives agent restarts minutes or hours later, long after
// the HTTP snapshot-restore request or viewer WebSocket connection that started
// the agent has finished and had its context cancelled. See
// .claude/rules/71-request-context-must-not-outlive-its-request.md.
//
// This is the single accessor for the host lifetime; prefer it over reading
// h.ctx directly. Falls back to context.Background() for hosts built by struct
// literal in tests rather than NewSessionHost, so a long-lived goroutine can
// never receive nil.
func (h *SessionHost) lifecycleContext() context.Context {
	if h.ctx == nil {
		return context.Background()
	}
	return h.ctx
}

// restartAttemptTimeout bounds ONE process-monitor restart attempt. The monitor
// holds h.mu for the whole attempt and execInContainer has no timeout of its
// own, so without this a wedged container runtime would block Stop() forever.
// It is derived downward from lifecycleContext at the point of use and never
// handed to the replacement process's monitor.
func (h *SessionHost) restartAttemptTimeout() time.Duration {
	if h.config.RestartAttemptTimeout > 0 {
		return h.config.RestartAttemptTimeout
	}
	return config.DefaultACPRestartAttemptTimeout
}

func (h *SessionHost) credentialSyncTimeout() time.Duration {
	timeout := h.config.CredentialSyncTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return timeout
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

	if h.config.ContainerResolver == nil {
		slog.Warn("syncCredentialOnStop: no ContainerResolver configured, skipping sync")
		return
	}

	containerID, err := h.config.ContainerResolver()
	if err != nil {
		slog.Warn("Cannot sync credential: container not found", "error", err)
		return
	}

	// Use a short timeout — the container is about to be stopped/removed.
	// This budget is shared between docker exec and the HTTP callback retry.
	ctx, cancel := context.WithTimeout(context.Background(), h.credentialSyncTimeout())
	defer cancel()

	content, err := readAuthFileFromContainer(ctx, containerID, h.config.ContainerUser, snap.authFilePath)
	if err != nil {
		slog.Warn("Failed to read auth file for sync-back",
			"path", snap.authFilePath,
			"error", err,
		)
		return
	}

	content = strings.TrimSpace(content)
	if content == "" {
		slog.Debug("Auth file is empty, skipping sync-back", "path", snap.authFilePath)
		return
	}

	if err := h.config.CredentialSyncer.SyncCredential(
		ctx,
		h.config.WorkspaceID,
		snap.agentType,
		snap.credKind,
		content,
	); err != nil {
		slog.Warn("Failed to sync credential back to control plane",
			"agentType", snap.agentType,
			"error", err,
		)
		return
	}

	slog.Info("Synced refreshed credential back to control plane",
		"agentType", snap.agentType,
		"path", snap.authFilePath,
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

	// Stop the agent process to free resources.
	h.stopCurrentAgentLocked()

	// Mark the host as stopped so no further operations occur.
	h.setStatusLocked(HostStopped)
	h.statusErr = ""
	// Snapshot credential metadata while still holding the lock.
	snap := credSyncSnapshot{
		injectionMode: h.credInjectionMode,
		authFilePath:  h.credAuthFilePath,
		credKind:      h.credKind,
		agentType:     h.agentType,
	}
	h.mu.Unlock()

	// Sync refreshed credentials back to the control plane before cleanup.
	h.syncCredentialOnStop(snap)

	// Report idle to the control plane so the browser status bar clears.
	h.clearHarnessWork()
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
