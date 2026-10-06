package acp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCodexC2CandidateSelectionIsExplicit(t *testing.T) {
	stock := getAgentCommandInfo("openai-codex", "api-key")
	if stock.command != "codex-acp" {
		t.Fatalf("stock command = %q", stock.command)
	}
	info, err := selectCodexC2Candidate(stock, "openai-codex", "")
	if err != nil || info.command != stock.command || info.verifyOnly {
		t.Fatalf("unset selector changed stock path: %+v, %v", info, err)
	}
	info, err = selectCodexC2Candidate(stock, "openai-codex", "1")
	if err != nil || !info.verifyOnly || info.installCmd != "" || info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
		t.Fatalf("candidate path not selected: %+v, %v", info, err)
	}
	other, err := selectCodexC2Candidate(getAgentCommandInfo("claude-code", "api-key"), "claude-code", "1")
	if err != nil || other.command != "claude-agent-acp" || other.verifyOnly {
		t.Fatalf("candidate altered other provider: %+v, %v", other, err)
	}
	if _, err := selectCodexC2Candidate(stock, "openai-codex", "unexpected"); err == nil {
		t.Fatal("invalid selector accepted")
	}
	for _, value := range []string{" 1", "1 ", "true", "0"} {
		if _, err := selectCodexC2Candidate(stock, "openai-codex", value); err == nil {
			t.Fatalf("non-canonical selector %q accepted", value)
		}
	}
}

func TestCodexC2CandidateBoundToSessionRuntimeAssets(t *testing.T) {
	t.Setenv(codexC2CandidateEnv, "1") // a host-wide marker must not select another session
	credential := &agentCredential{credential: "test-key", credentialKind: "api-key"}
	selectedValue := "1"
	selected := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir(), ProcessLauncher: LocalLauncher{}},
		RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
			if selectedValue == "" {
				return RuntimeAssets{}, nil
			}
			return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: codexC2CandidateEnv, Value: selectedValue}}}, nil
		},
	})
	defer selected.Stop()
	if _, err := selected.selectSessionCodexRuntime("openai-codex", "1"); err != nil {
		t.Fatal(err)
	}
	startup, err := selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil)
	if err != nil || !startup.info.verifyOnly || startup.info.command != codexC2ReleaseRoot+"/current/bin/codex-acp" {
		t.Fatalf("selected session did not retain candidate: %+v, %v", startup, err)
	}
	if hasEnvVar(startup.envVars, codexC2CandidateEnv) {
		t.Fatal("internal selector leaked into adapter environment")
	}

	stock := NewSessionHost(SessionHostConfig{
		GatewayConfig:         GatewayConfig{ContainerWorkDir: t.TempDir(), ProcessLauncher: LocalLauncher{}},
		RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) { return RuntimeAssets{}, nil },
	})
	defer stock.Stop()
	stockStartup, err := stock.prepareAgentStartup(context.Background(), "openai-codex", credential, nil)
	if err != nil || stockStartup.info.verifyOnly || stockStartup.info.command != "codex-acp" {
		t.Fatalf("unselected session changed stock path: %+v, %v", stockStartup, err)
	}

	selectedValue = "" // profile marker removed before a restart: fail closed
	if _, err := selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil); err == nil {
		t.Fatal("candidate session silently fell back to stock after marker removal")
	}
	selectedValue = "unexpected"
	if _, err := selected.prepareAgentStartup(context.Background(), "openai-codex", credential, nil); err == nil {
		t.Fatal("invalid marker accepted on restart")
	}
}

