package acp

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexRuntimeSelectorValues(t *testing.T) {
	stock := getAgentCommandInfo("openai-codex", "api-key")
	if stock.command != "codex-acp" {
		t.Fatalf("stock command = %q", stock.command)
	}
	info, err := selectCodexC2Candidate(stock, "openai-codex", codexRuntimeStock)
	if err != nil || info.command != stock.command || info.verifyOnly {
		t.Fatalf("stock opt-out changed the stock path: %+v, %v", info, err)
	}
	info, err = selectCodexC2Candidate(stock, "openai-codex", codexRuntimeC2)
	if err != nil || !info.verifyOnly || info.installCmd != "" || info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
		t.Fatalf("candidate path not selected: %+v, %v", info, err)
	}
	other, err := selectCodexC2Candidate(getAgentCommandInfo("claude-code", "api-key"), "claude-code", codexRuntimeC2)
	if err != nil || other.command != "claude-agent-acp" || other.verifyOnly {
		t.Fatalf("candidate altered other provider: %+v, %v", other, err)
	}
	for _, value := range []string{"", "unexpected", " 1", "1 ", "true", "false", "00"} {
		if _, err := selectCodexC2Candidate(stock, "openai-codex", value); err == nil {
			t.Fatalf("non-canonical selector %q accepted", value)
		}
	}
}

func TestCodexRuntimeBoundToSessionRuntimeAssets(t *testing.T) {
	t.Setenv(codexC2CandidateEnv, "0") // a host-wide marker must not select another session
	credential := &agentCredential{credential: "test-key", credentialKind: "api-key"}
	hostWithMarker := func(value *string) *SessionHost {
		return NewSessionHost(SessionHostConfig{
			GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir(), ProcessLauncher: LocalLauncher{}},
			RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
				if *value == "" {
					return RuntimeAssets{}, nil
				}
				return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: codexC2CandidateEnv, Value: *value}}}, nil
			},
		})
	}

	// No marker: the default is C2, whatever the host env says.
	none := ""
	defaulted := hostWithMarker(&none)
	defer defaulted.Stop()
	startup, err := defaulted.prepareAgentStartup(context.Background(), "openai-codex", credential, nil)
	if err != nil || !startup.info.verifyOnly || startup.info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
		t.Fatalf("unmarked session did not default to C2: %+v, %v", startup, err)
	}

	// Explicit "1" keeps C2 and never leaks the marker to the adapter.
	c2 := "1"
	selected := hostWithMarker(&c2)
	defer selected.Stop()
	startup, err = selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil)
	if err != nil || !startup.info.verifyOnly || startup.info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
		t.Fatalf("selected session did not retain candidate: %+v, %v", startup, err)
	}
	if hasEnvVar(startup.envVars, codexC2CandidateEnv) {
		t.Fatal("internal selector leaked into adapter environment")
	}

	// "0" opts the profile out to the stock adapter, without leaking the marker.
	optOut := "0"
	stock := hostWithMarker(&optOut)
	defer stock.Stop()
	stockStartup, err := stock.prepareAgentStartup(context.Background(), "openai-codex", credential, nil)
	if err != nil || stockStartup.info.verifyOnly || stockStartup.info.command != "codex-acp" {
		t.Fatalf("opted-out session did not use the stock path: %+v, %v", stockStartup, err)
	}
	if hasEnvVar(stockStartup.envVars, codexC2CandidateEnv) {
		t.Fatal("internal selector leaked into stock adapter environment")
	}

	// A marker that changes before a restart fails closed in both directions: a running
	// host never silently swaps its executable.
	c2 = ""
	if _, err := selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil); err == nil {
		t.Fatal("candidate session silently changed runtime after marker removal")
	}
	optOut = ""
	if _, err := stock.prepareAgentStartup(context.Background(), "openai-codex", credential, nil); err == nil {
		t.Fatal("stock session silently switched to C2 after marker removal")
	}
	c2 = "unexpected"
	if _, err := selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil); err == nil {
		t.Fatal("invalid marker accepted on restart")
	}
}

