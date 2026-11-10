package pty

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Standalone (Instant) terminals must start a real PTY and retain group-wide
// shutdown. Combining Setpgid with the PTY library's Setsid fails with EPERM.
func TestStandalonePTYStartsAndSignalsProcessGroup(t *testing.T) {
	dir := t.TempDir()
	childPath := filepath.Join(dir, "child.sh")
	pidPath := filepath.Join(dir, "child.pid")
	readyPath := filepath.Join(dir, "ready")
	signalPath := filepath.Join(dir, "signal")
	child := fmt.Sprintf("#!/bin/sh\ntrap '' HUP TERM\ntrap 'echo received > %q' USR1\necho ready > %q\nwhile :; do sleep 0.05; done\n", signalPath, readyPath)
	if err := os.WriteFile(childPath, []byte(child), 0o700); err != nil {
		t.Fatal(err)
	}
	shellPath := filepath.Join(dir, "shell.sh")
	shell := fmt.Sprintf("#!/bin/sh\ntrap '' HUP TERM\ntrap ':' USR1\n%q &\nchild=$!\necho $child > %q\nwhile kill -0 $child 2>/dev/null; do wait $child || true; done\n", childPath, pidPath)
	if err := os.WriteFile(shellPath, []byte(shell), 0o700); err != nil {
		t.Fatal(err)
	}
	session, err := NewSession(SessionConfig{ID: "standalone-group", UserID: "test-user", Shell: shellPath, ProcessGroup: true, CloseGrace: 100 * time.Millisecond})
	if err != nil {
		t.Fatalf("standalone PTY start: %v", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = session.Close()
		}
		_ = syscall.Kill(-session.Cmd.Process.Pid, syscall.SIGKILL)
	}()
	pid := session.Cmd.Process.Pid
	group, err := syscall.Getpgid(pid)
	if err != nil || group != pid {
		t.Fatalf("shell must lead isolated process group: pgid=%d pid=%d err=%v", group, pid, err)
	}
	waitPTYCondition(t, "child readiness", func() bool { _, err := os.Stat(readyPath); return err == nil })
	contents, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(contents)))
	if err != nil {
		t.Fatal(err)
	}
	childGroup, err := syscall.Getpgid(childPID)
	if err != nil || childGroup != group {
		t.Fatalf("child group=%d want=%d err=%v", childGroup, group, err)
	}
	if err := session.signalProcess(syscall.SIGUSR1); err != nil {
		t.Fatal(err)
	}
	waitPTYCondition(t, "group signal reached child", func() bool {
		data, err := os.ReadFile(signalPath)
		return err == nil && strings.TrimSpace(string(data)) == "received"
	})
	if err := session.Close(); err != nil {
		t.Fatalf("close standalone PTY: %v", err)
	}
	closed = true
	if processExists(pid) {
		t.Fatal("shell remained alive after close")
	}
	// An orphan can briefly remain a zombie awaiting the host init's reaper.
	waitPTYCondition(t, "child terminated on close", func() bool {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", childPID))
		if errors.Is(err, os.ErrNotExist) {
			return true
		}
		if err != nil {
			return false
		}
		fields := strings.Fields(string(data))
		return len(fields) > 2 && fields[2] == "Z"
	})
}

func waitPTYCondition(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}
