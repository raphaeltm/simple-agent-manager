package acp

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestApplyStandaloneRuntimeFilesWritesRelativeFiles(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	err := applyStandaloneRuntimeFiles(workDir, []RuntimeFile{{
		Path:    "config/app.env",
		Content: "SAM_RUNTIME_ASSET_TEST=present\n",
	}})
	if err != nil {
		t.Fatalf("applyStandaloneRuntimeFiles returned error: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(workDir, "config", "app.env"))
	if err != nil {
		t.Fatalf("read runtime file: %v", err)
	}
	if string(content) != "SAM_RUNTIME_ASSET_TEST=present\n" {
		t.Fatalf("content = %q", string(content))
	}
}

func TestApplyStandaloneRuntimeFilesRejectsTraversal(t *testing.T) {
	t.Parallel()

	err := applyStandaloneRuntimeFiles(t.TempDir(), []RuntimeFile{{
		Path:    "../secret.txt",
		Content: "nope",
	}})
	if err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}

func TestApplyStandaloneRuntimeFilesWritesSecretFiles0600(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX file mode assertion")
	}

	workDir := t.TempDir()
	err := applyStandaloneRuntimeFiles(workDir, []RuntimeFile{{
		Path:     ".secrets/token",
		Content:  "secret",
		IsSecret: true,
	}})
	if err != nil {
		t.Fatalf("applyStandaloneRuntimeFiles returned error: %v", err)
	}

	info, err := os.Stat(filepath.Join(workDir, ".secrets", "token"))
	if err != nil {
		t.Fatalf("stat runtime file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("secret file mode = %o, want 0600", perm)
	}
}

func TestResolveStandaloneRuntimeFilePathExpandsHome(t *testing.T) {
	t.Parallel()

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("home directory unavailable")
	}

	got, err := resolveStandaloneRuntimeFilePath(t.TempDir(), "~/.sam/config")
	if err != nil {
		t.Fatalf("resolveStandaloneRuntimeFilePath returned error: %v", err)
	}
	want := filepath.Join(home, ".sam", "config")
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestManagedSecretOverridesFallbackWithPlaceholder(t *testing.T) {
	env, err := appendRuntimeEnvVars([]string{"SENTINEL=synthetic-fallback"}, map[string]bool{}, []RuntimeEnvVar{{Key: "SENTINEL", Value: "synthetic-old-state", IsSecret: true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env[0] != "SENTINEL=__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__SENTINEL__" {
		t.Fatalf("unexpected env %v", env)
	}
}

func TestFreshContainerSessionGetsEnvOverlayWithoutWritingFiles(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir()}, RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{
			EnvVars: []RuntimeEnvVar{{Key: "SENTINEL", Value: "synthetic-profile", IsSecret: true}, {Key: "PLAIN", Value: "current-profile"}},
			Files:   []RuntimeFile{{Path: "must-not-write", Content: "synthetic-file"}},
		}, nil
	}})
	defer host.Stop()
	keys := map[string]bool{}
	env, err := host.applyRuntimeAssets(context.Background(), "existing-container", []string{"SENTINEL=stale-bootstrap", "PLAIN=stale"}, keys)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(env, []string{"SENTINEL=__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__SENTINEL__", "PLAIN=current-profile"}) {
		t.Fatalf("overlay %v", env)
	}
	if _, err := os.Stat(filepath.Join(host.config.ContainerWorkDir, "must-not-write")); err == nil {
		t.Fatal("container session rewrote runtime files")
	}
	if !keys["SENTINEL"] {
		t.Fatal("managed protected key not tracked")
	}
}
func TestProtectedEnvCannotRegainHarnessValues(t *testing.T) {
	for _, key := range []string{"GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		_, err := protectManagedSecretEnv([]string{key + "=" + managedSecretPlaceholder(key), key + "=synthetic-harness"}, map[string]bool{key: true})
		if err == nil || strings.Contains(err.Error(), "synthetic-harness") {
			t.Fatalf("collision not safely rejected %v", err)
		}
		env, err := protectManagedSecretEnv(nil, map[string]bool{key: true})
		if err != nil || !hasManagedSecretPlaceholder(env, key) {
			t.Fatal("auth-file removal did not restore placeholder")
		}
	}
}

func TestManagedGitPlaceholderDoesNotFetchFallback(t *testing.T) {
	called := false
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		SAMEnvFallback:  []string{"GH_TOKEN=" + managedSecretPlaceholder("GH_TOKEN")},
		GitTokenFetcher: func(context.Context) (string, error) { called = true; return "synthetic-platform", nil },
	}})
	defer host.Stop()
	env := host.resolveAgentEnvVars(context.Background(), "")
	if called || !hasManagedSecretPlaceholder(env, "GH_TOKEN") {
		t.Fatal("managed Git placeholder was replaced")
	}
}
func TestProviderCollisionFailsInActualStartupPipeline(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir()}, RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: "ANTHROPIC_API_KEY", Value: "synthetic-managed", IsSecret: true}}}, nil
	}})
	defer host.Stop()
	_, err := host.prepareAgentStartup(context.Background(), "claude-code", &agentCredential{credential: "synthetic-harness", credentialKind: "api-key"}, nil)
	if err == nil || !strings.Contains(err.Error(), "conflicts with harness") || strings.Contains(err.Error(), "synthetic-harness") {
		t.Fatal("actual startup did not safely reject credential collision")
	}
}
