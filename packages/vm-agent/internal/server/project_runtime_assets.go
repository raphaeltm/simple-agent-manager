package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/bootstrap"
)

type projectRuntimeEnvVarPayload struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"isSecret"`
}

type projectRuntimeFilePayload struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	IsSecret bool   `json:"isSecret"`
}

type projectRuntimeAssetsPayload struct {
	WorkspaceID string                        `json:"workspaceId"`
	EnvVars     []projectRuntimeEnvVarPayload `json:"envVars"`
	Files       []projectRuntimeFilePayload   `json:"files"`
}

type projectRuntimeAssets struct {
	EnvVars []bootstrap.ProjectRuntimeEnvVar
	Files   []bootstrap.ProjectRuntimeFile
}

func (s *Server) fetchProjectRuntimeAssetsForWorkspace(
	ctx context.Context,
	workspaceID string,
	callbackToken string,
	agentSessionID string,
) (projectRuntimeAssets, error) {
	targetWorkspaceID := strings.TrimSpace(workspaceID)
	if targetWorkspaceID == "" {
		targetWorkspaceID = strings.TrimSpace(s.config.WorkspaceID)
	}
	if targetWorkspaceID == "" {
		return projectRuntimeAssets{}, fmt.Errorf("workspace id is required for runtime-assets request")
	}

	effectiveToken := strings.TrimSpace(callbackToken)
	if effectiveToken == "" {
		effectiveToken = s.callbackTokenForWorkspace(targetWorkspaceID)
	}
	if effectiveToken == "" {
		return projectRuntimeAssets{}, fmt.Errorf("callback token is required for runtime-assets request")
	}

	endpointURL := fmt.Sprintf(
		"%s/api/workspaces/%s/runtime-assets",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		targetWorkspaceID,
	)
	if sessionID := strings.TrimSpace(agentSessionID); sessionID != "" {
		endpointURL += "?agentSessionId=" + url.QueryEscape(sessionID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpointURL, nil)
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("failed to build runtime-assets request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+effectiveToken)

	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets request failed: %w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 512*1024))
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets: read response body: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets endpoint returned HTTP %d (response body %d bytes)", res.StatusCode, len(body))
	}

	var payload projectRuntimeAssetsPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("failed to decode runtime-assets response: %w", err)
	}

	envVars := make([]bootstrap.ProjectRuntimeEnvVar, 0, len(payload.EnvVars))
	for _, item := range payload.EnvVars {
		envVars = append(envVars, bootstrap.ProjectRuntimeEnvVar{
			Key:      item.Key,
			Value:    item.Value,
			IsSecret: item.IsSecret,
		})
	}

	files := make([]bootstrap.ProjectRuntimeFile, 0, len(payload.Files))
	for _, item := range payload.Files {
		files = append(files, bootstrap.ProjectRuntimeFile{
			Path:     item.Path,
			Content:  item.Content,
			IsSecret: item.IsSecret,
		})
	}

	return projectRuntimeAssets{
		EnvVars: envVars,
		Files:   files,
	}, nil
}

func (s *Server) runtimeAssetsProviderForWorkspaceSession(workspaceID, sessionID string) acp.RuntimeAssetsProvider {
	return func(ctx context.Context) (acp.RuntimeAssets, error) {
		assets, err := s.fetchProjectRuntimeAssetsForWorkspace(ctx, workspaceID, "", sessionID)
		if err != nil {
			return acp.RuntimeAssets{}, err
		}

		envVars := make([]acp.RuntimeEnvVar, 0, len(assets.EnvVars))
		for _, item := range assets.EnvVars {
			envVars = append(envVars, acp.RuntimeEnvVar{
				Key:      item.Key,
				Value:    item.Value,
				IsSecret: item.IsSecret,
			})
		}
		files := make([]acp.RuntimeFile, 0, len(assets.Files))
		for _, item := range assets.Files {
			files = append(files, acp.RuntimeFile{
				Path:     item.Path,
				Content:  item.Content,
				IsSecret: item.IsSecret,
			})
		}
		return acp.RuntimeAssets{EnvVars: envVars, Files: files}, nil
	}
}
