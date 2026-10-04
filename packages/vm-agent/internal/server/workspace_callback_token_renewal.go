package server

// Workspace callback token renewal and propagation.
//
// The control plane mints each workspace a workspace-scoped callback token
// (CALLBACK_TOKEN_EXPIRY_MS, default 24h) when it creates or restores the
// workspace. Every workspace callback authenticates with it: messages, snapshot
// prepare/progress/complete/failure, git-token, runtime-assets, task status,
// ACP activity/usage/interactions and more. A workspace awake longer than the
// lifetime used to fail all of them with 401.
//
// Two paths keep runtime.CallbackToken fresh, and every change is persisted and
// then propagated to the consumers that copied it (message reporter, SessionHosts):
//
//  1. Renewal. After each successful node heartbeat, every token past
//     WorkspaceCallbackTokenRefreshRatio of its lifetime is renewed through
//     POST /api/workspaces/:id/callback-token/renew, presenting the current
//     workspace token AND this node's token. The control plane renews only for
//     the node it binds the workspace to, and never renews an expired token.
//  2. Control-plane delivery. Requests the control plane sends over the
//     node-management channel (create, restore, and VM hibernate) carry a fresh
//     token; upsertWorkspaceRuntime adopts it (adoptWorkspaceCallbackTokenLocked).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/messagereport"
)

// renewalResponseMaxBytes bounds how much of a renewal response is read.
const renewalResponseMaxBytes = 16 * 1024

var errMessagePersistencePaused = errors.New(
	"chat message persistence paused: the control plane rejected the workspace callback token and no replacement arrived")

// Node-credential error codes from the control plane. The node token refreshes
// through the heartbeat, so these are retried; they say nothing about the
// workspace token (apps/api/src/services/workspace-callback-token-renewal.ts).
const (
	renewalNodeCallbackUnauthorized = "NODE_CALLBACK_UNAUTHORIZED"
	renewalNodeCallbackForbidden    = "NODE_CALLBACK_FORBIDDEN"
)

// workspaceTokenRenewal is the renewal bookkeeping on Server.
type workspaceTokenRenewal struct {
	running sync.Mutex // one renewal pass at a time (TryLock from the heartbeat)
	mu      sync.Mutex
	state   map[string]workspaceTokenRenewalState // keyed by workspace ID
	now     func() time.Time                      // test clock; nil means time.Now
}

// workspaceTokenRenewalState is keyed to the token it describes: when the
// workspace's token changes (renewal or control-plane delivery) the state no
// longer applies, so a new token is never blocked by an old token's latch or
// backoff.
type workspaceTokenRenewalState struct {
	token       string
	rejected    bool      // the control plane refused this token; never present it again
	nextAttempt time.Time // earliest next attempt after a transient failure
	failures    int       // consecutive transient failures, for backoff
}

type workspaceTokenRenewalCandidate struct {
	workspaceID string
	token       string
}

type workspaceTokenRenewalOutcome int

const (
	renewalSucceeded workspaceTokenRenewalOutcome = iota
	renewalNotDue
	renewalRejected
	renewalTransientFailure
)

func (s *Server) workspaceTokenRenewalNow() time.Time {
	if now := s.tokenRenewal.now; now != nil {
		return now()
	}
	return time.Now()
}

// renewDueWorkspaceCallbackTokensOnce runs one renewal pass unless one is
// already running. Called in its own goroutine after a successful heartbeat.
func (s *Server) renewDueWorkspaceCallbackTokensOnce() {
	if !s.tokenRenewal.running.TryLock() {
		return
	}
	defer s.tokenRenewal.running.Unlock()
	s.renewDueWorkspaceCallbackTokens()
}

func (s *Server) renewDueWorkspaceCallbackTokens() {
	if s.controlPlaneCallbacksStopped() || s.config == nil ||
		s.config.ControlPlaneURL == "" || s.config.NodeID == "" {
		return
	}
	nodeToken := strings.TrimSpace(s.getCallbackToken())
	if nodeToken == "" {
		return
	}
	for _, candidate := range s.dueWorkspaceCallbackTokenRenewals(s.workspaceTokenRenewalNow()) {
		s.renewWorkspaceCallbackToken(candidate, nodeToken)
	}
}