func TestCodexC2CandidateVMProviderDoesNotApplyMergedFiles(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{Files: []RuntimeFile{{Path: "profile-file", Content: "unchanged"}}, EnvVars: []RuntimeEnvVar{{Key: "OTHER", Value: "value"}}}, nil
	}})
	defer host.Stop()
	env, err := host.applyRuntimeAssets(context.Background(), "vm-devcontainer", []string{"EXISTING=value"}, map[string]bool{})
	if err != nil || len(env) != 1 || env[0] != "EXISTING=value" {
		t.Fatalf("VM runtime asset behavior changed: %v, %v", env, err)
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

func TestCodexC2CandidateProcessCleanupTargetsExecChildren(t *testing.T) {
	got := containerProcessKillPatterns(codexC2ReleaseRoot + "/current/bin/codex-acp")
	if len(got) != 2 || !strings.Contains(got[0], `\+cli`) || !strings.Contains(got[1], `\+cli`) {
		t.Fatalf("candidate process cleanup targets = %v", got)
	}
	stock := containerProcessKillPatterns("codex-acp")
	if len(stock) != 1 || stock[0] != "codex-acp" {
		t.Fatalf("stock cleanup target changed: %v", stock)
	}
}

func TestCodexC2CandidateProcessCleanupSignalsActualArgv(t *testing.T) {
	if _, err := exec.LookPath("pkill"); err != nil {
		t.Skip("pkill unavailable")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	base := codexC2ReleaseRoot + "/releases/" + codexC2ReleaseIdentity + "/payload/"
	for _, signal := range []string{"TERM", "KILL"} {
		t.Run(signal, func(t *testing.T) {
			adapter := startDisposableArgvProcess(t, base+"adapter.js")
			cli := startDisposableArgvProcess(t, base+"codex")
			// Without escaping '+', this is a regex false positive.
			unrelated := startDisposableArgvProcess(t, strings.Replace(base, "+cli", "111cli", 1)+"codex")
			defer stopDisposableArgvProcess(unrelated)
			patterns := containerProcessKillPatterns(codexC2ReleaseRoot + "/current/bin/codex-acp")
			for _, pattern := range patterns {
				if output, err := exec.Command("pkill", "-"+signal, "-f", pattern).CombinedOutput(); err != nil {
					t.Fatalf("pkill %s %q: %v: %s", signal, pattern, err, output)
				}
			}
			waitDisposableExit(t, adapter)
			waitDisposableExit(t, cli)
			if err := syscall.Kill(unrelated.Process.Pid, 0); err != nil {
				t.Fatalf("unrelated process was signalled: %v", err)
			}
		})
	}
}

func startDisposableArgvProcess(t *testing.T, name string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("bash", "-c", `exec -a "$1" sleep 60`, "_", name)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopDisposableArgvProcess(cmd) })
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		argv, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", cmd.Process.Pid))
		executable, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", cmd.Process.Pid))
		if bytes.Contains(argv, []byte(name)) && strings.HasSuffix(executable, "/sleep") {
			return cmd
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("disposable process %d did not enter expected argv", cmd.Process.Pid)
	return nil
}

func waitDisposableExit(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("process %d survived cleanup signal", cmd.Process.Pid)
	}
}

func stopDisposableArgvProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
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

func TestCodexRuntimeAutomaticSelectionAndHostLifetime(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config AcpInteractionRuntimeConfig
		want   string
	}{
		{"forms", testFormConfig(), "1"}, {"urls", testURLConfig(), "1"},
		{"permissions", testInteractionConfig(), ""}, {"disabled", AcpInteractionRuntimeConfig{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir(), ProcessLauncher: LocalLauncher{}}})
			defer h.Stop()
			h.ConfigureAcpInteractions(tc.config)
			h.mu.Lock() // real startSelectedAgent/restartAgentLocked callers hold this lock
			start, err := h.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{credential: "test", credentialKind: "api-key"}, nil)
			h.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if start.info.verifyOnly != (tc.want == "1") {
				t.Fatalf("unexpected runtime %+v", start.info)
			}
			if tc.want == "1" {
				h.ConfigureAcpInteractions(AcpInteractionRuntimeConfig{})
			} else {
				h.ConfigureAcpInteractions(testFormConfig())
			}
			next, err := h.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{credential: "test", credentialKind: "api-key"}, nil)
			if err != nil || next.info.command != start.info.command || next.info.validationCmd != start.info.validationCmd {
				t.Fatalf("runtime changed across restart: %+v %v", next, err)
			}
		})
	}
}
func TestCodexRuntimeAutomaticSelectionDoesNotMaskExplicitChanges(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	defer h.Stop()
	h.ConfigureAcpInteractions(testFormConfig())
	if _, err := h.selectSessionCodexRuntime("openai-codex", "invalid"); err == nil {
		t.Fatal("invalid explicit marker masked by automatic selection")
	}
	if _, err := h.selectSessionCodexRuntime("openai-codex", "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.selectSessionCodexRuntime("openai-codex", ""); err == nil {
		t.Fatal("removed explicit marker masked by automatic selection")
	}
}
func TestCodexRuntimeAutomaticSelectionRequiresValidConfigAndProvider(t *testing.T) {
	h := NewSessionHost(SessionHostConfig{})
	defer h.Stop()
	invalid := testFormConfig()
	invalid.FormDeadlineMs = 0
	h.ConfigureAcpInteractions(invalid)
	if _, err := h.selectSessionCodexRuntime("openai-codex", ""); err == nil {
		t.Fatal("invalid config selected runtime")
	}
	h.ConfigureAcpInteractions(testFormConfig())
	if got, err := h.selectSessionCodexRuntime("claude-code", ""); err != nil || got != "" {
		t.Fatalf("non-Codex changed: %q %v", got, err)
	}
	if h.codexC2SelectionLatched {
		t.Fatal("non-Codex latched Codex runtime")
	}
}
