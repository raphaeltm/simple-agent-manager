package acp

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// Run real processes and production /proc scripts in this namespace, refusing
// legacy broad pkill so regressions cannot kill the test runner or live agent.
func installProcessDockerTransport(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := `#!/usr/bin/python3
import os, sys
args=sys.argv[1:]
assert args.pop(0)=='exec'
env=dict(os.environ)
while args and args[0].startswith('-'):
 flag=args.pop(0)
 if flag in ('-u','-w'): args.pop(0)
 elif flag=='-e':
  key,value=args.pop(0).split('=',1); env[key]=value
 elif flag=='--env-file':
  for line in open(args.pop(0)):
   key,value=line.rstrip('\n').split('=',1); env[key]=value
 elif flag!='-i': raise Exception(flag)
assert args.pop(0)=='test-container'
if args[0]=='pkill': sys.exit(1)
os.execvpe(args[0],args,env)
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func startCleanupFixture(t *testing.T, script string) *AgentProcess {
	t.Helper()
	p, err := StartProcess(ProcessConfig{ContainerID: "test-container", AcpCommand: "sh", AcpArgs: []string{"-c", script}, StopGracePeriod: 50 * time.Millisecond, StopTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop() })
	return p
}

func TestContainerStopPreservesPeerAndKillsOwnedOrphan(t *testing.T) {
	installProcessDockerTransport(t)
	// Clear env and ignore TERM: capture ancestry before the parent exits.
	owner := startCleanupFixture(t, `env -i PATH=/usr/bin:/bin sh -c 'trap "" TERM; echo $$; while :; do sleep 1; done' & child=$!; read request; wait "$child"`)
	scanner := bufio.NewScanner(owner.Stdout())
	if !scanner.Scan() {
		t.Fatal("owner child did not become ready")
	}
	child, err := strconv.Atoi(scanner.Text())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	peer := startCleanupFixture(t, `echo ready; while read request; do echo "peer:$request"; done`)
	if owner.containerOwner == peer.containerOwner {
		t.Fatal("two launches shared an ownership marker")
	}
	peerOutput := bufio.NewScanner(peer.Stdout())
	if !peerOutput.Scan() || peerOutput.Text() != "ready" {
		t.Fatal("peer not ready")
	}
	if err := owner.Stop(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", child)); err != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", child)); err == nil {
		t.Fatal("owned TERM-resistant orphan leaked")
	}
	if _, err := fmt.Fprintln(peer.Stdin(), "still-running"); err != nil {
		t.Fatal(err)
	}
	if !peerOutput.Scan() || peerOutput.Text() != "peer:still-running" {
		t.Fatal("same-type peer was stopped")
	}
	replacement := startCleanupFixture(t, `echo replacement; read request`)
	out := bufio.NewScanner(replacement.Stdout())
	if !out.Scan() {
		t.Fatal("replacement not ready")
	}
	if err := replacement.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(peer.Stdin(), "after-restart"); err != nil {
		t.Fatal(err)
	}
	if !peerOutput.Scan() || peerOutput.Text() != "peer:after-restart" {
		t.Fatal("peer lost after restart")
	}
}

func TestContainerCleanupRejectsReusedPID(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	output, err := exec.Command("sh", "-c", containerSignalScript, "sam-signal", "KILL", strconv.Itoa(cmd.Process.Pid), "0").CombinedOutput()
	if err != nil {
		t.Fatalf("signal: %v %s", err, output)
	}
	if err := syscall.Kill(cmd.Process.Pid, 0); err != nil {
		t.Fatal("reused PID was signalled")
	}
}

func TestContainerCleanupWithoutOwnershipNeverUsesCommandPatterns(t *testing.T) {
	installProcessDockerTransport(t)
	p := &AgentProcess{containerID: "test-container", agentType: "sh"}
	if err := p.killContainerProcesses(syscall.SIGTERM); err == nil {
		t.Fatal("missing ownership must fail visibly")
	}
}

func TestContainerLaunchOwnershipOverridesProfileEnv(t *testing.T) {
	installProcessDockerTransport(t)
	p, err := StartProcess(ProcessConfig{ContainerID: "test-container", AcpCommand: "sh", AcpArgs: []string{"-c", `printf '%s\n' "$SAM_ACP_PROCESS_OWNER"`}, EnvVars: []string{"SAM_ACP_PROCESS_OWNER=profile-collision"}})
	if err != nil {
		t.Fatal(err)
	}
	out := bufio.NewScanner(p.Stdout())
	if !out.Scan() {
		t.Fatal("missing marker")
	}
	if len(out.Text()) != 32 {
		t.Fatalf("invalid per-launch marker: %q", out.Text())
	}
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestContainerCleanupFindsMarkedExecChildAfterParentExit(t *testing.T) {
	installProcessDockerTransport(t)
	owner := startCleanupFixture(t, `sh -c 'echo $$; exec sleep 60' & exit 0`)
	out := bufio.NewScanner(owner.Stdout())
	if !out.Scan() {
		t.Fatal("child not ready")
	}
	pid, err := strconv.Atoi(out.Text())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	_ = owner.Wait()
	if err := owner.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); err == nil {
		t.Fatal("marked exec child survived its parent and cleanup")
	}
}

func TestContainerCleanupFindsEnvClearedOrphanBeforeStop(t *testing.T) {
	installProcessDockerTransport(t)
	owner := startCleanupFixture(t, `env -i PATH=/usr/bin:/bin sh -c 'echo $$; exec sleep 60' & exit 0`)
	out := bufio.NewScanner(owner.Stdout())
	if !out.Scan() {
		t.Fatal("child not ready")
	}
	pid, err := strconv.Atoi(out.Text())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	_ = owner.Wait()
	if err := owner.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); err == nil {
		t.Fatal("env-cleared child orphaned before Stop leaked")
	}
}
