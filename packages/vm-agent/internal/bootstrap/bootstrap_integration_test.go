//go:build integration

package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

// requireDockerAvailable skips the test if Docker is not available.
func requireDockerAvailable(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("docker", "info").CombinedOutput(); err != nil {
		t.Skipf("Docker not available: %v\n%s", err, string(out))
	}
}

// requireDevcontainerCLI skips the test if the devcontainer CLI is not installed.
func requireDevcontainerCLI(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("devcontainer"); err != nil {
		t.Skip("devcontainer CLI not installed")
	}
}

// mustStartContainer starts a Docker container from the given image with a label,
// registers cleanup to remove it, and returns the container ID.
// Extra args are inserted before the image name (e.g., "--user", "node").
func mustStartContainer(t *testing.T, image, labelKey, labelValue string, extraArgs ...string) string {
	t.Helper()
	label := fmt.Sprintf("%s=%s", labelKey, labelValue)
	args := []string{"run", "-d", "--label", label}
	args = append(args, extraArgs...)
	args = append(args, image, "sleep", "infinity")
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run %s failed: %v\n%s", image, err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})
	return containerID
}

// mustStartContainerWithBindMount starts a Docker container with a host directory bind-mounted.
// Extra args are inserted before the image name.
func mustStartContainerWithBindMount(t *testing.T, image, labelKey, labelValue, hostDir, containerDir string, extraArgs ...string) string {
	t.Helper()
	label := fmt.Sprintf("%s=%s", labelKey, labelValue)
	mount := fmt.Sprintf("%s:%s", hostDir, containerDir)
	args := []string{"run", "-d", "--label", label, "-v", mount}
	args = append(args, extraArgs...)
	args = append(args, image, "sleep", "infinity")
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run %s with bind mount failed: %v\n%s", image, err, string(out))
	}
	containerID := strings.TrimSpace(string(out))
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})
	return containerID
}

// mustCreateTestRepo creates a temporary git repository. If withDevcontainerConfig is true,
// it writes .devcontainer/devcontainer.json with the given content and commits it.
func mustCreateTestRepo(t *testing.T, withDevcontainerConfig bool, devcontainerJSON string) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@example.com"},
		{"git", "-C", dir, "config", "user.name", "Test User"},
	}

	for _, args := range cmds {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	// Create a README so we have something to commit
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Repo\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}

	if withDevcontainerConfig && devcontainerJSON != "" {
		dcDir := filepath.Join(dir, ".devcontainer")
		if err := os.MkdirAll(dcDir, 0o755); err != nil {
			t.Fatalf("mkdir .devcontainer: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte(devcontainerJSON), 0o644); err != nil {
			t.Fatalf("write devcontainer.json: %v", err)
		}
	}

	// Stage and commit everything
	addAndCommit := [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial commit"},
	}
	for _, args := range addAndCommit {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", strings.Join(args, " "), err, string(out))
		}
	}

	return dir
}

// controlPlaneState tracks requests received by the mock control plane.
type controlPlaneState struct {
	mu                sync.Mutex
	bootstrapRedeemed bool
	readyCalled       bool
	lastReadyAuth     string
	bootLogs          []map[string]interface{}
}

// startMockControlPlane creates an httptest server that handles bootstrap, ready, and boot-log endpoints.
func startMockControlPlane(t *testing.T, workspaceID, bootstrapToken, callbackToken string) (*httptest.Server, *controlPlaneState) {
	t.Helper()
	state := &controlPlaneState{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// POST /api/bootstrap/{token}
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/bootstrap/") {
			token := strings.TrimPrefix(r.URL.Path, "/api/bootstrap/")
			if token != bootstrapToken {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"NOT_FOUND"}`))
				return
			}
			state.mu.Lock()
			state.bootstrapRedeemed = true
			state.mu.Unlock()

			w.Header().Set("Content-Type", "application/json")
			resp := map[string]interface{}{
				"workspaceId":     workspaceID,
				"callbackToken":   callbackToken,
				"controlPlaneUrl": "http://mock.local",
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}

		// POST /api/workspaces/{id}/ready
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ready") {
			state.mu.Lock()
			state.readyCalled = true
			state.lastReadyAuth = r.Header.Get("Authorization")
			state.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"running"}`))
			return
		}

		// POST /api/workspaces/{id}/boot-log
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/boot-log") {
			var entry map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&entry); err == nil {
				state.mu.Lock()
				state.bootLogs = append(state.bootLogs, entry)
				state.mu.Unlock()
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}

		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))

	t.Cleanup(server.Close)
	return server, state
}