// dueWorkspaceCallbackTokenRenewals lists workspaces whose current token is due:
// past the refresh ratio, not refused by the control plane, and not backing off.
// An expired token is still offered once; the control plane, not this clock,
// decides it is expired, so agent clock skew cannot strand a valid token.
func (s *Server) dueWorkspaceCallbackTokenRenewals(now time.Time) []workspaceTokenRenewalCandidate {
	s.workspaceMu.RLock()
	tokens := make(map[string]string, len(s.workspaces))
	for id, runtime := range s.workspaces {
		if token := strings.TrimSpace(runtime.CallbackToken); token != "" {
			tokens[id] = token
		}
	}
	s.workspaceMu.RUnlock()

	ratio := s.config.WorkspaceCallbackTokenRefreshRatio
	s.tokenRenewal.mu.Lock()
	defer s.tokenRenewal.mu.Unlock()
	if s.tokenRenewal.state == nil {
		s.tokenRenewal.state = make(map[string]workspaceTokenRenewalState)
	}
	for id, state := range s.tokenRenewal.state {
		if tokens[id] != state.token {
			delete(s.tokenRenewal.state, id) // workspace gone or token replaced
		}
	}
	due := make([]workspaceTokenRenewalCandidate, 0, len(tokens))
	for id, token := range tokens {
		state := s.tokenRenewal.state[id]
		if state.rejected || now.Before(state.nextAttempt) {
			continue
		}
		if callbackTokenRenewalDue(token, now, ratio) {
			due = append(due, workspaceTokenRenewalCandidate{workspaceID: id, token: token})
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i].workspaceID < due[j].workspaceID })
	return due
}

// callbackTokenRenewalDue reports whether now is at least ratio of the way
// through the token's iat→exp lifetime. A token whose claims cannot be read is
// offered once so the control plane can classify it.
func callbackTokenRenewalDue(token string, now time.Time, ratio float64) bool {
	issuedAt, expiresAt, ok := callbackTokenLifetime(token)
	if !ok {
		return true
	}
	lifetime := expiresAt.Sub(issuedAt)
	return !now.Before(issuedAt.Add(time.Duration(float64(lifetime) * ratio)))
}

// callbackTokenLifetime reads iat/exp WITHOUT verifying the signature. It only
// schedules renewal; the control plane verifies every token it receives.
func callbackTokenLifetime(token string) (issuedAt, expiresAt time.Time, ok bool) {
	claims := jwt.RegisteredClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(token, &claims); err != nil {
		return time.Time{}, time.Time{}, false
	}
	if claims.IssuedAt == nil || claims.ExpiresAt == nil || !claims.ExpiresAt.After(claims.IssuedAt.Time) {
		return time.Time{}, time.Time{}, false
	}
	return claims.IssuedAt.Time, claims.ExpiresAt.Time, true
}

func (s *Server) renewWorkspaceCallbackToken(candidate workspaceTokenRenewalCandidate, nodeToken string) {
	outcome, renewed, detail := s.requestWorkspaceCallbackTokenRenewal(candidate, nodeToken)
	now := s.workspaceTokenRenewalNow()
	switch outcome {
	case renewalSucceeded:
		if s.replaceRenewedWorkspaceCallbackToken(candidate.workspaceID, candidate.token, renewed) {
			slog.Info("Workspace callback token renewed", "workspace", candidate.workspaceID)
		} else {
			slog.Info("Discarded renewed workspace callback token; the workspace token changed during renewal",
				"workspace", candidate.workspaceID)
		}
		s.setWorkspaceTokenRenewalState(candidate.workspaceID, workspaceTokenRenewalState{})
	case renewalNotDue:
		s.setWorkspaceTokenRenewalState(candidate.workspaceID, workspaceTokenRenewalState{
			token:       candidate.token,
			nextAttempt: now.Add(s.config.WorkspaceCallbackTokenRenewalRetryMax),
		})
	case renewalRejected:
		slog.Warn("Control plane refused workspace callback token renewal; waiting for a new token",
			"workspace", candidate.workspaceID, "detail", detail)
		s.setWorkspaceTokenRenewalState(candidate.workspaceID, workspaceTokenRenewalState{
			token:    candidate.token,
			rejected: true,
		})
	default:
		failures := s.workspaceTokenRenewalFailures(candidate.workspaceID, candidate.token) + 1
		delay := workspaceTokenRenewalBackoff(failures,
			s.config.WorkspaceCallbackTokenRenewalRetryInitial, s.config.WorkspaceCallbackTokenRenewalRetryMax)
		slog.Warn("Workspace callback token renewal failed; will retry",
			"workspace", candidate.workspaceID, "detail", detail, "retryIn", delay.String())
		s.setWorkspaceTokenRenewalState(candidate.workspaceID, workspaceTokenRenewalState{
			token:       candidate.token,
			failures:    failures,
			nextAttempt: now.Add(delay),
		})
	}
}

