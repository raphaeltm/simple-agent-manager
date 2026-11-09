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
if args[0]=='setsid' and env.get('SAM_TEST_DOCKER_MODE'):
 open(env['SAM_TEST_DOCKER_PID_FILE'],'w').write(str(os.getpid()))
 mode=env['SAM_TEST_DOCKER_MODE']
 if mode=='malformed': print('invalid ownership header',flush=True)
 if mode=='eof': os.close(1)
 os.execvpe('sleep',['sleep','60'],env)
os.execvpe(args[0],args,env)
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func startCleanupFixture(t *testing.T, script string) *AgentProcess {
	t.Helper()
	p, err := StartProcess(ProcessConfig{DockerExecutable: testDockerExecutable(t), ContainerID: "test-container", AcpCommand: "sh", AcpArgs: []string{"-c", script}, StopGracePeriod: 50 * time.Millisecond, StopTimeout: 3 * time.Second})
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
	p, err := StartProcess(ProcessConfig{DockerExecutable: testDockerExecutable(t), ContainerID: "test-container", AcpCommand: "sh", AcpArgs: []string{"-c", `printf '%s\n' "$SAM_ACP_PROCESS_OWNER"`}, EnvVars: []string{"SAM_ACP_PROCESS_OWNER=profile-collision"}, StopGracePeriod: 50 * time.Millisecond})
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

func TestContainerCleanupFindsOrphanAfterParentExit(t *testing.T) {
	for _, command := range []string{
		`sh -c 'echo $$; exec sleep 60' & exit 0`,
		`env -i PATH=/usr/bin:/bin sh -c 'echo $$; exec sleep 60' & exit 0`,
	} {
		t.Run(command, func(t *testing.T) {
			installProcessDockerTransport(t)
			owner := startCleanupFixture(t, command)
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
				t.Fatal("orphan survived adapter exit and cleanup")
			}
		})
	}
}

func TestContainerCleanupRejectsUnprovenSessionContinuity(t *testing.T) {
	for _, snapshot := range []string{
		"4242 1 999 0 1234\n",                       // Extinct SID recycled, replacement leader also gone.
		"1234 1 222 0 1234\n4242 1234 999 0 1234\n", // Recycled live leader.
	} {
		t.Run(snapshot, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nprintf '%s' '"+snapshot+"'\n"), 0755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
			p := &AgentProcess{containerID: "test-container", dockerExecutable: filepath.Join(dir, "docker"), containerOwner: "owner", containerSessionID: 1234, containerSessionStart: "111"}
			if err := p.captureContainerProcesses(); err != nil {
				t.Fatal(err)
			}
			if len(p.containerTargets) != 0 {
				t.Fatalf("unrelated replacement session adopted: %v", p.containerTargets)
			}
		})
	}
}

func TestContainerLaunchFailureCleansOnlyItsProcess(t *testing.T) {
	for _, mode := range []string{"malformed", "eof", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			installProcessDockerTransport(t)
			peer := startCleanupFixture(t, `echo ready; while read request; do echo "peer:$request"; done`)
			out := bufio.NewScanner(peer.Stdout())
			if !out.Scan() {
				t.Fatal("peer not ready")
			}
			pidFile := filepath.Join(t.TempDir(), "pid")
			t.Setenv("SAM_TEST_DOCKER_PID_FILE", pidFile)
			t.Setenv("SAM_TEST_DOCKER_MODE", mode)
			started := time.Now()
			p, err := StartProcess(ProcessConfig{DockerExecutable: testDockerExecutable(t), ContainerID: "test-container", AcpCommand: "sh", ContainerSignalTimeout: 200 * time.Millisecond, StopGracePeriod: 50 * time.Millisecond, StopTimeout: time.Second})
			if err == nil {
				_ = p.Stop()
				t.Fatal("invalid handshake accepted")
			}
			if time.Since(started) > 3*time.Second {
				t.Fatal("startup failure cleanup exceeded bound")
			}
			pidText, readErr := os.ReadFile(pidFile)
			if readErr != nil {
				t.Fatal(readErr)
			}
			pid, parseErr := strconv.Atoi(string(pidText))
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			if _, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
				t.Fatal("failed startup leaked process")
			}
			if _, err := fmt.Fprintln(peer.Stdin(), "survived-startup-failure"); err != nil {
				t.Fatal(err)
			}
			if !out.Scan() || out.Text() != "peer:survived-startup-failure" {
				t.Fatal("peer lost during startup failure")
			}
		})
	}
}

func TestContainerLaunchPreservesBufferedACPOutputAndExitStatus(t *testing.T) {
	installProcessDockerTransport(t)
	p := startCleanupFixture(t, `printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'; exit 23`)
	out := bufio.NewScanner(p.Stdout())
	if !out.Scan() || out.Text() != `{"jsonrpc":"2.0","id":1,"result":{}}` {
		t.Fatal("readiness header lost or contaminated ACP output")
	}
	if err := p.Wait(); err == nil {
		t.Fatal("adapter exit failure was lost")
	}
	if p.cmd.ProcessState.ExitCode() != 23 {
		t.Fatalf("adapter exit status=%d", p.cmd.ProcessState.ExitCode())
	}
}

func testDockerExecutable(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("docker")
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func TestContainerLaunchRejectsRelativeHostDockerPath(t *testing.T) {
	if _, err := StartProcess(ProcessConfig{DockerExecutable: "docker", ContainerID: "test-container", AcpCommand: "sh"}); err == nil {
		t.Fatal("relative Docker path would reintroduce privileged PATH lookup")
	}
}
