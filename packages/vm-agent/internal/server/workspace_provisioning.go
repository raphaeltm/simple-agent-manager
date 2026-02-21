package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
)

var prepareWorkspaceForRuntime = bootstrap.PrepareWorkspace // returns (recoveryMode bool, error)

type workspaceRuntimeMetadataResponse struct {
	WorkspaceID string `json:"workspaceId"`
	Repository  string `json:"repository"`
	Branch      string `json:"branch"`
}

func (s *Server) callbackTokenForWorkspace(workspaceID string) string {
	if runtime, ok := s.getWorkspaceRuntime(workspaceID); ok {
		if token := strings.TrimSpace(runtime.CallbackToken); token != "" {
			return token
		}
	}

	return strings.TrimSpace(s.config.CallbackToken)
}

func (s *Server) applyDetectedContainerUser(runtime *WorkspaceRuntime, detected string) {
	if runtime == nil {
		return
	}

	nextUser := strings.TrimSpace(detected)
	if nextUser == "" {
		return
	}
	if strings.TrimSpace(runtime.ContainerUser) == nextUser {
		return
	}

	runtime.ContainerUser = nextUser
	s.rebuildWorkspacePTYManager(runtime)
}

func (s *Server) provisionWorkspaceRuntime(ctx context.Context, runtime *WorkspaceRuntime) (bool, error) {
	if runtime == nil {
		return false, fmt.Errorf("workspace runtime is required")
	}

	callbackToken := strings.TrimSpace(runtime.CallbackToken)
	if callbackToken == "" {
		callbackToken = strings.TrimSpace(s.config.CallbackToken)
	}

	cfg := *s.config
	cfg.WorkspaceID = runtime.ID
	cfg.Repository = strings.TrimSpace(runtime.Repository)
	cfg.Branch = strings.TrimSpace(runtime.Branch)
	cfg.WorkspaceDir = strings.TrimSpace(runtime.WorkspaceDir)
	cfg.ContainerLabelValue = strings.TrimSpace(runtime.ContainerLabelValue)
	cfg.ContainerWorkDir = strings.TrimSpace(runtime.ContainerWorkDir)
	cfg.ContainerUser = strings.TrimSpace(runtime.ContainerUser)
	if cfg.ContainerUser == "" {
		cfg.ContainerUser = strings.TrimSpace(s.config.ContainerUser)
	}
	cfg.CallbackToken = callbackToken

	provisionCtx := ctx
	cancel := func() {}
	if s.config.BootstrapTimeout > 0 {
		provisionCtx, cancel = context.WithTimeout(ctx, s.config.BootstrapTimeout)
	}
	defer cancel()

	gitToken, err := s.fetchGitTokenForWorkspace(provisionCtx, runtime.ID, callbackToken)
	if err != nil {
		log.Printf("Workspace %s: proceeding without git token: %v", runtime.ID, err)
	}

	runtimeAssets, err := s.fetchProjectRuntimeAssetsForWorkspace(provisionCtx, runtime.ID, callbackToken)
	if err != nil {
		return false, fmt.Errorf("failed to fetch project runtime assets: %w", err)
	}

	// Create a per-workspace reporter for real-time boot log streaming.
	// Wire it to the workspace-specific broadcaster so WebSocket clients see logs.
	reporter := bootlog.New(s.config.ControlPlaneURL, runtime.ID)
	reporter.SetToken(callbackToken)
	if broadcaster := s.GetBootLogBroadcasterForWorkspace(runtime.ID); broadcaster != nil {
		reporter.SetBroadcaster(broadcaster)
	}

	recoveryMode, err := prepareWorkspaceForRuntime(provisionCtx, &cfg, bootstrap.ProvisionState{
		GitHubToken:    gitToken,
		GitUserName:    runtime.GitUserName,
		GitUserEmail:   runtime.GitUserEmail,
		ProjectEnvVars: runtimeAssets.EnvVars,
		ProjectFiles:   runtimeAssets.Files,
	}, reporter)
	if err != nil {
		return false, err
	}
	s.applyDetectedContainerUser(runtime, cfg.ContainerUser)
	return recoveryMode, nil
}

