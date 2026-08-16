package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) prepareSnapshot(ctx context.Context, workspaceID, sessionID, chatSessionID, runtimeName, token string) (*snapshotPrepareResponse, error) {
	payload := map[string]interface{}{
		"chatSessionId":         chatSessionID,
		"agentSessionId":        sessionID,
		"runtime":               runtimeName,
		"directUploadSupported": true,
	}
	var out snapshotPrepareResponse
	err := s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/prepare", token, payload, &out)
	return &out, err
}

func (s *Server) completeSnapshot(ctx context.Context, workspaceID, sessionID, chatSessionID, runtimeName, generation, token string, manifest snapshotManifest) error {
	artifactSizes := map[string]int64{}
	if artifact, ok := manifest.Artifacts["home"]; ok {
		artifactSizes["homeBytes"] = artifact.SizeBytes
	}
	if artifact, ok := manifest.Artifacts["wip"]; ok {
		artifactSizes["wipBytes"] = artifact.SizeBytes
	}
	payload := map[string]interface{}{
		"chatSessionId":  chatSessionID,
		"agentSessionId": sessionID,
		"runtime":        runtimeName,
		"generation":     generation,
		"baseCommit":     manifest.BaseCommit,
		"status":         manifest.Status,
		"degradation":    manifest.Degradation,
		"manifest":       manifest,
		"artifactSizes":  artifactSizes,
	}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/complete", token, payload, &out)
}

func (s *Server) reportSnapshotProgress(ctx context.Context, workspaceID, chatSessionID, generation, step, token string) error {
	payload := map[string]string{
		"chatSessionId": chatSessionID,
		"generation":    generation,
		"step":          step,
	}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/progress", token, payload, &out)
}

func (s *Server) reportSnapshotFailure(ctx context.Context, workspaceID, chatSessionID, generation, message, token string) error {
	payload := map[string]string{
		"chatSessionId": chatSessionID,
		"generation":    generation,
		"error":         message,
	}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/failure", token, payload, &out)
}

func (s *Server) fetchSnapshotRestore(ctx context.Context, workspaceID, chatSessionID, token string) (*snapshotRestoreResponse, error) {
	path := "/session-snapshot/restore?chatSessionId=" + url.QueryEscape(chatSessionID)
	var out snapshotRestoreResponse
	err := s.doSnapshotJSON(ctx, http.MethodGet, workspaceID, path, token, nil, &out)
	return &out, err
}

func (s *Server) reportSnapshotRestoreResult(ctx context.Context, workspaceID, chatSessionID, status, message, token string) error {
	payload := map[string]string{"chatSessionId": chatSessionID, "status": status, "message": message}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/restore-result", token, payload, &out)
}

func (s *Server) doSnapshotJSON(ctx context.Context, method, workspaceID, path, token string, payload interface{}, out interface{}) error {
	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/workspaces/" + url.PathEscape(workspaceID) + path
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("snapshot control plane returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return err
		}
	}
	return nil
}