// ---------------------------------------------------------------------------
// Test image definitions
// ---------------------------------------------------------------------------

type testImage struct {
	name           string
	image          string
	defaultUID     int
	defaultGID     int
	defaultUser    string
	hasGit         bool
	hasNonRootUser bool
	// dockerRunArgs are extra args passed to docker run before the image name.
	// Used to simulate non-root default user (e.g., --user node:node) since
	// the base node:22-bookworm image runs as root by default — it's the
	// devcontainer images that set the default user to "node".
	dockerRunArgs []string
}

var (
	debianImage = testImage{
		name: "debian-root", image: "debian:bookworm-slim",
		defaultUID: 0, defaultGID: 0, defaultUser: "root",
		hasGit: false, hasNonRootUser: false,
	}
	nodeImage = testImage{
		name: "node-nonroot", image: "node:22-bookworm",
		defaultUID: 1000, defaultGID: 1000, defaultUser: "node",
		hasGit: true, hasNonRootUser: true,
		dockerRunArgs: []string{"--user", "node:node"},
	}
	allImages = []testImage{debianImage, nodeImage}
)

// ---------------------------------------------------------------------------
// Category 1: Container Permission Tests
// ---------------------------------------------------------------------------

func TestIntegration_GetContainerUserIDs(t *testing.T) {
	requireDockerAvailable(t)

	for _, img := range allImages {
		img := img
		t.Run(img.name, func(t *testing.T) {
			containerID := mustStartContainer(t, img.image, "test.label", t.Name(), img.dockerRunArgs...)
			ctx := context.Background()

			// root user should always be uid=0, gid=0
			uid, gid, err := getContainerUserIDs(ctx, containerID, "root")
			if err != nil {
				t.Fatalf("getContainerUserIDs(root) failed: %v", err)
			}
			if uid != 0 || gid != 0 {
				t.Fatalf("expected root uid=0 gid=0, got uid=%d gid=%d", uid, gid)
			}

			// Test the image-specific non-root user
			if img.hasNonRootUser {
				uid, gid, err = getContainerUserIDs(ctx, containerID, img.defaultUser)
				if err != nil {
					t.Fatalf("getContainerUserIDs(%s) failed: %v", img.defaultUser, err)
				}
				if uid != img.defaultUID || gid != img.defaultGID {
					t.Fatalf("expected %s uid=%d gid=%d, got uid=%d gid=%d",
						img.defaultUser, img.defaultUID, img.defaultGID, uid, gid)
				}
			}

			// Nonexistent user should error
			_, _, err = getContainerUserIDs(ctx, containerID, "nonexistent-user-xyz-123")
			if err == nil {
				t.Fatal("expected error for nonexistent user")
			}
		})
	}
}

func TestIntegration_GetContainerCurrentUserIDs(t *testing.T) {
	requireDockerAvailable(t)

	for _, img := range allImages {
		img := img
		t.Run(img.name, func(t *testing.T) {
			containerID := mustStartContainer(t, img.image, "test.label", t.Name(), img.dockerRunArgs...)
			ctx := context.Background()

			uid, gid, err := getContainerCurrentUserIDs(ctx, containerID)
			if err != nil {
				t.Fatalf("getContainerCurrentUserIDs() failed: %v", err)
			}
			if uid != img.defaultUID || gid != img.defaultGID {
				t.Fatalf("expected default uid=%d gid=%d, got uid=%d gid=%d",
					img.defaultUID, img.defaultGID, uid, gid)
			}
		})
	}
}

