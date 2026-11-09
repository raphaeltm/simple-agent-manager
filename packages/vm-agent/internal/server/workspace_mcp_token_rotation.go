package server

// SAM MCP token rotation after a workspace callback generation rotation.
//
// When the control plane reactivates a workspace ID (VM restart or rebuild) it
// rotates the workspace's callback generation, which revokes every credential of
// the previous runtime, including the per-session sam-mcp tokens. The restart or
// rebuild request carries the new workspace callback token
// (workspace_reprovision.go). Before provisioning continues, the agent swaps each
// session's sam-mcp token for one of the new generation through
// POST /api/workspaces/:id/mcp-token/rotate, authenticated with the new
// workspace callback token and naming the old MCP token in the body.
//
// Sessions are found in both places the agent keeps them: the in-memory map
// (sessions with a live or recently created SessionHost) and SQLite (sessions
// that survived an agent restart). A rotated list is re-registered, which
// persists it, and is handed to a live SessionHost through SetMcpServers.
//
// Live SessionHosts: a rebuild runs from running/recovery/error and reuses an
// already running devcontainer ("Devcontainer already running"), and restart
// from error can find hosts left by a failed rebuild. An agent process keeps the
// credentials it started with, all revoked, so after this rotation the
// provisioning goroutine restarts every running agent process of the workspace
// in place (restartSessionAgentsForWorkspace). The SessionHosts stay registered
// (the control plane's task-liveness probe fails a task whose agent host is
// stopped), and each replacement process reads the rotated list installed here
// through SetMcpServers. A host created while the rotation is in flight gets the
// rotated list through SetMcpServers too. An agent that host starts inside the
// window, after the restart pass, keeps the revoked sam-mcp token (MCP calls
// fail with 401) until it restarts; it holds the new callback token, so it is
// not a retired-runtime process.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"sort"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
)

// mcpTokenRotationResponseMaxBytes bounds how much of a rotation response is read.
const mcpTokenRotationResponseMaxBytes = 16 * 1024

type mcpTokenRotationOutcome int

const (
	mcpTokenRotated mcpTokenRotationOutcome = iota
	mcpTokenRotationRefused
	mcpTokenRotationTransientFailure
)

// rotateWorkspaceSamMcpTokens rotates every sam-mcp token of the workspace's
// sessions. It runs synchronously, first thing in the provisioning goroutine and
// before restartSessionAgentsForWorkspace, under its own
// context.Background()-derived budget: never the request context, which ends
// when the 202 is written (rule 71).
func (s *Server) rotateWorkspaceSamMcpTokens(workspaceID, callbackToken string) {
	callbackToken = strings.TrimSpace(callbackToken)
	if s.config == nil || s.config.ControlPlaneURL == "" || callbackToken == "" || s.controlPlaneCallbacksStopped() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(),
		positiveDurationOrDefault(s.config.McpTokenRotationBudget, config.DefaultMcpTokenRotationBudget))
	defer cancel()

	sessions := s.workspaceSessionMcpServers(workspaceID)
	sessionIDs := make([]string, 0, len(sessions))
	for sessionID := range sessions {
		sessionIDs = append(sessionIDs, sessionID)
	}
	sort.Strings(sessionIDs)

	rotated := 0
	for _, sessionID := range sessionIDs {
		entries := sessions[sessionID]
		index := samMcpServerIndex(entries)
		if index < 0 {
			continue
		}
		previous := entries[index].Token
		token, ok := s.rotateSamMcpToken(ctx, workspaceID, sessionID, callbackToken, previous)
		if !ok {
			continue
		}
		entries[index].Token = token
		if s.installRotatedSessionMcpServers(workspaceID, sessionID, previous, entries) {
			rotated++
		}
	}
	if rotated > 0 {
		slog.Info("Rotated SAM MCP tokens for the new workspace callback generation",
			"workspace", workspaceID, "sessions", rotated)
	}
}

// samMcpServerIndex returns the index of SAM's own MCP server with a token, or
// -1. It uses the agent-visible name resolution, so only the reserved entry at
// index 0 (named or, from an old control plane, the sole unnamed entry) counts:
// a third-party entry claiming the name is never sent to the control plane.
func samMcpServerIndex(entries []acp.McpServerEntry) int {
	for i, name := range acp.ResolveMcpServerNames(entries) {
		if name == acp.SamMcpServerName && strings.TrimSpace(entries[i].Token) != "" {
			return i
		}
	}
	return -1
}

// workspaceSessionMcpServers collects the workspace's session MCP lists from
// SQLite and from memory; memory wins where both have a session. Lists are
// copied so the caller can change tokens without touching shared state.
func (s *Server) workspaceSessionMcpServers(workspaceID string) map[string][]acp.McpServerEntry {
	sessions := map[string][]acp.McpServerEntry{}
	if s.store != nil {
		persisted, err := s.store.ListWorkspaceSessionMcpServers(workspaceID)
		if err != nil {
			slog.Warn("Failed to read persisted MCP servers for token rotation",
				"workspace", workspaceID, "error", err)
		}
		for sessionID, servers := range persisted {
			sessions[sessionID] = fromPersistedMcpServers(servers)
		}
	}
	prefix := workspaceID + ":"
	s.sessionHostMu.Lock()
	for key, entries := range s.sessionMcpServers {
		if sessionID, ok := strings.CutPrefix(key, prefix); ok {
			sessions[sessionID] = append([]acp.McpServerEntry(nil), entries...)
		}
	}
	s.sessionHostMu.Unlock()
	return sessions
}