func isContainerUnavailableError(err error) bool {
	if err == nil {
		return false
	}
	errMsg := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(errMsg, "devcontainer not available") ||
		strings.Contains(errMsg, "no running devcontainer found")
}

func (s *Server) recoverWorkspaceRuntime(ctx context.Context, runtime *WorkspaceRuntime) error {
	if runtime == nil {
		return fmt.Errorf("workspace runtime is required")
	}
	if !s.config.ContainerMode {
		return nil
	}

	callbackToken := s.callbackTokenForWorkspace(runtime.ID)
	recoveryCtx := ctx
	cancel := func() {}
	if s.config.BootstrapTimeout > 0 {
		recoveryCtx, cancel = context.WithTimeout(ctx, s.config.BootstrapTimeout)
	}
	defer cancel()

	s.hydrateWorkspaceRuntimeForRecovery(recoveryCtx, runtime, callbackToken)

	cfg := *s.config
	cfg.WorkspaceID = runtime.ID
	cfg.Repository = strings.TrimSpace(runtime.Repository)
	cfg.Branch = strings.TrimSpace(runtime.Branch)
	cfg.WorkspaceDir = strings.TrimSpace(runtime.WorkspaceDir)
	cfg.ContainerLabelValue = strings.TrimSpace(runtime.ContainerLabelValue)
	cfg.ContainerWorkDir = strings.TrimSpace(runtime.ContainerWorkDir)
	cfg.ContainerUser = strings.TrimSpace(runtime.ContainerUser)
	if cfg.ContainerUser == "" {
		cfg.ContainerUser = strings.TrimSpace(s.config.ContainerUser)
	}
	cfg.CallbackToken = callbackToken

	state := bootstrap.ProvisionState{}
	if cfg.Repository != "" && callbackToken != "" {
		gitToken, fetchErr := s.fetchGitTokenForWorkspace(recoveryCtx, runtime.ID, callbackToken)
		if fetchErr != nil {
			log.Printf("Workspace %s: recovery proceeding without git token: %v", runtime.ID, fetchErr)
		} else {
			state.GitHubToken = gitToken
		}
	}

	runtimeAssets, assetsErr := s.fetchProjectRuntimeAssetsForWorkspace(recoveryCtx, runtime.ID, callbackToken)
	if assetsErr != nil {
		return fmt.Errorf("failed to fetch project runtime assets: %w", assetsErr)
	}
	state.ProjectEnvVars = runtimeAssets.EnvVars
	state.ProjectFiles = runtimeAssets.Files

	_, err := prepareWorkspaceForRuntime(recoveryCtx, &cfg, state, nil)
	if err != nil {
		return err
	}
	s.applyDetectedContainerUser(runtime, cfg.ContainerUser)
	return nil
}

func (s *Server) hydrateWorkspaceRuntimeForRecovery(
	ctx context.Context,
	runtime *WorkspaceRuntime,
	callbackToken string,
) {
	if runtime == nil {
		return
	}

	updated := false
	if strings.TrimSpace(runtime.Repository) == "" || strings.TrimSpace(runtime.Branch) == "" {
		metadata, err := s.fetchWorkspaceRuntimeMetadata(ctx, runtime.ID, callbackToken)
		if err != nil {
			log.Printf("Workspace %s: unable to hydrate runtime metadata from control plane: %v", runtime.ID, err)
		} else if metadata != nil {
			if strings.TrimSpace(runtime.Repository) == "" && strings.TrimSpace(metadata.Repository) != "" {
				runtime.Repository = strings.TrimSpace(metadata.Repository)
				updated = true
			}
			if strings.TrimSpace(runtime.Branch) == "" && strings.TrimSpace(metadata.Branch) != "" {
				runtime.Branch = strings.TrimSpace(metadata.Branch)
				updated = true
			}
		}
	}

	if s.adoptLegacyWorkspaceLayout(runtime) {
		updated = true
	}

	if updated {
		s.rebuildWorkspacePTYManager(runtime)
	}
}