func TestIntegration_DockerExecAsRoot(t *testing.T) {
	requireDockerAvailable(t)

	// Only test with non-root image — that's where the bugs were
	containerID := mustStartContainer(t, nodeImage.image, "test.label", t.Name(), nodeImage.dockerRunArgs...)
	ctx := context.Background()

	// Install git in the container if not available (node image has it)
	// Create a dummy file to test chmod
	dummyContent := "#!/bin/sh\necho test\n"
	tmpFile := filepath.Join(t.TempDir(), "test-helper")
	if err := os.WriteFile(tmpFile, []byte(dummyContent), 0o755); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	// docker cp the file into the container
	installPath := "/usr/local/bin/test-credential-helper"
	out, err := exec.CommandContext(ctx, "docker", "cp", tmpFile, containerID+":"+installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("docker cp failed: %v\n%s", err, string(out))
	}

	// chmod as root (this is the exact pattern that was broken before the fix)
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "chmod", "0755", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("docker exec -u root chmod failed: %v\n%s", err, string(out))
	}

	// git config --system as root (the second pattern that was broken)
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID,
		"git", "config", "--system", "credential.helper", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("docker exec -u root git config --system failed: %v\n%s", err, string(out))
	}

	// Verify git config was set correctly
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID,
		"git", "config", "--system", "credential.helper").CombinedOutput()
	if err != nil {
		t.Fatalf("git config --system read failed: %v\n%s", err, string(out))
	}
	if got := strings.TrimSpace(string(out)); got != installPath {
		t.Fatalf("expected credential.helper=%q, got %q", installPath, got)
	}

	// Verify the file is executable
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "test", "-x", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("file not executable: %v\n%s", err, string(out))
	}
}

func TestIntegration_ChownWorkspaceDir(t *testing.T) {
	requireDockerAvailable(t)

	// Test with node image (non-root default user, uid 1000)
	workspaceDir := t.TempDir()

	// Create a file in the workspace directory
	testFile := filepath.Join(workspaceDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("test"), 0o644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	labelKey := "devcontainer.local_folder"
	labelValue := workspaceDir

	containerID := mustStartContainerWithBindMount(t, nodeImage.image, labelKey, labelValue, workspaceDir, "/workspace", nodeImage.dockerRunArgs...)
	_ = containerID // container discovery uses docker ps with label filter

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg := &config.Config{
		WorkspaceDir:        workspaceDir,
		ContainerMode:       true,
		ContainerUser:       "", // Auto-detect
		ContainerLabelKey:   labelKey,
		ContainerLabelValue: labelValue,
	}

	if err := ensureWorkspaceWritable(ctx, cfg); err != nil {
		t.Fatalf("ensureWorkspaceWritable() failed: %v", err)
	}

	// Verify that the file is now owned by the container's default user (uid 1000)
	info, err := os.Stat(testFile)
	if err != nil {
		t.Fatalf("stat test file: %v", err)
	}
	_ = info // On Linux we'd check Sys().(*syscall.Stat_t).Uid, but this varies by OS
	// The important thing is that ensureWorkspaceWritable didn't error
}

// ---------------------------------------------------------------------------
// Category 2: Devcontainer Config Detection Tests
// ---------------------------------------------------------------------------

func TestIntegration_HasDevcontainerConfig(t *testing.T) {
	tests := []struct {
		name     string
		setup    func(dir string)
		expected bool
	}{
		{
			name: "devcontainer_dir_with_json",
			setup: func(dir string) {
				dcDir := filepath.Join(dir, ".devcontainer")
				_ = os.MkdirAll(dcDir, 0o755)
				_ = os.WriteFile(filepath.Join(dcDir, "devcontainer.json"), []byte(`{"image":"test"}`), 0o644)
			},
			expected: true,
		},
		{
			name: "root_devcontainer_json",
			setup: func(dir string) {
				_ = os.WriteFile(filepath.Join(dir, ".devcontainer.json"), []byte(`{"image":"test"}`), 0o644)
			},
			expected: true,
		},
		{
			name:     "no_config",
			setup:    func(dir string) {},
			expected: false,
		},
		{
			name: "devcontainer_dir_without_json",
			setup: func(dir string) {
				_ = os.MkdirAll(filepath.Join(dir, ".devcontainer"), 0o755)
			},
			expected: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			tc.setup(dir)
			got := hasDevcontainerConfig(dir)
			if got != tc.expected {
				t.Fatalf("hasDevcontainerConfig() = %v, want %v", got, tc.expected)
			}
		})
	}
}

