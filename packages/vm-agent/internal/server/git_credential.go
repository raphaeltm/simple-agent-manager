package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

type gitTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

func (s *Server) handleGitCredential(w http.ResponseWriter, r *http.Request) {
	if !s.isValidCallbackAuth(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	gitToken, err := s.fetchGitToken(r.Context())
	if err != nil {
		log.Printf("Failed to fetch git token: %v", err)
		writeError(w, http.StatusBadGateway, "failed to fetch git token")
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n", gitToken)
}

func (s *Server) fetchGitToken(ctx context.Context) (string, error) {
	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/git-token",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		s.config.WorkspaceID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte("{}")))
	if err != nil {
		return "", fmt.Errorf("failed to build git-token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.config.CallbackToken)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("git-token request failed: %w", err)
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("git-token endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload gitTokenResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("failed to decode git-token response: %w", err)
	}
	if payload.Token == "" {
		return "", fmt.Errorf("git-token response missing token")
	}

	return payload.Token, nil
}

func (s *Server) isValidCallbackAuth(r *http.Request) bool {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return false
	}
	given := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	expected := s.config.CallbackToken
	if given == "" || expected == "" {
		return false
	}
	if len(given) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(expected)) == 1
}