func workspaceTokenRenewalBackoff(failures int, initial, max time.Duration) time.Duration {
	delay := initial
	for i := 1; i < failures && delay < max; i++ {
		delay *= 2
	}
	if delay > max {
		return max
	}
	return delay
}

func (s *Server) workspaceTokenRenewalFailures(workspaceID, token string) int {
	s.tokenRenewal.mu.Lock()
	defer s.tokenRenewal.mu.Unlock()
	if state, ok := s.tokenRenewal.state[workspaceID]; ok && state.token == token {
		return state.failures
	}
	return 0
}

func (s *Server) setWorkspaceTokenRenewalState(workspaceID string, state workspaceTokenRenewalState) {
	s.tokenRenewal.mu.Lock()
	defer s.tokenRenewal.mu.Unlock()
	if s.tokenRenewal.state == nil {
		s.tokenRenewal.state = make(map[string]workspaceTokenRenewalState)
	}
	if state.token == "" {
		delete(s.tokenRenewal.state, workspaceID)
		return
	}
	s.tokenRenewal.state[workspaceID] = state
}

// requestWorkspaceCallbackTokenRenewal performs one renewal request. detail is a
// status/code summary for logs and never contains a token.
func (s *Server) requestWorkspaceCallbackTokenRenewal(
	candidate workspaceTokenRenewalCandidate,
	nodeToken string,
) (outcome workspaceTokenRenewalOutcome, renewed string, detail string) {
	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") +
		"/api/workspaces/" + neturl.PathEscape(candidate.workspaceID) + "/callback-token/renew"
	body, err := json.Marshal(map[string]string{"nodeId": s.config.NodeID, "nodeToken": nodeToken})
	if err != nil {
		return renewalTransientFailure, "", "marshal request: " + err.Error()
	}
	timeout := s.config.WorkspaceCallbackTokenRenewalTimeout
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return renewalTransientFailure, "", "build request: " + err.Error()
	}
	req.Header.Set("Authorization", "Bearer "+candidate.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.controlPlaneHTTPClient(timeout).Do(req)
	if err != nil {
		return renewalTransientFailure, "", "request failed: " + err.Error()
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, renewalResponseMaxBytes))

	var parsed struct {
		Renewed bool   `json:"renewed"`
		Token   string `json:"token"`
		Error   string `json:"error"`
	}
	parseErr := json.Unmarshal(payload, &parsed)
	detail = "status " + resp.Status
	if parsed.Error != "" {
		detail += " " + parsed.Error
	}
	return classifyWorkspaceTokenRenewal(resp.StatusCode, parsed.Renewed, parsed.Token, parsed.Error, parseErr), strings.TrimSpace(parsed.Token), detail
}

func classifyWorkspaceTokenRenewal(status int, renewed bool, token, errorCode string, parseErr error) workspaceTokenRenewalOutcome {
	switch {
	case status == http.StatusOK && parseErr == nil && renewed && strings.TrimSpace(token) != "":
		return renewalSucceeded
	case status == http.StatusOK && parseErr == nil && !renewed:
		return renewalNotDue
	case status == http.StatusOK:
		return renewalTransientFailure // malformed success body
	case errorCode == renewalNodeCallbackUnauthorized || errorCode == renewalNodeCallbackForbidden:
		return renewalTransientFailure // the node token, not the workspace token, was refused
	case status == http.StatusTooManyRequests || status >= 500:
		return renewalTransientFailure
	case status >= 400:
		// 400/401/403/404/410: the workspace token was refused, the workspace is
		// gone or no longer bound to this node, or the request can never succeed.
		// Stop presenting this token (rule 54.13); a new token resets the latch.
		return renewalRejected
	default:
		return renewalTransientFailure
	}
}

