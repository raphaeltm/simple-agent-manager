package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/workspace/vm-agent/internal/gitrepo"
)

type standaloneCloneSpec struct {
	URL      string
	Host     string
	Username string
	Token    string
}

var runStandaloneGitCommand = func(ctx context.Context, workDir string, extraEnv []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, standaloneGitBinaryPath, args...)
	if workDir != "" {
		cmd.Dir = workDir
	}
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	output, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func standaloneWorkspaceWorkDir(runtime *WorkspaceRuntime, cfgWorkDir, cfgContainerWorkDir string) string {
	for _, candidate := range []string{
		runtime.ContainerWorkDir,
		runtime.WorkspaceDir,
		cfgContainerWorkDir,
		cfgWorkDir,
	} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return "/workspaces"
}

func validateStandaloneWorkspaceWorkDir(workDir string) (string, error) {
	clean := filepath.Clean(strings.TrimSpace(workDir))
	if clean == "." || clean == string(filepath.Separator) {
		return "", fmt.Errorf("refusing unsafe standalone workspace directory %q", workDir)
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("refusing relative standalone workspace directory %q", workDir)
	}
	return clean, nil
}

func standaloneRepositoryPresent(workDir string) (bool, error) {
	if _, err := os.Stat(filepath.Join(workDir, ".git")); err == nil {
		return true, nil
	} else if os.IsNotExist(err) {
		return false, nil
	} else {
		return false, fmt.Errorf("failed to inspect standalone repository: %w", err)
	}
}

func noopStandaloneCloneCredentialCleanup() {
	// No temporary credential helper was created, so there is nothing to remove.
}

func (s *Server) updateStandaloneRuntimeWorkDir(runtime *WorkspaceRuntime, workDir string) *WorkspaceRuntime {
	s.workspaceMu.Lock()
	defer s.workspaceMu.Unlock()

	if current := s.workspaces[runtime.ID]; current != nil {
		current.WorkspaceDir = workDir
		current.ContainerWorkDir = workDir
		current.ContainerLabelValue = workDir
		return current
	}
	return runtime
}

func (s *Server) cloneStandaloneRepository(ctx context.Context, runtime *WorkspaceRuntime, workDir string) error {
	cloneSpec, err := s.standaloneCloneSpec(ctx, runtime)
	if err != nil {
		return err
	}

	extraEnv, cleanup, err := standaloneCloneCredentialEnv(cloneSpec)
	if err != nil {
		return err
	}
	defer cleanup()

	branch := strings.TrimSpace(runtime.Branch)
	if branch == "" {
		branch = "main"
	}

	// Standalone clones run synchronously inside the control plane's
	// create-workspace request deadline, so clone cost must stay proportional
	// to the working tree, not the full history pack. The partial-clone filter
	// (default blob:none) skips unreferenced historical blobs; later blob
	// access lazy-fetches through the persistent credential helper installed
	// by ConfigureStandaloneGitCredentialHelper.
	cloneFilter := s.config.StandaloneCloneFilter
	args := []string{"clone"}
	if cloneFilter != "" {
		args = append(args, "--filter="+cloneFilter)
	}
	args = append(args, "--branch", branch, cloneSpec.URL, workDir)
	if helperPath := standaloneCloneCredentialHelperPath(extraEnv); helperPath != "" {
		args = append([]string{"-c", "credential.helper=" + helperPath}, args...)
	}

	repository := strings.TrimSpace(runtime.Repository)
	slog.Info("Cloning standalone repository", "workspace", runtime.ID, "repository", repository, "branch", branch, "workDir", workDir, "cloneFilter", cloneFilter)
	output, err := runStandaloneGitCommand(ctx, "", extraEnv, args...)
	if err != nil {
		return fmt.Errorf("standalone git clone failed: %w: %s", err, redactStandaloneCloneSecrets(output, cloneSpec.Token))
	}

	if output, err := runStandaloneGitCommand(ctx, "", nil, "-C", workDir, "remote", "set-url", "origin", cloneSpec.URL); err != nil {
		return fmt.Errorf("failed to sanitize standalone repository origin URL: %w: %s", err, output)
	}
	return nil
}

func (s *Server) prepareStandaloneWorkspaceRuntime(ctx context.Context, runtime *WorkspaceRuntime) error {
	if runtime == nil {
		return fmt.Errorf("workspace runtime is required")
	}

	workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
	var err error
	workDir, err = validateStandaloneWorkspaceWorkDir(workDir)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(workDir), 0o755); err != nil {
		return fmt.Errorf("failed to create standalone workspace parent directory: %w", err)
	}

	runtime = s.updateStandaloneRuntimeWorkDir(runtime, workDir)
	s.rebuildWorkspacePTYManager(runtime)

	repository := strings.TrimSpace(runtime.Repository)
	if repository == "" {
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			return fmt.Errorf("failed to create standalone workspace directory: %w", err)
		}
		s.persistWorkspaceMetadata(runtime)
		return nil
	}

	repositoryPresent, err := standaloneRepositoryPresent(workDir)
	if err != nil {
		return err
	}
	if repositoryPresent {
		slog.Info("Standalone repository already present, skipping clone", "workspace", runtime.ID, "workDir", workDir)
		s.persistWorkspaceMetadata(runtime)
		return nil
	}

	if err := os.RemoveAll(workDir); err != nil {
		return fmt.Errorf("failed to clean standalone workspace directory: %w", err)
	}

	if err := s.cloneStandaloneRepository(ctx, runtime, workDir); err != nil {
		return err
	}

	s.persistWorkspaceMetadata(runtime)
	return nil
}

