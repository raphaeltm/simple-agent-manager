package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"fmt"
	"github.com/workspace/vm-agent/internal/config"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/gitrepo"
)

type gitTokenResponse struct {
	Provider  string `json:"provider,omitempty"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	// CloneURL is set for Artifacts-backed projects. Empty for GitHub projects.
	CloneURL       string `json:"cloneUrl,omitempty"`
	Host           string `json:"host,omitempty"`
	Username       string `json:"username,omitempty"`
	RepositoryPath string `json:"repositoryPath,omitempty"`
}

func (s *Server) handleGitCredential(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(s.routedWorkspaceID(r))
	}

	callbackToken, authorized := gitCredentialCallbackToken(s, r, workspaceID)
	if !authorized {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	requestedHost := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("host")))
	requestedPath := strings.TrimSpace(r.URL.Query().Get("path"))
	// GitLab-bound workspaces vend a broad user OAuth token, so the exchange is
	// fail-closed: the caller must identify both the host and the repository path
	// it is requesting credentials for. GitHub/Artifacts keep the empty-allow
	// behavior because the gh wrapper flow sends host=github.com with no path.
	boundProvider, _ := s.credentialPathBinding(workspaceID)
	// Hosted repository write credentials are never valid for a cleartext Git
	// request. Require the helper's explicit protocol before fetching a token.
	requestedProtocol := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("protocol")))
	if strings.EqualFold(boundProvider, "artifacts") && requestedProtocol != "https" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.EqualFold(boundProvider, "gitlab") && (requestedHost == "" || requestedPath == "") {
		slog.Warn("Git credential request refused: gitlab-bound workspace requires host and path",
			"workspaceID", workspaceID,
			"hasHost", requestedHost != "",
			"hasPath", requestedPath != "",
		)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if requestedHost != "" && !s.isAllowedCredentialHostForWorkspace(workspaceID, requestedHost) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if requestedPath != "" && !s.isAllowedCredentialPathForWorkspace(workspaceID, requestedPath) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	resp, err := s.fetchGitTokenResponseForWorkspace(r.Context(), workspaceID, callbackToken)
	if err != nil {
		slog.Error("Failed to fetch git token", "error", err)
		writeError(w, http.StatusBadGateway, "failed to fetch git token")
		return
	}

	// Determine host and username from clone URL (Artifacts) or default (GitHub).
	// Artifacts clone URLs use username "x"; GitHub uses "x-access-token".
	host := "github.com"
	username := "x-access-token"
	repositoryPath := strings.TrimSpace(resp.RepositoryPath)
	if resp.CloneURL != "" {
		if parsed, parseErr := url.Parse(resp.CloneURL); parseErr == nil && parsed.Host != "" {
			host = parsed.Host
			if gitrepo.IsArtifactsHost(parsed.Host) {
				username = "x"
			}
			if repositoryPath == "" {
				repositoryPath = strings.Trim(strings.TrimSuffix(parsed.Path, ".git"), "/")
			}
		}
	}
	if resp.Host != "" {
		host = strings.ToLower(strings.TrimSpace(resp.Host))
	}
	if resp.Username != "" {
		username = strings.TrimSpace(resp.Username)
	}

	// Response-side fail-closed gate for GitLab credentials: regardless of what
	// the local binding said pre-fetch, a GitLab token is only released when the
	// caller supplied a host and path AND both verifiably match the credential
	// the control plane resolved. An empty resolved repositoryPath means we
	// cannot verify the binding — refuse rather than vend a broad OAuth token.
	gitlabResponse := strings.EqualFold(strings.TrimSpace(resp.Provider), "gitlab")
	// The Artifacts callback predates provider tags: it returns cloneUrl while
	// GitHub omits it and GitLab identifies itself explicitly. Preserve this
	// legacy response contract when local provider metadata is unavailable.
	artifactsResponse := strings.EqualFold(strings.TrimSpace(resp.Provider), "artifacts") ||
		(strings.TrimSpace(resp.Provider) == "" && strings.TrimSpace(resp.CloneURL) != "")
	if artifactsResponse && requestedProtocol != "https" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if gitlabResponse && (requestedHost == "" || requestedPath == "" || repositoryPath == "") {
		slog.Warn("Git credential response withheld: gitlab credential requires verified host and path",
			"workspaceID", workspaceID,
			"hasRequestedHost", requestedHost != "",
			"hasRequestedPath", requestedPath != "",
			"hasResolvedPath", repositoryPath != "",
		)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	hostMatches := credentialHostMatchesRequest(host, requestedHost)
	if strings.EqualFold(boundProvider, "artifacts") && (resp.Provider == "" || strings.EqualFold(resp.Provider, "artifacts")) {
		hostMatches = requestedHost == "" || gitrepo.HTTPSAuthoritiesEqual(host, requestedHost)
	}
	if requestedHost != "" && !hostMatches {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if requestedPath != "" && repositoryPath != "" && !credentialPathMatchesRequest(repositoryPath, requestedPath) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "protocol=https\nhost=%s\nusername=%s\npassword=%s\n\n", host, username, resp.Token)
}

func credentialHostMatchesRequest(resolvedHost, requestedHost string) bool {
	resolvedHost = strings.ToLower(strings.TrimSpace(resolvedHost))
	requestedHost = strings.ToLower(strings.TrimSpace(requestedHost))
	if requestedHost == "" {
		return true
	}
	if gitrepo.IsGitHubCredentialHost(resolvedHost) {
		return gitrepo.IsGitHubCredentialHost(requestedHost)
	}
	if gitrepo.IsArtifactsHost(resolvedHost) {
		return requestedHost == resolvedHost
	}
	return requestedHost == resolvedHost
}

func (s *Server) isAllowedCredentialHostForWorkspace(workspaceID, requestedHost string) bool {
	requestedHost = strings.ToLower(strings.TrimSpace(requestedHost))
	if requestedHost == "" || gitrepo.IsKnownGitHost(requestedHost) {
		return true
	}
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if strings.EqualFold(runtime.RepoProvider, "artifacts") {
			return gitrepo.HTTPSAuthoritiesEqual(runtime.RepositoryHost, requestedHost)
		}
		return strings.EqualFold(strings.TrimSpace(runtime.RepositoryHost), requestedHost)
	}
	if strings.EqualFold(s.config.RepoProvider, "artifacts") {
		return gitrepo.HTTPSAuthoritiesEqual(s.config.RepositoryHost, requestedHost)
	}
	return strings.EqualFold(strings.TrimSpace(s.config.RepositoryHost), requestedHost)
}

func (s *Server) isAllowedCredentialPathForWorkspace(workspaceID, requestedPath string) bool {
	requestedPath = strings.TrimSpace(requestedPath)
	if requestedPath == "" {
		return true
	}
	// Resolve the provider/path this workspace is bound to. When the workspace is
	// not registered in the runtime map (standalone single-workspace mode, or a
	// request racing with runtime setup), fall back to the process config instead
	// of failing open — mirroring isAllowedCredentialHostForWorkspace.
	provider, repositoryPath := s.credentialPathBinding(workspaceID)
	if !strings.EqualFold(provider, "gitlab") {
		return true
	}
	// Fail closed: a gitlab-bound workspace with no bound repository path cannot
	// verify the request, so refuse rather than vend a broad user OAuth token.
	// (The response-side gate re-checks this against the control-plane-resolved
	// path, but the pre-fetch gate must not be the weaker of the two.)
	if repositoryPath == "" {
		slog.Warn("Git credential path check refused: gitlab-bound workspace has no bound repository path",
			"workspaceID", workspaceID,
		)
		return false
	}
	return credentialPathMatchesRequest(repositoryPath, requestedPath)
}

func (s *Server) credentialPathBinding(workspaceID string) (provider, repositoryPath string) {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		return strings.TrimSpace(runtime.RepoProvider), strings.TrimSpace(runtime.RepositoryPath)
	}
	return strings.TrimSpace(s.config.RepoProvider), strings.TrimSpace(s.config.RepositoryPath)
}

func credentialPathMatchesRequest(repositoryPath, requestedPath string) bool {
	normalize := func(path string) string {
		path = strings.TrimSpace(path)
		path = strings.TrimPrefix(path, "/")
		path = strings.TrimSuffix(path, ".git")
		path = strings.TrimSuffix(path, "/")
		return strings.ToLower(path)
	}
	repositoryPath = normalize(repositoryPath)
	requestedPath = normalize(requestedPath)
	return repositoryPath != "" && requestedPath != "" && repositoryPath == requestedPath
}

func (s *Server) fetchGitToken(ctx context.Context) (string, error) {
	resp, err := s.fetchGitTokenResponseForWorkspace(ctx, s.config.WorkspaceID, s.config.CallbackToken)
	if err != nil {
		return "", err
	}
	return resp.Token, nil
}

func (s *Server) fetchGitTokenForWorkspace(ctx context.Context, workspaceID, callbackToken string) (string, error) {
	resp, err := s.fetchGitTokenResponseForWorkspace(ctx, workspaceID, callbackToken)
	if err != nil {
		return "", err
	}
	return resp.Token, nil
}

func (s *Server) fetchGitTokenResponseForWorkspace(ctx context.Context, workspaceID, callbackToken string) (*gitTokenResponse, error) {
	targetWorkspaceID, effectiveToken, err := s.gitTokenRequestCredentials(workspaceID, callbackToken)
	if err != nil {
		return nil, err
	}

	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/git-token",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		targetWorkspaceID,
	)
	total, attemptTimeout, attempts, delay := s.gitTokenRetryConfig()
	ctx, cancel := context.WithTimeout(ctx, total)
	defer cancel()
	// Copy the configured client: retain test/custom transport, but prevent redirect
	// replay of credential POSTs and bound each attempt independently of callbacks.
	client := *s.controlPlaneHTTPClient(0)
	client.Timeout = attemptTimeout
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	var last *gitTokenFetchError
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, gitTokenContextError(err)
		}
		payload, failure := fetchGitTokenAttempt(ctx, &client, endpoint, effectiveToken)
		if failure == nil {
			return payload, nil
		}
		last = failure
		if err := ctx.Err(); err != nil {
			return nil, gitTokenContextError(err)
		}
		slog.Warn("git_token.fetch_failed", "workspaceID", targetWorkspaceID,
			"category", failure.category, "status", failure.status, "attempt", attempt,
			"maxAttempts", attempts, "retryable", failure.retryable)
		if !failure.retryable || attempt == attempts {
			return nil, failure
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, gitTokenContextError(ctx.Err())
		case <-timer.C:
		}
		// Saturate at the total budget to avoid duration overflow.
		if delay < total/2 {
			delay *= 2
		} else {
			delay = total
		}
	}
	return nil, last
}

// Resolve workspace-scoped credentials before starting the bounded exchange.
func (s *Server) gitTokenRequestCredentials(workspaceID, callbackToken string) (string, string, error) {
	targetWorkspaceID := strings.TrimSpace(workspaceID)
	if targetWorkspaceID == "" {
		return "", "", fmt.Errorf("workspace id is required for git-token request")
	}

	effectiveToken := strings.TrimSpace(callbackToken)
	if effectiveToken == "" {
		effectiveToken = s.callbackTokenForWorkspace(targetWorkspaceID)
	}
	if effectiveToken == "" {
		return "", "", fmt.Errorf("callback token is required for git-token request")
	}

	return targetWorkspaceID, effectiveToken, nil
}

// No remote body, URL, token, or underlying transport error is included in
// errors or telemetry. Provisioning propagates these errors to boot logs.
type gitTokenFetchError struct {
	category  string
	status    int
	retryable bool
	cause     error
}

func (e *gitTokenFetchError) Error() string {
	if e.status == 0 {
		return fmt.Sprintf("git-token %s; check control-plane availability or repository authorization", e.category)
	}
	return fmt.Sprintf("git-token %s (HTTP %d); check control-plane availability or repository authorization", e.category, e.status)
}
func (e *gitTokenFetchError) Unwrap() error { return e.cause }
func gitTokenContextError(err error) *gitTokenFetchError {
	category := "cancelled"
	if errors.Is(err, context.DeadlineExceeded) {
		category = "budget_exhausted"
	}
	return &gitTokenFetchError{category: category, cause: err}
}
func (s *Server) gitTokenRetryConfig() (time.Duration, time.Duration, int, time.Duration) {
	total, attempt, attempts, delay := s.config.GitTokenTimeout, s.config.GitTokenAttemptTimeout, s.config.GitTokenMaxAttempts, s.config.GitTokenRetryDelay
	if total <= 0 {
		total = config.DefaultGitTokenTimeout
	}
	if attempt <= 0 {
		attempt = config.DefaultGitTokenAttemptTimeout
	}
	if attempts < 1 || attempts > config.MaxGitTokenAttempts {
		attempts = config.DefaultGitTokenMaxAttempts
	}
	if delay <= 0 {
		delay = config.DefaultGitTokenRetryDelay
	}
	return total, attempt, attempts, delay
}
func fetchGitTokenAttempt(ctx context.Context, client *http.Client, endpoint, token string) (*gitTokenResponse, *gitTokenFetchError) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, &gitTokenFetchError{category: "configuration"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", gitCredentialBearerPrefix+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, &gitTokenFetchError{category: "transport", retryable: true}
	}
	defer res.Body.Close()
	// Classify status before reading: auth failures remain terminal even if their
	// response body is truncated. Bodies can contain secrets; never log them.
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		retry := res.StatusCode == 408 || res.StatusCode == 429 || res.StatusCode >= 500
		category := "request_rejected"
		if retry {
			category = "upstream_unavailable"
		}
		if res.StatusCode == 401 || res.StatusCode == 403 {
			category = "authorization_denied"
		}
		return nil, &gitTokenFetchError{category: category, status: res.StatusCode, retryable: retry}
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 8*1024))
	if err != nil {
		return nil, &gitTokenFetchError{category: "response_interrupted", retryable: true}
	}
	var payload gitTokenResponse
	if json.Unmarshal(body, &payload) != nil || payload.Token == "" {
		return nil, &gitTokenFetchError{category: "invalid_response"}
	}
	return &payload, nil
}

const gitCredentialBearerPrefix = "Bearer "

func bearerTokenFromHeader(authHeader string) string {
	if !strings.HasPrefix(authHeader, gitCredentialBearerPrefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(authHeader, gitCredentialBearerPrefix))
}

// gitCredentialCallbackToken authenticates the local exchange and returns the
// callback token that may be forwarded to the control plane. A workspace's
// dedicated helper bearer authenticates only this node-local endpoint, so it is
// never forwarded; the agent substitutes its in-memory callback token instead.
func gitCredentialCallbackToken(s *Server, r *http.Request, workspaceID string) (string, bool) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return "", false
	}
	presented := bearerTokenFromHeader(r.Header.Get("Authorization"))
	if presented == "" {
		return "", false
	}
	if isDirectLocalGitCredentialExchange(r) &&
		isKnownWorkspaceGitCredentialRequest(s, workspaceID) &&
		bootstrap.ValidateGitCredentialExchange(workspaceID, presented) {
		return "", true
	}
	if s.isValidCallbackAuth(r, workspaceID) {
		return presented, true
	}
	return "", false
}

// isDirectLocalGitCredentialExchange reports whether the request can have come
// straight from a helper on this node: a loopback or private peer, not relayed
// by a proxy or the tunnel listener. The helper bearer is a node-local secret,
// so a relayed request carrying it is refused even though the bearer itself
// would validate (defence in depth; the callback bearer is unaffected).
func isDirectLocalGitCredentialExchange(r *http.Request) bool {
	if isRelayedRequest(r) {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

// isKnownWorkspaceGitCredentialRequest limits dedicated helper bearers to a
// workspace currently registered on this node. Callback JWT callers are checked
// independently by isValidCallbackAuth.
func isKnownWorkspaceGitCredentialRequest(s *Server, workspaceID string) bool {
	requestedWorkspaceID := strings.TrimSpace(workspaceID)
	primaryWorkspaceID := strings.TrimSpace(s.config.WorkspaceID)
	if requestedWorkspaceID == "" {
		return false
	}
	if primaryWorkspaceID != "" && requestedWorkspaceID == primaryWorkspaceID {
		return true
	}
	_, ok := s.getWorkspaceRuntime(requestedWorkspaceID)
	return ok
}
