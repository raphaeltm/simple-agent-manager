package acp

import acpsdk "github.com/coder/acp-go-sdk"

// IsPrompting returns true if a prompt is currently in flight.
// Used by the auto-suspend timer to avoid interrupting active work.
func (h *SessionHost) IsPrompting() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status == HostPrompting
}

func (h *SessionHost) isPromptingOrRecovering() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.status == HostPrompting || h.status == HostStarting || h.crashRecoveryInProgress || h.hasSecretExecutionWork()
}

// OnPromptCompleteCallback returns the OnPromptComplete callback, if configured.
// Used by server-initiated prompt flows to report agent start failures back to
// the control plane without going through HandlePrompt.
func (h *SessionHost) OnPromptCompleteCallback() func(string, error) {
	return h.config.OnPromptComplete
}

// setSessionIDLocked assigns the ACP session ID and its lock-free mirror.
// Callers must hold h.mu for write.
func (h *SessionHost) setSessionIDLocked(id acpsdk.SessionId) {
	h.sessionID = id
	h.mirrorSessionID.Store(string(id))
}

// setStatusLocked assigns the host status and its lock-free mirror.
// Callers must hold h.mu for write.
func (h *SessionHost) setStatusLocked(status SessionHostStatus) {
	h.status = status
	h.mirrorStatus.Store(status)
}

// loadMirroredSessionID reads the session ID WITHOUT taking h.mu. Safe to call
// from the ACP notification-processing goroutine.
func (h *SessionHost) loadMirroredSessionID() string {
	if v, ok := h.mirrorSessionID.Load().(string); ok {
		return v
	}
	return ""
}

// loadMirroredStatus reads the host status WITHOUT taking h.mu. Safe to call
// from the ACP notification-processing goroutine.
func (h *SessionHost) loadMirroredStatus() SessionHostStatus {
	if v, ok := h.mirrorStatus.Load().(SessionHostStatus); ok {
		return v
	}
	return HostIdle
}

// SecretExecutionContext returns the live process container and configured session
// identity without resolving/recreating a container or waking the session.
func (h *SessionHost) SecretExecutionContext() (containerID, user, workDir string, active bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.secretExecContainerID, h.config.ContainerUser, h.config.ContainerWorkDir, h.process != nil
}
