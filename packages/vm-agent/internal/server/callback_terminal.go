package server

import (
	"log/slog"
	"net/http"

	"github.com/workspace/vm-agent/internal/messagereport"
)

const terminalControlPlaneCallbackReason = "control plane returned terminal callback status"

// callbackScope names the resource a control-plane callback addresses.
//
// The control plane returns the same terminal statuses (401/403/404/410) at two
// very different scopes, and only one of them says anything about this node:
//
//   - node scope — "this node row is deleted/destroyed/stopped". Callbacks
//     addressed at /api/nodes/:id/... can only fail terminally for this reason
//     (apps/api/src/routes/node-lifecycle.ts `rejectTerminalNodeCallback`).
//   - resource scope — "this task's / workspace's / project's callback resource
//     moved on". Routine on a healthy node: a cancelled task trips the workspace
//     compare-and-swap fence (apps/api/src/routes/workspaces/_helpers.ts), and a
//     single deleted workspace trips the ACP heartbeat's terminal response
//     (apps/api/src/routes/projects/node-acp-heartbeat.ts).
//
// Only node scope may shut down node-wide callback state. Treating a
// resource-scoped terminal status as proof the node is gone is the defect in
// `.claude/rules/75-terminal-signals-must-match-their-resource-scope.md`: it
// silently killed the heartbeat and every co-tenant workspace's message reporter
// on a node that was still doing real work.
type callbackScope int

const (
	// callbackScopeNode is for callbacks whose addressed resource IS this node.
	// A terminal status here means the node is gone, so it may latch.
	callbackScopeNode callbackScope = iota
	// callbackScopeResource is for callbacks addressed at a task, workspace, or
	// project. A terminal status here is scoped to that resource and MUST NOT
	// latch node-wide state, however plausible it looks.
	callbackScopeResource
)

func (s callbackScope) String() string {
	if s == callbackScopeNode {
		return "node"
	}
	return "resource"
}

func isTerminalControlPlaneCallbackStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusGone:
		return true
	default:
		return false
	}
}

func (s *Server) controlPlaneCallbacksStopped() bool {
	if s == nil {
		return true
	}
	return s.callbacksTerminal.Load()
}

// handleTerminalControlPlaneCallback is the single entry point for a terminal
// control-plane callback response. Every caller must state the scope of the
// resource its callback addressed; only callbackScopeNode latches node-wide.
//
// Resource-scoped callers get a bounded, below-error log and nothing else
// (`packages/vm-agent/.claude/rules/34-vm-agent-callback-auth.md`, item 3). That
// is sufficient because none of them retry: postTaskCallback is fire-and-forget,
// and the ACP heartbeat re-runs on its own ticker. A genuinely deleted node is
// still caught promptly by the node heartbeat, which runs on the same cadence
// with the same token and does hold latch authority.
func (s *Server) handleTerminalControlPlaneCallback(
	operation string,
	scope callbackScope,
	statusCode int,
	responseBody string,
	extraAttrs ...any,
) {
	if s == nil {
		return
	}

	if scope != callbackScopeNode {
		attrs := []any{
			"operation", operation,
			"scope", scope.String(),
			"statusCode", statusCode,
			"responseBody", responseBody,
			"action", "logged_not_latched",
		}
		slog.Info(
			"resource-scoped control-plane callback returned terminal status; node callbacks continue",
			append(attrs, extraAttrs...)...,
		)
		return
	}

	s.markControlPlaneCallbacksTerminal(operation, statusCode, responseBody, extraAttrs...)
}

// markControlPlaneCallbacksTerminal permanently stops every control-plane
// callback on this node: the node heartbeat, the ACP heartbeat, all message
// reporters, and the error reporter.
//
// Do NOT call this directly. Go through handleTerminalControlPlaneCallback so
// the caller is forced to declare its callback scope — this is a node-wide kill
// switch and a resource-scoped caller must never reach it.
func (s *Server) markControlPlaneCallbacksTerminal(
	operation string,
	statusCode int,
	responseBody string,
	extraAttrs ...any,
) {
	if s == nil {
		return
	}
	if !s.callbacksTerminal.CompareAndSwap(false, true) {
		return
	}

	attrs := []any{
		"operation", operation,
		"scope", callbackScopeNode.String(),
		"statusCode", statusCode,
		"responseBody", responseBody,
	}
	slog.Warn(
		"control-plane callbacks returned terminal status; stopping callback retries",
		append(attrs, extraAttrs...)...,
	)
	if s.errorReporter != nil {
		s.errorReporter.MarkTerminal(terminalControlPlaneCallbackReason)
	}
	s.disableMessageReportersForTerminalCallbacks(operation, statusCode)
}

func (s *Server) disableMessageReportersForTerminalCallbacks(operation string, statusCode int) {
	s.messageReportersMu.RLock()
	reporters := make(map[string]*messagereport.Reporter, len(s.messageReporters))
	for workspaceID, reporter := range s.messageReporters {
		reporters[workspaceID] = reporter
	}
	s.messageReportersMu.RUnlock()

	for workspaceID, reporter := range reporters {
		reporter.MarkTerminal(terminalControlPlaneCallbackReason)
		slog.Warn("message reporter disabled after terminal control-plane callback",
			"workspaceId", workspaceID,
			"operation", operation,
			"statusCode", statusCode,
		)
	}
}