// installRotatedSessionMcpServers stores a rotated list unless the session's
// in-memory list changed while the rotation was in flight (a newer registration
// wins), updates a live SessionHost in the same critical section that host
// creation reads the map under, and then persists.
func (s *Server) installRotatedSessionMcpServers(workspaceID, sessionID, previousToken string, entries []acp.McpServerEntry) bool {
	hostKey := workspaceID + ":" + sessionID
	s.sessionHostMu.Lock()
	if current, ok := s.sessionMcpServers[hostKey]; ok {
		if index := samMcpServerIndex(current); index < 0 || current[index].Token != previousToken {
			s.sessionHostMu.Unlock()
			slog.Info("Discarded rotated SAM MCP token; the session's MCP servers changed during rotation",
				"workspace", workspaceID, "session", sessionID)
			return false
		}
	}
	if s.sessionMcpServers == nil {
		s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	}
	s.sessionMcpServers[hostKey] = entries
	if host := s.sessionHosts[hostKey]; host != nil {
		host.SetMcpServers(entries)
	}
	s.sessionHostMu.Unlock()
	s.persistSessionMcpServers(workspaceID, sessionID, entries)
	return true
}

// rotateSamMcpToken asks the control plane for a new-generation sam-mcp token,
// retrying transient failures with a doubling delay within the attempt limit and
// the pass's budget. Logs never contain token values.
func (s *Server) rotateSamMcpToken(ctx context.Context, workspaceID, sessionID, callbackToken, mcpToken string) (string, bool) {
	delay := positiveDurationOrDefault(s.config.McpTokenRotationRetryDelay, config.DefaultMcpTokenRotationRetryDelay)
	maxAttempts := s.config.McpTokenRotationMaxAttempts
	if maxAttempts < 1 {
		maxAttempts = config.DefaultMcpTokenRotationMaxAttempts
	}
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			slog.Warn("SAM MCP token rotation budget exhausted; session keeps its revoked token",
				"workspace", workspaceID, "session", sessionID)
			return "", false
		}
		outcome, token, detail := s.requestSamMcpTokenRotation(ctx, workspaceID, callbackToken, mcpToken)
		switch outcome {
		case mcpTokenRotated:
			return token, true
		case mcpTokenRotationRefused:
			slog.Warn("Control plane refused SAM MCP token rotation",
				"workspace", workspaceID, "session", sessionID, "detail", detail)
			return "", false
		}
		if attempt >= maxAttempts {
			slog.Warn("SAM MCP token rotation failed; attempts exhausted",
				"workspace", workspaceID, "session", sessionID, "attempts", attempt, "detail", detail)
			return "", false
		}
		slog.Warn("SAM MCP token rotation failed; will retry",
			"workspace", workspaceID, "session", sessionID, "attempt", attempt, "detail", detail, "retryIn", delay.String())
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		delay *= 2
	}
}

// requestSamMcpTokenRotation performs one rotation request. detail is a
// status/code summary for logs and never contains a token.
func (s *Server) requestSamMcpTokenRotation(ctx context.Context, workspaceID, callbackToken, mcpToken string) (outcome mcpTokenRotationOutcome, token string, detail string) {
	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") +
		"/api/workspaces/" + neturl.PathEscape(workspaceID) + "/mcp-token/rotate"
	body, err := json.Marshal(map[string]string{"mcpToken": mcpToken})
	if err != nil {
		return mcpTokenRotationTransientFailure, "", "marshal request: " + err.Error()
	}
	timeout := positiveDurationOrDefault(s.config.McpTokenRotationTimeout, config.DefaultMcpTokenRotationTimeout)
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return mcpTokenRotationTransientFailure, "", "build request: " + err.Error()
	}
	req.Header.Set("Authorization", "Bearer "+callbackToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.controlPlaneHTTPClient(timeout).Do(req)
	if err != nil {
		return mcpTokenRotationTransientFailure, "", "request failed: " + err.Error()
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, mcpTokenRotationResponseMaxBytes))

	var parsed struct {
		Token string `json:"token"`
		Error string `json:"error"`
	}
	parseErr := json.Unmarshal(payload, &parsed)
	detail = "status " + resp.Status
	if parsed.Error != "" {
		detail += " " + parsed.Error
	}
	token = strings.TrimSpace(parsed.Token)
	return classifySamMcpTokenRotation(resp.StatusCode, token, parseErr), token, detail
}

func classifySamMcpTokenRotation(status int, token string, parseErr error) mcpTokenRotationOutcome {
	switch {
	case status == http.StatusOK && parseErr == nil && token != "":
		return mcpTokenRotated
	case status == http.StatusOK:
		return mcpTokenRotationTransientFailure // malformed success body
	case status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= 500:
		return mcpTokenRotationTransientFailure
	case status >= 400:
		// 401/403/404/410: the callback token or MCP token was refused, or the
		// session is gone; other 4xx can never succeed either. Stop (rule 54.13).
		return mcpTokenRotationRefused
	default:
		return mcpTokenRotationTransientFailure
	}
}

// positiveDurationOrDefault keeps a hand-built or zero-valued config from turning
// the rotation into a no-op (a zero budget would expire before the first request).
func positiveDurationOrDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