func TestCodexC2CandidateVMProviderAppliesEnvWithoutChangingMergedFiles(t *testing.T) {
	workDir := t.TempDir()
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: workDir}, RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{Files: []RuntimeFile{{Path: "profile-file", Content: "unchanged"}}, EnvVars: []RuntimeEnvVar{{Key: "OTHER", Value: "value"}}}, nil
	}})
	defer host.Stop()
	env, err := host.applyRuntimeAssets(context.Background(), "vm-devcontainer", []string{"EXISTING=value"}, map[string]bool{})
	if err != nil || len(env) != 2 || env[0] != "EXISTING=value" || env[1] != "OTHER=value" {
		t.Fatal("current per-session env overlay missing")
	}
	if _, err := os.Stat(filepath.Join(workDir, "profile-file")); err == nil {
		t.Fatal("container session rewrote merged runtime files")
	}
}

func TestCodexC2CandidateRejectsDuplicateRuntimeMarkers(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{EnvVars: []RuntimeEnvVar{
			{Key: codexC2CandidateEnv, Value: "1"},
			{Key: codexC2CandidateEnv, Value: ""},
		}}, nil
	}})
	defer host.Stop()
	if _, err := host.resolveCodexC2Selector(context.Background(), "openai-codex"); err == nil {
		t.Fatal("duplicate runtime marker silently selected the last value")
	}
}

func TestCodexC2CandidateRejectsPresentEmptyRuntimeMarker(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: codexC2CandidateEnv, Value: ""}}}, nil
	}})
	defer host.Stop()
	if _, err := host.resolveCodexC2Selector(context.Background(), "openai-codex"); err == nil {
		t.Fatal("present empty runtime marker silently selected stock")
	}
}

func TestCodexC2CandidateRealBundle(t *testing.T) {
	root := os.Getenv("SAM_CODEX_C2_TEST_RELEASE_ROOT")
	if root == "" {
		t.Skip("set SAM_CODEX_C2_TEST_RELEASE_ROOT to a verified local bundle")
	}
	check := strings.Replace(codexC2CandidateCheck, codexC2ReleaseRoot, root, 1)
	if output, err := exec.Command("sh", "-c", check).CombinedOutput(); err != nil {
		t.Fatalf("real staged release check failed: %v: %s", err, output)
	}
}

func TestCodexC2CandidateRejectsBrokenHostInRealBundle(t *testing.T) {
	root := os.Getenv("SAM_CODEX_C2_TEST_RELEASE_ROOT")
	if root == "" {
		t.Skip("set SAM_CODEX_C2_TEST_RELEASE_ROOT to a verified local bundle")
	}
	copyRoot, err := os.MkdirTemp(filepath.Dir(root), "codex-c2-negative-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(copyRoot) })
	if output, err := exec.Command("cp", "-a", "--reflink=auto", root+"/.", copyRoot).CombinedOutput(); err != nil {
		t.Fatalf("copy reviewed bundle: %v: %s", err, output)
	}
	current := filepath.Join(copyRoot, "current")
	if err := os.Remove(current); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("releases", codexC2ReleaseIdentity), current); err != nil {
		t.Fatal(err)
	}
	check := strings.Replace(codexC2CandidateCheck, codexC2ReleaseRoot, copyRoot, 1)
	runCheck := func(wantSuccess bool) {
		t.Helper()
		output, err := exec.Command("sh", "-c", check).CombinedOutput()
		if (err == nil) != wantSuccess {
			t.Fatalf("candidate check success=%v, want %v: %v: %s", err == nil, wantSuccess, err, output)
		}
	}
	host := filepath.Join(copyRoot, "releases", codexC2ReleaseIdentity, "payload", "codex-code-mode-host")
	runCheck(true)
	t.Run("missing", func(t *testing.T) {
		backup := filepath.Join(copyRoot, "host-backup")
		if err := os.Rename(host, backup); err != nil {
			t.Fatal(err)
		}
		runCheck(false)
		if err := os.Rename(backup, host); err != nil {
			t.Fatal(err)
		}
		runCheck(true)
	})
	t.Run("tampered", func(t *testing.T) {
		info, err := os.Stat(host)
		if err != nil {
			t.Fatal(err)
		}
		f, err := os.OpenFile(host, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte("tampered")); err != nil {
			_ = f.Close()
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		runCheck(false)
		if err := os.Truncate(host, info.Size()); err != nil {
			t.Fatal(err)
		}
		runCheck(true)
	})
	t.Run("non_executable", func(t *testing.T) {
		if err := os.Chmod(host, 0644); err != nil {
			t.Fatal(err)
		}
		runCheck(false)
		if err := os.Chmod(host, 0755); err != nil {
			t.Fatal(err)
		}
		runCheck(true)
	})
}

func TestCodexC2CandidateCatalogMatchesReviewedFile(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "scripts", "diagnostics", "pinned-codex-catalog", codexC2ReleaseIdentity+".sha256")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(codexC2CandidateCheck, fmt.Sprintf("%x", sha256.Sum256(content))) {
		t.Fatal("compiled staging trust digest differs from reviewed catalog")
	}
}