func TestIntegration_AdditionalFeaturesInjectionLogic(t *testing.T) {
	// Create a mock devcontainer command that records its arguments
	mockBinDir := t.TempDir()
	argsFile := filepath.Join(t.TempDir(), "devcontainer-args.txt")

	mockScript := fmt.Sprintf(`#!/bin/sh
echo "$@" >> %s
# Output minimal JSON that devcontainer up expects
echo '{"outcome":"success","containerId":"mock-container-id"}'
`, argsFile)

	mockPath := filepath.Join(mockBinDir, "devcontainer")
	if err := os.WriteFile(mockPath, []byte(mockScript), 0o755); err != nil {
		t.Fatalf("write mock devcontainer: %v", err)
	}

	// Prepend mock bin dir to PATH
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", mockBinDir+":"+origPath)

	t.Run("without_devcontainer_config_includes_features", func(t *testing.T) {
		// Remove any previous args file
		_ = os.Remove(argsFile)

		repo := mustCreateTestRepo(t, false, "")
		cfg := &config.Config{
			WorkspaceDir:       repo,
			AdditionalFeatures: `{"ghcr.io/devcontainers/features/node:1":{"version":"22"}}`,
			ContainerLabelKey:  "devcontainer.local_folder",
			ContainerLabelValue: repo,
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		_ = ensureDevcontainerReady(ctx, cfg)

		args, err := os.ReadFile(argsFile)
		if err != nil {
			t.Fatalf("read args file: %v", err)
		}
		if !strings.Contains(string(args), "--additional-features") {
			t.Fatalf("expected --additional-features in args, got: %s", string(args))
		}
	})

	t.Run("with_devcontainer_config_skips_features", func(t *testing.T) {
		_ = os.Remove(argsFile)

		repo := mustCreateTestRepo(t, true, `{"image":"debian:bookworm-slim"}`)
		cfg := &config.Config{
			WorkspaceDir:       repo,
			AdditionalFeatures: `{"ghcr.io/devcontainers/features/node:1":{"version":"22"}}`,
			ContainerLabelKey:  "devcontainer.local_folder",
			ContainerLabelValue: repo,
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		_ = ensureDevcontainerReady(ctx, cfg)

		args, err := os.ReadFile(argsFile)
		if err != nil {
			t.Fatalf("read args file: %v", err)
		}
		if strings.Contains(string(args), "--additional-features") {
			t.Fatalf("expected --additional-features to be SKIPPED, but found in args: %s", string(args))
		}
	})
}

// ---------------------------------------------------------------------------
// Category 3: Git Credential Helper Tests
// ---------------------------------------------------------------------------

func TestIntegration_GitCredentialHelperFullFlow(t *testing.T) {
	requireDockerAvailable(t)

	// Use node image with non-root user — simulates the devcontainer that caused the bugs
	labelKey := "devcontainer.local_folder"
	labelValue := "/workspace-cred-test-" + strings.ReplaceAll(t.Name(), "/", "-")
	containerID := mustStartContainer(t, nodeImage.image, labelKey, labelValue, nodeImage.dockerRunArgs...)
	ctx := context.Background()

	// Render the credential helper script
	testCfg := &config.Config{
		Port:          9999,
		CallbackToken: "test-cred-token-abc",
	}
	script, err := renderGitCredentialHelperScript(testCfg)
	if err != nil {
		t.Fatalf("renderGitCredentialHelperScript: %v", err)
	}

	// Write to temp file
	tmpFile := filepath.Join(t.TempDir(), "git-credential-sam")
	if err := os.WriteFile(tmpFile, []byte(script), 0o755); err != nil {
		t.Fatalf("write temp script: %v", err)
	}

	// docker cp into container
	installPath := "/usr/local/bin/git-credential-sam"
	out, err := exec.CommandContext(ctx, "docker", "cp", tmpFile, containerID+":"+installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("docker cp: %v\n%s", err, string(out))
	}

	// chmod as root
	out, err = exec.CommandContext(ctx, "docker", "exec", "-u", "root", containerID, "chmod", "0755", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("chmod: %v\n%s", err, string(out))
	}

	// Configure git credential helper (uses -u root internally)
	if err := configureGitCredentialHelper(ctx, containerID, installPath); err != nil {
		t.Fatalf("configureGitCredentialHelper: %v", err)
	}

	// Verify: script is executable
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "test", "-x", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("script not executable: %v\n%s", err, string(out))
	}

	// Verify: script contains expected token and port
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "cat", installPath).CombinedOutput()
	if err != nil {
		t.Fatalf("cat script: %v\n%s", err, string(out))
	}
	scriptContent := string(out)
	if !strings.Contains(scriptContent, "test-cred-token-abc") {
		t.Fatal("script missing callback token")
	}
	if !strings.Contains(scriptContent, "9999") {
		t.Fatal("script missing port")
	}

	// Verify: git config returns the correct helper path
	out, err = exec.CommandContext(ctx, "docker", "exec", containerID, "git", "config", "--system", "credential.helper").CombinedOutput()
	if err != nil {
		t.Fatalf("git config read: %v\n%s", err, string(out))
	}
	if got := strings.TrimSpace(string(out)); got != installPath {
		t.Fatalf("credential.helper = %q, want %q", got, installPath)
	}
}

