package server

import (
	"log/slog"
	"net/http"
	"os"
	"syscall"
	"time"
)

// selfRestartSignal ends this process through its normal SIGTERM shutdown path; systemd
// (Restart=always in the cloud-init unit) starts a fresh agent. Replaced in tests.
var selfRestartSignal = func() error { return syscall.Kill(os.Getpid(), syscall.SIGTERM) }

// handleRestartAgent serves POST /admin/restart-agent: an Operations-approved restart of this
// VM agent. Only a node-scoped management token may call it. Refused in standalone
// (cf-container) mode, where no supervisor would start the agent again.
//
// The signal runs on a resource-lifetime goroutine after the 202 is written, never on the
// request context, so the response reaches the control plane before the process exits
// (rule 71). Repeated requests while one is pending are idempotent.
func (s *Server) handleRestartAgent(w http.ResponseWriter, r *http.Request) {
	if !s.requireNodeEventAuth(w, r) {
		return
	}
	if s.config != nil && s.config.IsStandaloneMode() {
		writeError(w, http.StatusConflict, "agent restart is not supported in standalone mode")
		return
	}
	if !s.selfRestartRequested.CompareAndSwap(false, true) {
		writeJSON(w, http.StatusAccepted, map[string]interface{}{"accepted": true, "alreadyRequested": true})
		return
	}
	delay := time.Duration(0)
	if s.config != nil {
		delay = s.config.SelfRestartDelay
	}
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"accepted": true, "restartInMs": delay.Milliseconds()})
	go func() {
		time.Sleep(delay)
		slog.Warn("Operations-approved vm-agent restart: signalling self for a supervised restart")
		if err := selfRestartSignal(); err != nil {
			slog.Error("vm-agent self restart signal failed", "error", err)
			s.selfRestartRequested.Store(false)
		}
	}()
}