func (s *Server) fetchWorkspaceRuntimeMetadata(
	ctx context.Context,
	workspaceID string,
	callbackToken string,
) (*workspaceRuntimeMetadataResponse, error) {
	targetWorkspaceID := strings.TrimSpace(workspaceID)
	if targetWorkspaceID == "" {
		return nil, fmt.Errorf("workspace id is required for runtime metadata request")
	}

	effectiveToken := strings.TrimSpace(callbackToken)
	if effectiveToken == "" {
		effectiveToken = s.callbackTokenForWorkspace(targetWorkspaceID)
	}
	if effectiveToken == "" {
		return nil, fmt.Errorf("callback token is required for runtime metadata request")
	}

	endpoint := fmt.Sprintf(
		"%s/api/workspaces/%s/runtime",
		strings.TrimRight(s.config.ControlPlaneURL, "/"),
		neturl.PathEscape(targetWorkspaceID),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to build runtime metadata request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+effectiveToken)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("runtime metadata request failed: %w", err)
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("runtime metadata endpoint returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload workspaceRuntimeMetadataResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("failed to decode runtime metadata response: %w", err)
	}
	return &payload, nil
}

func (s *Server) adoptLegacyWorkspaceLayout(runtime *WorkspaceRuntime) bool {
	if runtime == nil {
		return false
	}

	legacyDir := legacyWorkspaceDir(s.config.WorkspaceDir, runtime.Repository)
	if legacyDir == "" {
		return false
	}

	baseDir := strings.TrimSpace(s.config.WorkspaceDir)
	if baseDir == "" {
		baseDir = "/workspace"
	}
	cleanBaseDir := filepath.Clean(baseDir)
	cleanLegacyDir := filepath.Clean(legacyDir)

	currentDir := strings.TrimSpace(runtime.WorkspaceDir)
	cleanCurrentDir := ""
	if currentDir != "" {
		cleanCurrentDir = filepath.Clean(currentDir)
	}

	// Preserve explicitly configured existing workspace directories. Only adopt
	// legacy repo layouts when the current runtime path is missing or still on
	// the generic base directory.
	if cleanCurrentDir != "" && cleanCurrentDir != cleanLegacyDir {
		if _, err := os.Stat(cleanCurrentDir); err == nil && cleanCurrentDir != cleanBaseDir {
			return false
		}
	}

	if _, err := os.Stat(legacyDir); err != nil {
		return false
	}

	nextContainerWorkDir := deriveContainerWorkDirForRepo(legacyDir, runtime.Repository)
	if cleanCurrentDir == cleanLegacyDir &&
		strings.TrimSpace(runtime.ContainerLabelValue) == legacyDir &&
		strings.TrimSpace(runtime.ContainerWorkDir) == nextContainerWorkDir {
		return false
	}

	log.Printf("Workspace %s: adopting legacy workspace layout at %s", runtime.ID, legacyDir)
	runtime.WorkspaceDir = legacyDir
	runtime.ContainerLabelValue = legacyDir
	runtime.ContainerWorkDir = nextContainerWorkDir
	return true
}

func legacyWorkspaceDir(baseDir, repository string) string {
	trimmedBase := strings.TrimSpace(baseDir)
	if trimmedBase == "" {
		trimmedBase = "/workspace"
	}

	repoDir := repositoryDirName(repository)
	if repoDir == "" {
		return ""
	}

	return filepath.Join(trimmedBase, repoDir)
}

func repositoryDirName(repository string) string {
	repo := strings.TrimSpace(repository)
	if repo == "" {
		return ""
	}

	if strings.Contains(repo, "://") {
		if parsed, err := neturl.Parse(repo); err == nil {
			repo = parsed.Path
		}
	}

	repo = strings.Trim(repo, "/")
	if repo == "" {
		return ""
	}

	parts := strings.Split(repo, "/")
	name := strings.TrimSpace(strings.TrimSuffix(parts[len(parts)-1], ".git"))
	if name == "" {
		return ""
	}

	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}

	return strings.Trim(b.String(), "-")
}