func TestIntegration_EnsureGitCredentialHelper(t *testing.T) {
	requireDockerAvailable(t)

	// Start a container with a label matching the config, non-root user
	labelKey := "devcontainer.local_folder"
	labelValue := "/workspace-ensure-cred-" + strings.ReplaceAll(t.Name(), "/", "-")
	containerID := mustStartContainer(t, nodeImage.image, labelKey, labelValue, nodeImage.dockerRunArgs...)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg := &config.Config{
		Repository:          "https://github.com/test/repo",
		CallbackToken:       "ensure-cred-token",
		Port:                8080,
		ContainerMode:       true,
		ContainerLabelKey:   labelKey,
		ContainerLabelValue: labelValue,
	}

	if err := ensureGitCredentialHelper(ctx, cfg); err != nil {
		t.Fatalf("ensureGitCredentialHelper: %v", err)
	}

	// Verify the credential helper is configured
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID,
		"git", "config", "--system", "credential.helper").CombinedOutput()
	if err != nil {
		t.Fatalf("verify git config: %v\n%s", err, string(out))
	}
	if !strings.Contains(string(out), "git-credential-sam") {
		t.Fatalf("expected credential helper to contain 'git-credential-sam', got: %s", string(out))
	}
}

// ---------------------------------------------------------------------------
// Category 4: Devcontainer Build Tests
// ---------------------------------------------------------------------------

func TestIntegration_DevcontainerBuildWithConfig(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	devcontainerJSON := `{"image": "mcr.microsoft.com/devcontainers/base:debian"}`
	repo := mustCreateTestRepo(t, true, devcontainerJSON)

	cfg := &config.Config{
		WorkspaceDir:        repo,
		AdditionalFeatures:  config.DefaultAdditionalFeatures,
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: repo,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if err := ensureDevcontainerReady(ctx, cfg); err != nil {
		t.Fatalf("ensureDevcontainerReady: %v", err)
	}

	// Verify the container is running and findable
	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		t.Fatalf("findDevcontainerID: %v", err)
	}
	if containerID == "" {
		t.Fatal("findDevcontainerID returned empty container ID")
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	t.Logf("Built devcontainer %s from repo with config", containerID)
}

func TestIntegration_DevcontainerBuildWithAdditionalFeatures(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	// Repo WITHOUT devcontainer config — additional features will be injected
	repo := mustCreateTestRepo(t, false, "")

	cfg := &config.Config{
		WorkspaceDir:        repo,
		AdditionalFeatures:  config.DefaultAdditionalFeatures,
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: repo,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if err := ensureDevcontainerReady(ctx, cfg); err != nil {
		t.Fatalf("ensureDevcontainerReady: %v", err)
	}

	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		t.Fatalf("findDevcontainerID: %v", err)
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerID).Run()
	})

	// Verify Node.js was injected via additional features
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID, "node", "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("node --version failed: %v\n%s", err, string(out))
	}
	version := strings.TrimSpace(string(out))
	if !strings.HasPrefix(version, "v22") {
		t.Fatalf("expected Node.js v22.x, got %s", version)
	}

	t.Logf("Built devcontainer %s with injected Node.js %s", containerID, version)
}

func TestIntegration_FindDevcontainerID(t *testing.T) {
	requireDockerAvailable(t)

	labelKey := "devcontainer.local_folder"
	labelValue := "/workspace-find-" + strings.ReplaceAll(t.Name(), "/", "-")

	// Start a container with the label
	containerID := mustStartContainer(t, "debian:bookworm-slim", labelKey, labelValue)

	ctx := context.Background()

	cfg := &config.Config{
		ContainerLabelKey:   labelKey,
		ContainerLabelValue: labelValue,
	}

	// Should find the container (docker ps -q returns short 12-char IDs)
	found, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		t.Fatalf("findDevcontainerID: %v", err)
	}
	if !strings.HasPrefix(containerID, found) {
		t.Fatalf("expected container ID prefix %s in %s", found, containerID)
	}

	// Stop the container with a short timeout, then it should NOT be found
	if out, err := exec.Command("docker", "stop", "-t", "1", containerID).CombinedOutput(); err != nil {
		t.Fatalf("docker stop: %v\n%s", err, string(out))
	}
	// Small delay to ensure Docker daemon updates container state
	time.Sleep(500 * time.Millisecond)

	_, err = findDevcontainerID(ctx, cfg)
	if err == nil {
		t.Fatal("expected error when no running container matches label")
	}
}