func TestCodexC2CandidateMissingReleaseFailsClosed(t *testing.T) {
	// The candidate path is absent in ordinary CI. A verify-only selection must
	// fail without running the stock npm installer or launching an agent.
	if !strings.Contains(codexC2CandidateCheck, "sha256sum --check --status") {
		t.Fatal("candidate no longer verifies full release")
	}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ProcessLauncher: LocalLauncher{}}})
	defer host.Stop()
	if err := host.ensureAgentInstalled(context.Background(), agentCommandInfo{
		command: codexC2ReleaseRoot + "/current/bin/codex-acp", validationCmd: "exit 1", verifyOnly: true,
	}); err == nil {
		t.Fatal("failed candidate verification fell back to stock")
	}
}

// The incident: task-mode Codex sessions (permission interactions only, the shape
// buildAcpInteractionRuntimeConfig sends for every non-conversation task) and hosts with
// interactions disabled ran the stock adapter and could not steer. C2 must not depend on
// the interaction configuration at all.
func TestCodexRuntimeDefaultIgnoresInteractionConfig(t *testing.T) {
	invalid := testFormConfig()
	invalid.FormDeadlineMs = 0
	for _, tc := range []struct {
		name   string
		config AcpInteractionRuntimeConfig
	}{
		{"task mode (permissions only)", testInteractionConfig()},
		{"interactions disabled", AcpInteractionRuntimeConfig{}},
		{"conversation forms", testFormConfig()},
		{"conversation urls", testURLConfig()},
		{"invalid forms config", invalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir(), ProcessLauncher: LocalLauncher{}}})
			defer h.Stop()
			h.ConfigureAcpInteractions(tc.config)
			h.mu.Lock() // real startSelectedAgent/restartAgentLocked callers hold this lock
			start, err := h.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{credential: "test", credentialKind: "api-key"}, nil)
			h.mu.Unlock()
			if err != nil || !start.info.verifyOnly || start.info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
				t.Fatalf("Codex did not select C2: %+v, %v", start, err)
			}
			// A later interaction-config change cannot swap the executable across a restart.
			h.ConfigureAcpInteractions(AcpInteractionRuntimeConfig{})
			next, err := h.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{credential: "test", credentialKind: "api-key"}, nil)
			if err != nil || next.info.command != start.info.command || next.info.validationCmd != start.info.validationCmd {
				t.Fatalf("runtime changed across restart: %+v %v", next, err)
			}
		})
	}
}

func TestCodexRuntimeSelectionDoesNotMaskExplicitChanges(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	defer h.Stop()
	if _, err := h.selectSessionCodexRuntime("openai-codex", "invalid"); err == nil {
		t.Fatal("invalid explicit marker masked by the default")
	}
	if _, err := h.selectSessionCodexRuntime("openai-codex", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.selectSessionCodexRuntime("openai-codex", ""); err == nil {
		t.Fatal("removed explicit marker masked by the default")
	}
}

func TestCodexRuntimeSelectionLeavesOtherAgentsAlone(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	defer h.Stop()
	if got, err := h.selectSessionCodexRuntime("claude-code", ""); err != nil || got != "" {
		t.Fatalf("non-Codex changed: %q %v", got, err)
	}
	if h.codexC2SelectionLatched {
		t.Fatal("non-Codex latched Codex runtime")
	}
}
