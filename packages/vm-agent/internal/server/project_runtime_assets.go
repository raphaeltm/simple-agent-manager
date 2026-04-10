package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

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

	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/runtime-assets",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		targetWorkspaceID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("failed to build runtime-assets request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+effectiveToken)

	res, err := s.httpClient.Do(req)
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets request failed: %w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 512*1024))
	if err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets: read response body: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return projectRuntimeAssets{}, fmt.Errorf("runtime-assets endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload projectRuntimeAssetsPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return projectRuntimeAssets{}, fmt.Errorf("failed to decode runtime-assets response: %w", err)
	}

	envVars := make([]bootstrap.ProjectRuntimeEnvVar, 0, len(payload.EnvVars))
	for _, item := range payload.EnvVars {
		envVars = append(envVars, bootstrap.ProjectRuntimeEnvVar{
			Key:   item.Key,
			Value: item.Value,
		})
	}

	files := make([]bootstrap.ProjectRuntimeFile, 0, len(payload.Files))
	for _, item := range payload.Files {
		files = append(files, bootstrap.ProjectRuntimeFile{
			Path:    item.Path,
			Content: item.Content,
		})
	}

	return projectRuntimeAssets{
		EnvVars: envVars,
		Files:   files,
	}, nil
}
