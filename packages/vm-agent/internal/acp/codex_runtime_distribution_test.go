package acp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCodexRuntimeRejectsWritableDockerShadowBeforeExecution(t *testing.T) {
	for _, writable := range []string{"binary", "parent"} {
		t.Run(writable, func(t *testing.T) {
			dir := t.TempDir()
			marker := filepath.Join(dir, "executed")
			binary := filepath.Join(dir, "docker")
			if err := os.WriteFile(binary, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
			if _, err := trustedCodexRuntimeDocker(); err != nil {
				t.Fatalf("trusted fixture rejected: %v", err)
			}
			target := binary
			if writable == "parent" {
				target = dir
			}
			if err := os.Chmod(target, 0777); err != nil {
				t.Fatal(err)
			}
			host := NewSessionHost(SessionHostConfig{})
			defer host.Stop()
			err := host.ensureCodexRuntimeInContainer(context.Background(), "fixture", agentCommandInfo{})
			if err == nil || !strings.Contains(err.Error(), "writable runtime Docker path") {
				t.Fatalf("expected trust rejection, got %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("untrusted Docker executed: %v", err)
			}
		})
	}
}

func TestCodexRuntimeInstallRejectsUntrustedOrigins(t *testing.T) {
	for _, origin := range []string{"", "ftp://example.com", "http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=secret", "https://example.com/#fragment", "https://example.com/';touch /tmp/injected", "https://$(touch.example.com)"} {
		if _, err := codexRuntimeInstallScript(origin, time.Second, time.Second); err == nil {
			t.Fatalf("accepted invalid origin %q", origin)
		}
	}
	for _, origin := range []string{"https://api.example.com", "https://api.example.com:8443/", "http://127.0.0.1:8080", "http://localhost:8080"} {
		script, err := codexRuntimeInstallScript(origin, time.Second, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if err := exec.Command("bash", "-n", "-c", script).Run(); err != nil {
			t.Fatalf("invalid shell: %v", err)
		}
	}
}

func TestCodexRuntimeDownloadFailureAndDeadline(t *testing.T) {
	for _, hangs := range []bool{false, true} {
		t.Run(map[bool]string{false: "download_failure", true: "forced_deadline"}[hangs], func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "args")
			fake := "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$CAPTURE_FILE\"\nexit 22\n"
			if hangs {
				fake = "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$CAPTURE_FILE\"\ntrap '' TERM\nsleep 30\n"
			}
			if err := os.WriteFile(filepath.Join(dir, "curl"), []byte(fake), 0755); err != nil {
				t.Fatal(err)
			}
			script, err := codexRuntimeInstallScript("https://api.example.com", 500*time.Millisecond, 100*time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("bash", "-c", script)
			cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "CAPTURE_FILE="+capture)
			started := time.Now()
			err = cmd.Run()
			if err == nil {
				t.Fatal("failed or stalled download accepted")
			}
			if time.Since(started) > 3*time.Second {
				t.Fatal("container deadline did not bound download")
			}
			data, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			args := strings.Split(strings.TrimSpace(string(data)), "\n")
			if !strings.Contains(args[len(args)-1], "/api/acp/codex-runtime/download?") || !strings.Contains(args[len(args)-1], codexRuntimeArchiveSHA) {
				t.Fatal("download did not target exact immutable release")
			}
			for index, arg := range args {
				if arg == "--output" {
					work := filepath.Dir(args[index+1])
					t.Cleanup(func() { _ = os.RemoveAll(work) })
					if !hangs {
						if _, err := os.Stat(work); !os.IsNotExist(err) {
							t.Fatal("failed download staging directory retained")
						}
					}
				}
			}
		})
	}
}

func TestCodexRuntimeVMInstallUsesSerializedRootBoundary(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "installed")
	calls := filepath.Join(dir, "calls")
	fake := `#!/usr/bin/env bash
set -eu
if [[ "$2" == -u ]]; then
 [[ "$3" == root ]]
 echo root >> "$INSTALL_CALLS"
 sleep 0.05
 touch "$INSTALL_STATE"
else
 echo check >> "$INSTALL_CALLS"
 [[ -f "$INSTALL_STATE" ]]
fi
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(fake), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("INSTALL_STATE", state)
	t.Setenv("INSTALL_CALLS", calls)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ControlPlaneURL: "https://api.example.com", CodexRuntimeInstallTimeout: 5 * time.Second}})
	defer host.Stop()
	info, err := selectCodexC2Candidate(getAgentCommandInfo("openai-codex", "api-key"), "openai-codex", "1")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- host.ensureCodexRuntimeInContainer(context.Background(), "fixture-container", info)
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "root\n") != 1 {
		t.Fatal("concurrent selections did not share one root install")
	}
	if strings.Count(string(data), "check\n") < 4 {
		t.Fatal("missing unprivileged verification/recheck")
	}
}

func TestCodexRuntimeInstantRequiresBakedRelease(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "must-not-install")
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ProcessLauncher: LocalLauncher{}}})
	defer host.Stop()
	err := host.ensureAgentInstalled(context.Background(), agentCommandInfo{verifyOnly: true, validationCmd: "false", installCmd: "touch " + marker})
	if err == nil {
		t.Fatal("unverified Instant runtime accepted")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("Instant attempted runtime installation")
	}
}

func TestAgentInstallQueueHonorsContextDeadline(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	releaseInstall, err := acquireAgentInstall(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- installAgentBinary(ctx, "fixture", agentCommandInfo{command: "missing", installCmd: "false"})
	}()
	select {
	case err := <-done:
		releaseInstall()
		if err != context.DeadlineExceeded {
			t.Fatalf("queue error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		releaseInstall()
		<-done
		t.Fatal("expired installation remained blocked on another install")
	}
}

func TestCodexRuntimeVerificationHasIndependentDeadline(t *testing.T) {
	// No host context: the in-container verifier must terminate itself.
	started := time.Now()
	script := codexRuntimeBoundedCommand("trap '' TERM; sleep 30", 100*time.Millisecond, 100*time.Millisecond)
	if err := exec.Command("bash", "-c", script).Run(); err == nil {
		t.Fatal("stalled verifier succeeded")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("verifier outlived independent deadline")
	}
}

func TestCodexRuntimeQueueConsumesInstallBudget(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "script")
	fake := `#!/usr/bin/env bash
if [[ "$2" == -u ]]; then
 printf '%s' "${@: -1}" > "$INSTALL_SCRIPT"
fi
exit 1
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(fake), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("INSTALL_SCRIPT", capture)
	release, err := acquireAgentInstall(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{ControlPlaneURL: "https://api.example.com", CodexRuntimeInstallTimeout: time.Second}})
	defer host.Stop()
	done := make(chan error, 1)
	go func() {
		done <- host.ensureCodexRuntimeInContainer(context.Background(), "fixture", agentCommandInfo{validationCmd: "false"})
	}()
	time.Sleep(400 * time.Millisecond)
	release()
	if err := <-done; err == nil {
		t.Fatal("failed installation accepted")
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 || fields[0] != "timeout" {
		t.Fatal("install missing container timeout")
	}
	seconds, err := strconv.ParseFloat(fields[2], 64)
	if err != nil {
		t.Fatal(err)
	}
	if seconds <= 0 || seconds > 0.75 {
		t.Fatalf("queue did not consume budget: %v", seconds)
	}
}
