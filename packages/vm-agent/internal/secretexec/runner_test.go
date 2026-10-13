package secretexec

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func localCommand(args []string) *exec.Cmd {
	supervisor := SupervisorArgs(50 * time.Millisecond)
	return exec.Command(supervisor[0], append(supervisor[1:], args...)...)
}

func TestLiteralMultilineEnvAndLiveFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "live"), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	secret := "synthetic\n'$(exit 99)'"
	cmd := localCommand(nil)
	cmd.Dir = dir
	result := Run(context.Background(), cmd, Input{Argv: []string{"sh", "-c", "test -f live && printf '%s' \"$SELECTED\"; printf '%s' \"$OTHER\" >&2"}, Env: map[string]string{"SELECTED": secret, "OTHER": "placeholder"}, Secrets: []string{secret}, OutputLimit: 1000, GracePeriod: time.Second})
	if result.ExitCode != 0 || result.Stdout != "[REDACTED]" || result.Stderr != "placeholder" || !result.Redacted {
		t.Fatalf("result: %+v", result)
	}
}
func TestTimeoutKillsChildren(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "child-survived")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result := Run(ctx, localCommand(nil), Input{Argv: []string{"sh", "-c", "(sleep 0.4; touch \"$MARKER\") & wait"}, Env: map[string]string{"MARKER": marker}, OutputLimit: 1000, GracePeriod: time.Second})
	if !result.TimedOut {
		t.Fatalf("result: %+v", result)
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
