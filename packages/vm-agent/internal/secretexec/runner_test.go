package secretexec

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func localCommand(t *testing.T, args []string) *exec.Cmd {
	t.Helper()
	supervisor := SupervisorArgs(50 * time.Millisecond)
	cmd := exec.Command(supervisor[0], append(supervisor[1:], args...)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir(), "LANG=C"}
	return cmd
}

func TestLiteralMultilineEnvAndLiveFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "live"), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	secret := "synthetic\n'$(exit 99)'"
	cmd := localCommand(t, nil)
	cmd.Dir = dir
	result := Run(context.Background(), cmd, Input{Argv: []string{"sh", "-c", "test -f live && printf '%s' \"$SELECTED\"; printf '%s' \"$OTHER\" >&2"}, Env: map[string]string{"SELECTED": secret, "OTHER": "placeholder"}, Secrets: []string{secret}, OutputLimit: 1000, GracePeriod: time.Second})
	if result.ExitCode != 0 || result.Stdout != "[REDACTED]" || result.Stderr != "placeholder" || !result.Redacted {
		t.Fatalf("unexpected execution result: exit=%d stdoutBytes=%d stderrBytes=%d", result.ExitCode, len(result.Stdout), len(result.Stderr))
	}
}
func TestTimeoutKillsChildren(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "child-survived")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result := Run(ctx, localCommand(t, nil), Input{Argv: []string{"sh", "-c", "(sleep 0.4; touch \"$MARKER\") & wait"}, Env: map[string]string{"MARKER": marker}, OutputLimit: 1000, GracePeriod: time.Second})
	if !result.TimedOut {
		t.Fatalf("unexpected execution result: exit=%d stdoutBytes=%d stderrBytes=%d", result.ExitCode, len(result.Stdout), len(result.Stderr))
	}
	time.Sleep(450 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("child survived timeout")
	}
}
func TestOutputBoundaryRedactionAndCap(t *testing.T) {
	secret := "synthetic-sentinel"
	w := NewRedactor([]string{secret}, 25)
	for _, part := range []string{"pre synthetic-", "sentinel post ", strings.Repeat("x", 100)} {
		_, _ = w.Write([]byte(part))
	}
	output, redacted, truncated := w.Finish()
	if strings.Contains(output, secret) || !strings.Contains(output, "[REDACTED]") || !redacted || !truncated || len(output) > 25 {
		t.Fatalf("%q %v %v", output, redacted, truncated)
	}
}

func TestLiteralArgvHasNoShellExpansion(t *testing.T) {
	literal := "$HOME; printf unsafe 'quoted'\nline"
	result := Run(context.Background(), localCommand(t, nil), Input{Argv: []string{"printf", "%s", literal}, OutputLimit: 1000, GracePeriod: time.Second})
	if result.ExitCode != 0 || result.Stdout != literal {
		t.Fatalf("literal argv failed: exit=%d stdoutBytes=%d", result.ExitCode, len(result.Stdout))
	}
}

func TestEmptyInjectionDoesNotPrintInheritedEnvironment(t *testing.T) {
	cmd := localCommand(t, nil)
	// Deliberately synthetic: never inherit the test runner's environment.
	cmd.Env = append(cmd.Env, "SYNTHETIC_EXPORT_CANARY=synthetic-export-regression")
	result := Run(context.Background(), cmd, Input{Argv: []string{"true"}, OutputLimit: 1000, GracePeriod: time.Second})
	if result.ExitCode != 0 || result.Stdout != "" || result.Stderr != "" {
		t.Fatalf("empty injection emitted output: exit=%d stdoutBytes=%d stderrBytes=%d", result.ExitCode, len(result.Stdout), len(result.Stderr))
	}
}
func TestCancellationKillsChildren(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child-survived")
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(100*time.Millisecond, cancel)
	defer timer.Stop()
	defer cancel()
	result := Run(ctx, localCommand(t, nil), Input{Argv: []string{"sh", "-c", "(sleep 0.4; touch \"$MARKER\") & wait"}, Env: map[string]string{"MARKER": marker}, OutputLimit: 1000, GracePeriod: time.Second})
	if result.TimedOut || result.ExitCode == 0 {
		t.Fatalf("cancel failed: exit=%d timedOut=%v", result.ExitCode, result.TimedOut)
	}
	time.Sleep(450 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("child survived cancel")
	}
}

func TestExecutionUsesCurrentIdentityAndCwd(t *testing.T) {
	dir := t.TempDir()
	cmd := localCommand(t, nil)
	cmd.Dir = dir
	result := Run(context.Background(), cmd, Input{Argv: []string{"sh", "-c", "printf '%s:%s:%s' \"$(id -u)\" \"$(id -g)\" \"$PWD\""}, OutputLimit: 1000, GracePeriod: time.Second})
	expected := fmt.Sprintf("%d:%d:%s", os.Getuid(), os.Getgid(), dir)
	if result.ExitCode != 0 || result.Stdout != expected {
		t.Fatalf("identity/cwd mismatch: exit=%d stdoutBytes=%d", result.ExitCode, len(result.Stdout))
	}
}

func TestEnvironmentCannotClobberSupervisorState(t *testing.T) {
	names := []string{"count", "i", "key", "value", "argv", "child", "code", "watcher", "signal", "env_entries", "item", "apply_env"}
	env := map[string]string{}
	for _, name := range names {
		env[name] = "synthetic-" + name + "\n'$(exit 99)'"
	}
	// External printenv observes values literally, including the names used by the supervisor.
	argv := append([]string{"printenv"}, names...)
	result := Run(context.Background(), localCommand(t, nil), Input{Argv: argv, Env: env, OutputLimit: 10000, GracePeriod: time.Second})
	expected := []string{}
	for _, name := range names {
		expected = append(expected, env[name])
	}
	if result.ExitCode != 0 || result.Stdout != strings.Join(expected, "\n")+"\n" {
		t.Fatalf("environment collision: exit=%d stdoutBytes=%d stderrBytes=%d", result.ExitCode, len(result.Stdout), len(result.Stderr))
	}
}
