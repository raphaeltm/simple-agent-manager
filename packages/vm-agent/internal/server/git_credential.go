package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

type gitTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	// CloneURL is set for Artifacts-backed projects. Empty for GitHub projects.
	CloneURL string `json:"cloneUrl,omitempty"`
}

func (s *Server) handleGitCredential(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	if workspaceID == "" {
		workspaceID = strings.TrimSpace(s.routedWorkspaceID(r))
	}

	if !s.isValidCallbackAuth(r, workspaceID) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	bearerToken := bearerTokenFromHeader(r.Header.Get("Authorization"))
	resp, err := s.fetchGitTokenResponseForWorkspace(r.Context(), workspaceID, bearerToken)
	if err != nil {
		slog.Error("Failed to fetch git token", "error", err)
		writeError(w, http.StatusBadGateway, "failed to fetch git token")
		return
	}

	// Determine host and username from clone URL (Artifacts) or default (GitHub)
	host := "github.com"
	username := "x-access-token"
	if resp.CloneURL != "" {
		if parsed, parseErr := url.Parse(resp.CloneURL); parseErr == nil && parsed.Host != "" {
			host = parsed.Host
			username = "x" // Artifacts uses "x" as the username
		}
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "protocol=https\nhost=%s\nusername=%s\npassword=%s\n\n", host, username, resp.Token)
}

func (s *Server) fetchGitToken(ctx context.Context) (string, error) {
	resp, err := s.fetchGitTokenResponseForWorkspace(ctx, s.config.WorkspaceID, s.config.CallbackToken)
	if err != nil {
		return "", err
	}
	return resp.Token, nil
}

func (s *Server) fetchGitTokenResponse(ctx context.Context) (*gitTokenResponse, error) {
	return s.fetchGitTokenResponseForWorkspace(ctx, s.config.WorkspaceID, s.config.CallbackToken)
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
		return nil, fmt.Errorf("git-token endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
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

func (s *Server) isValidCallbackAuth(r *http.Request, workspaceID string) bool {
	given := bearerTokenFromHeader(r.Header.Get("Authorization"))
	if given == "" {
		return false
	}

	candidates := []string{strings.TrimSpace(s.config.CallbackToken)}
	if workspaceID != "" {
		if workspaceToken := strings.TrimSpace(s.callbackTokenForWorkspace(workspaceID)); workspaceToken != "" {
			candidates = append(candidates, workspaceToken)
		}
	}

	for _, expected := range candidates {
		if expected == "" {
			continue
		}
		if len(given) != len(expected) {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(given), []byte(expected)) == 1 {
			return true
		}
	}

	return false
}