// replaceRenewedWorkspaceCallbackToken installs a renewed token only if the
// runtime still holds the token that was renewed. A token delivered by the
// control plane while the renewal was in flight is at least as fresh and wins.
// The token is persisted before any consumer sees it, so a restart can never
// resume with an older token than a consumer has already used.
func (s *Server) replaceRenewedWorkspaceCallbackToken(workspaceID, renewedFrom, renewed string) bool {
	renewed = strings.TrimSpace(renewed)
	s.workspaceMu.Lock()
	runtime, ok := s.workspaces[workspaceID]
	if !ok || renewed == "" || strings.TrimSpace(runtime.CallbackToken) != renewedFrom {
		s.workspaceMu.Unlock()
		return false
	}
	runtime.CallbackToken = renewed
	runtime.UpdatedAt = nowUTC()
	if runtime.Repository != "" && !runtime.MetadataUnavailable {
		s.persistWorkspaceMetadata(runtime)
	}
	s.workspaceMu.Unlock()
	s.propagateWorkspaceCallbackToken(workspaceID, renewed)
	return true
}

// adoptWorkspaceCallbackTokenLocked installs a token delivered for an existing
// workspace (create, restore, hibernate) unless it would replace the current
// token with one that expires earlier, so a reordered or late delivery never
// rolls a workspace back to an older credential. Caller holds workspaceMu and
// must persist and then propagate when it returns true.
func adoptWorkspaceCallbackTokenLocked(runtime *WorkspaceRuntime, delivered string) bool {
	delivered = strings.TrimSpace(delivered)
	current := strings.TrimSpace(runtime.CallbackToken)
	if delivered == "" || delivered == current {
		return false
	}
	if current != "" {
		_, deliveredExpiry, deliveredOK := callbackTokenLifetime(delivered)
		_, currentExpiry, currentOK := callbackTokenLifetime(current)
		if deliveredOK && currentOK && deliveredExpiry.Before(currentExpiry) {
			slog.Info("Ignoring delivered workspace callback token that expires before the current one",
				"workspace", runtime.ID)
			return false
		}
	}
	runtime.CallbackToken = delivered
	return true
}

// propagateWorkspaceCallbackToken hands a changed workspace token to every
// consumer that copied the previous one. The message reporter resumes held
// messages (messagereport/credential.go); SessionHosts use it for every later
// control-plane call. Hosts are found under sessionHostMu, which host creation
// also holds while it reads the token, so a host is either created with the new
// token or updated here. Callers must not hold workspaceMu, messageReportersMu
// or sessionHostMu.
func (s *Server) propagateWorkspaceCallbackToken(workspaceID, token string) {
	if strings.TrimSpace(token) == "" {
		return
	}
	s.messageReportersMu.RLock()
	reporter := s.messageReporters[workspaceID]
	s.messageReportersMu.RUnlock()
	reporter.SetToken(token)

	prefix := workspaceID + ":"
	s.sessionHostMu.Lock()
	for key, host := range s.sessionHosts {
		if strings.HasPrefix(key, prefix) && host != nil {
			host.SetCallbackToken(token)
		}
	}
	s.sessionHostMu.Unlock()
}

// reportMessagePersistencePaused surfaces a message reporter that has held chat
// messages for longer than MSG_AUTH_RENEWAL_WAIT because the control plane keeps
// rejecting the workspace token. The error reporter authenticates with the node
// token, so the report gets through while the workspace token is unusable.
func (s *Server) reportMessagePersistencePaused(info messagereport.AuthRenewalWaitExceeded) {
	if s == nil || s.errorReporter == nil {
		return
	}
	s.errorReporter.ReportError(errMessagePersistencePaused, "messagereport.credential_wait", info.WorkspaceID,
		map[string]interface{}{
			"sessionId":        info.SessionID,
			"heldMessages":     info.HeldMessages,
			"pausedForSeconds": int64(info.PausedFor / time.Second),
		})
}