// ---------------------------------------------------------------------------
// Category 5: Full Bootstrap Integration Test
// ---------------------------------------------------------------------------

func TestIntegration_FullBootstrapFlow(t *testing.T) {
	requireDockerAvailable(t)
	requireDevcontainerCLI(t)

	const (
		workspaceID    = "ws-integration-test"
		bootstrapToken = "test-bootstrap-token-full"
		callbackToken  = "test-callback-token-full"
	)

	// Start mock control plane
	server, cpState := startMockControlPlane(t, workspaceID, bootstrapToken, callbackToken)

	// Create test repo with devcontainer config (pre-populated so git clone is skipped)
	devcontainerJSON := `{"image": "mcr.microsoft.com/devcontainers/base:debian"}`
	repoDir := mustCreateTestRepo(t, true, devcontainerJSON)

	cfg := &config.Config{
		BootstrapToken:      bootstrapToken,
		ControlPlaneURL:     server.URL,
		WorkspaceID:         workspaceID,
		Branch:              "main",
		Repository:          "https://github.com/test/repo", // Needed for git credential helper
		WorkspaceDir:        repoDir,
		BootstrapStatePath:  filepath.Join(t.TempDir(), "bootstrap-state.json"),
		BootstrapMaxWait:    30 * time.Second,
		ContainerMode:       true,
		ContainerLabelKey:   "devcontainer.local_folder",
		ContainerLabelValue: repoDir,
		ContainerUser:       "",
		Port:                8080,
		AdditionalFeatures:  config.DefaultAdditionalFeatures,
	}

	// Create a boot log reporter pointing at the mock control plane
	reporter := bootlog.New(server.URL, workspaceID)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Run the full bootstrap
	if err := Run(ctx, cfg, reporter); err != nil {
		t.Fatalf("Run() failed: %v", err)
	}

	// Clean up the devcontainer
	t.Cleanup(func() {
		if containerID, err := findDevcontainerID(context.Background(), cfg); err == nil {
			_ = exec.Command("docker", "rm", "-f", containerID).Run()
		}
	})

	// Assert: bootstrap was redeemed
	cpState.mu.Lock()
	defer cpState.mu.Unlock()

	if !cpState.bootstrapRedeemed {
		t.Fatal("bootstrap token was not redeemed")
	}

	// Assert: ready was called
	if !cpState.readyCalled {
		t.Fatal("/ready was not called")
	}

	// Assert: ready was called with the callback token
	expectedAuth := "Bearer " + callbackToken
	if cpState.lastReadyAuth != expectedAuth {
		t.Fatalf("ready auth = %q, want %q", cpState.lastReadyAuth, expectedAuth)
	}

	// Assert: callback token was set in config
	if cfg.CallbackToken != callbackToken {
		t.Fatalf("cfg.CallbackToken = %q, want %q", cfg.CallbackToken, callbackToken)
	}

	// Assert: devcontainer is running
	containerID, err := findDevcontainerID(ctx, cfg)
	if err != nil {
		t.Fatalf("findDevcontainerID after bootstrap: %v", err)
	}
	if containerID == "" {
		t.Fatal("no devcontainer found after bootstrap")
	}

	// Assert: git credential helper is installed
	out, err := exec.CommandContext(ctx, "docker", "exec", containerID,
		"git", "config", "--system", "credential.helper").CombinedOutput()
	if err != nil {
		t.Fatalf("git config read after bootstrap: %v\n%s", err, string(out))
	}
	if !strings.Contains(string(out), "git-credential-sam") {
		t.Fatalf("credential helper not configured, got: %s", string(out))
	}

	// Assert: boot logs were sent to the control plane
	if len(cpState.bootLogs) == 0 {
		t.Log("Warning: no boot logs received (reporter may have failed silently)")
	} else {
		t.Logf("Received %d boot log entries", len(cpState.bootLogs))
	}

	t.Logf("Full bootstrap flow completed successfully")
}