func (s *Server) standaloneCloneSpec(ctx context.Context, runtime *WorkspaceRuntime) (standaloneCloneSpec, error) {
	repositoryURL := gitrepo.NormalizeURL(runtime.Repository)
	var tokenResponse *gitTokenResponse

	if callbackToken := strings.TrimSpace(runtime.CallbackToken); callbackToken != "" {
		resp, err := s.fetchGitTokenResponseForWorkspace(ctx, runtime.ID, callbackToken)
		if err != nil {
			slog.Warn("Standalone repository clone proceeding without git token", "workspace", runtime.ID, "error", err)
		} else {
			tokenResponse = resp
			if cloneURL := strings.TrimSpace(resp.CloneURL); cloneURL != "" {
				repositoryURL = cloneURL
			}
		}
	}

	spec, err := standaloneCloneSpecForURL(repositoryURL, tokenResponse)
	if err != nil {
		return standaloneCloneSpec{}, err
	}
	return spec, nil
}

func standaloneCloneSpecForURL(repositoryURL string, tokenResponse *gitTokenResponse) (standaloneCloneSpec, error) {
	parsed, err := url.Parse(strings.TrimSpace(repositoryURL))
	if err != nil {
		return standaloneCloneSpec{}, fmt.Errorf("failed to parse repository URL: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return standaloneCloneSpec{}, fmt.Errorf("repository URL must include scheme and host")
	}

	spec := standaloneCloneSpec{
		URL:  parsed.String(),
		Host: strings.ToLower(parsed.Host),
	}
	if tokenResponse != nil {
		spec.Token = strings.TrimSpace(tokenResponse.Token)
	}

	if parsed.User != nil {
		spec.Username = parsed.User.Username()
		if password, ok := parsed.User.Password(); ok && password != "" {
			spec.Token = password
		}
		parsed.User = nil
		spec.URL = parsed.String()
	}

	if spec.Token != "" && spec.Username == "" {
		spec.Username = "x-access-token"
		if gitrepo.IsArtifactsHost(spec.Host) {
			spec.Username = "x"
		}
	}

	return spec, nil
}

func standaloneCloneCredentialEnv(spec standaloneCloneSpec) ([]string, func(), error) {
	if strings.TrimSpace(spec.Token) == "" || strings.TrimSpace(spec.Host) == "" {
		return nil, noopStandaloneCloneCredentialCleanup, nil
	}

	helper, err := os.CreateTemp("", "sam-standalone-git-credential-*")
	if err != nil {
		return nil, noopStandaloneCloneCredentialCleanup, fmt.Errorf("failed to create standalone git credential helper: %w", err)
	}
	helperPath := helper.Name()
	if _, err := helper.WriteString(standaloneCloneCredentialHelperScript); err != nil {
		_ = helper.Close()
		_ = os.Remove(helperPath)
		return nil, noopStandaloneCloneCredentialCleanup, fmt.Errorf("failed to write standalone git credential helper: %w", err)
	}
	if err := helper.Close(); err != nil {
		_ = os.Remove(helperPath)
		return nil, noopStandaloneCloneCredentialCleanup, fmt.Errorf("failed to close standalone git credential helper: %w", err)
	}
	if err := os.Chmod(helperPath, 0o700); err != nil {
		_ = os.Remove(helperPath)
		return nil, noopStandaloneCloneCredentialCleanup, fmt.Errorf("failed to chmod standalone git credential helper: %w", err)
	}

	username := strings.TrimSpace(spec.Username)
	if username == "" {
		username = "x-access-token"
	}
	extraEnv := []string{
		"SAM_CLONE_CREDENTIAL_HELPER=" + helperPath,
		"SAM_CLONE_CREDENTIAL_HOST=" + spec.Host,
		"SAM_CLONE_CREDENTIAL_USERNAME=" + username,
		"SAM_CLONE_CREDENTIAL_TOKEN=" + spec.Token,
	}
	if gitrepo.IsGitHubCredentialHost(spec.Host) {
		extraEnv = append(extraEnv, "GH_TOKEN="+spec.Token)
	}
	return extraEnv, func() { _ = os.Remove(helperPath) }, nil
}

func standaloneCloneCredentialHelperPath(env []string) string {
	const prefix = "SAM_CLONE_CREDENTIAL_HELPER="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}

func redactStandaloneCloneSecrets(output string, secrets ...string) string {
	redacted := output
	for _, secret := range secrets {
		if secret = strings.TrimSpace(secret); secret != "" {
			redacted = strings.ReplaceAll(redacted, secret, "[REDACTED]")
		}
	}
	return redacted
}

const standaloneCloneCredentialHelperScript = `#!/bin/sh
[ "${1:-get}" = "get" ] || exit 0
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
  esac
done
[ "$host" = "${SAM_CLONE_CREDENTIAL_HOST:-}" ] || exit 0
[ -n "${SAM_CLONE_CREDENTIAL_TOKEN:-}" ] || exit 0
printf 'username=%s\npassword=%s\n' "${SAM_CLONE_CREDENTIAL_USERNAME:-x-access-token}" "$SAM_CLONE_CREDENTIAL_TOKEN"
`
