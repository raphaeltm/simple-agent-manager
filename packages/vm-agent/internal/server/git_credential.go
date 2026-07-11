package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"

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

	if !isAuthorizedGitCredentialRequest(s, r, workspaceID) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	bearerToken := bearerTokenFromHeader(r.Header.Get("Authorization"))
	requestedHost := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("host")))
	requestedPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if requestedHost != "" && !s.isAllowedCredentialHostForWorkspace(workspaceID, requestedHost) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if requestedPath != "" && !s.isAllowedCredentialPathForWorkspace(workspaceID, requestedPath) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	resp, err := s.fetchGitTokenResponseForWorkspace(r.Context(), workspaceID, bearerToken)
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

	if requestedHost != "" && !credentialHostMatchesRequest(host, requestedHost) {
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
		return strings.EqualFold(strings.TrimSpace(runtime.RepositoryHost), requestedHost)
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
	if repositoryPath == "" {
		return true
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
	targetWorkspaceID := strings.TrimSpace(workspaceID)
	if targetWorkspaceID == "" {
		targetWorkspaceID = strings.TrimSpace(s.config.WorkspaceID)
	}
	if targetWorkspaceID == "" {
		return nil, fmt.Errorf("workspace id is required for git-token request")
	}

	effectiveToken := strings.TrimSpace(callbackToken)
	if effectiveToken == "" {
		effectiveToken = s.callbackTokenForWorkspace(targetWorkspaceID)
	}
	if effectiveToken == "" {
		return nil, fmt.Errorf("callback token is required for git-token request")
	}

	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/git-token",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		targetWorkspaceID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, fmt.Errorf("failed to build git-token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+effectiveToken)

	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return nil, fmt.Errorf("git-token request failed: %w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 8*1024))
	if err != nil {
		return nil, fmt.Errorf("git-token: read response body: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("git-token endpoint returned HTTP %d (response body %d bytes)", res.StatusCode, len(body))
	}

	var payload gitTokenResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("failed to decode git-token response: %w", err)
	}
	if payload.Token == "" {
		return nil, fmt.Errorf("git-token response missing token")
	}

	return &payload, nil
}

func bearerTokenFromHeader(authHeader string) string {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
}

func isLocalGitCredentialExchange(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

func isAuthorizedGitCredentialRequest(s *Server, r *http.Request, workspaceID string) bool {
	if bearerTokenFromHeader(r.Header.Get("Authorization")) != "" {
		return s.isValidCallbackAuth(r, workspaceID)
	}
	return isLocalGitCredentialExchange(r) && isKnownWorkspaceGitCredentialRequest(s, workspaceID)
}

// isKnownWorkspaceGitCredentialRequest authorizes a bearerless loopback credential
// exchange for ANY workspace currently running on this node — the node's primary
// workspace and every secondary workspace registered in the runtime map are treated
// equally. The control-plane exchange still returns a tightly scoped (per-workspace,
// ~1h, owner-scoped) token covering only the project's primary repository plus any
// explicitly granted additional repositories, so equal treatment here does not widen
// the blast radius: it only lets each running workspace refresh its own token over the
// loopback interface. An empty workspace id defaults to the node's primary so the
// single-workspace host path is unchanged.
func isKnownWorkspaceGitCredentialRequest(s *Server, workspaceID string) bool {
	requestedWorkspaceID := strings.TrimSpace(workspaceID)
	primaryWorkspaceID := strings.TrimSpace(s.config.WorkspaceID)
	if requestedWorkspaceID == "" {
		requestedWorkspaceID = primaryWorkspaceID
	}
	if requestedWorkspaceID == "" {
		return false
	}
	if primaryWorkspaceID != "" && requestedWorkspaceID == primaryWorkspaceID {
		return true
	}
	_, ok := s.getWorkspaceRuntime(requestedWorkspaceID)
	return ok
}

func (s *Server) isValidCallbackAuth(r *http.Request, workspaceID string) bool {
	given := bearerTokenFromHeader(r.Header.Get("Authorization"))
	if given == "" {
		slog.Warn("Git credential auth rejected: missing bearer token", "workspaceID", workspaceID)
		return false
	}

	candidates := s.callbackAuthCandidates(workspaceID)
	for _, candidate := range candidates {
		if constantTimeTokenEqual(given, candidate.token) {
			return true
		}
	}

	jwtErr := "not_checked"
	if workspaceID != "" {
		if s.jwtValidator == nil {
			jwtErr = "validator_unavailable"
		} else if _, err := s.jwtValidator.ValidateWorkspaceCallbackToken(given, workspaceID); err != nil {
			jwtErr = err.Error()
		} else {
			return true
		}
	}

	s.logGitCredentialAuthRejected(workspaceID, len(given), candidates, jwtErr)
	return false
}

type callbackAuthCandidate struct {
	source string
	token  string
}

func (s *Server) callbackAuthCandidates(workspaceID string) []callbackAuthCandidate {
	candidates := []callbackAuthCandidate{{
		source: "config",
		token:  strings.TrimSpace(s.config.CallbackToken),
	}}
	if workspaceID == "" {
		return candidates
	}
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		candidates = append(candidates, callbackAuthCandidate{
			source: "workspace",
			token:  strings.TrimSpace(runtime.CallbackToken),
		})
	}
	return candidates
}

func constantTimeTokenEqual(given, expected string) bool {
	if expected == "" || len(given) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(expected)) == 1
}

func (s *Server) logGitCredentialAuthRejected(
	workspaceID string,
	givenLen int,
	candidates []callbackAuthCandidate,
	jwtErr string,
) {
	sources := make([]string, 0, len(candidates))
	lengths := make([]int, 0, len(candidates))
	for _, candidate := range candidates {
		sources = append(sources, candidate.source)
		lengths = append(lengths, len(candidate.token))
	}
	_, runtimeExists := s.getWorkspaceRuntime(workspaceID)
	slog.Warn("Git credential auth rejected",
		"workspaceID", workspaceID,
		"runtimeExists", runtimeExists,
		"givenLen", givenLen,
		"candidateSources", sources,
		"candidateLens", lengths,
		"jwtValidation", jwtErr,
	)
}
