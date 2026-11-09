package acp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const containerOwnerEnv = "SAM_ACP_PROCESS_OWNER"

// setsid is already required by the VM agent's secret-execution supervisor.
// Record the kernel session before the adapter can fork or clear its env.
// The readiness line is consumed by the launcher, never exposed to ACP.
const containerSessionLaunchScript = `
command_session() {
 IFS= read -r stat < /proc/self/stat || return 125
 rest=${stat##*) }
 set -- $rest
 [ "$4" = "$$" ] || return 125
 shift 19
 printf '%s %s %s\n' "$SAM_ACP_PROCESS_OWNER" "$$" "$1"
}
command_session || exit 125
exec "$@"
`

type bufferedProcessOutput struct {
	io.Reader
	io.Closer
}

// awaitContainerSession establishes ownership before returning the live adapter.
// No files or shell profiles are needed; output after the header stays buffered.
func (p *AgentProcess) awaitContainerSession() error {
	type result struct {
		header string
		reader *bufio.Reader
		err    error
	}
	ready := make(chan result, 1)
	go func() {
		reader := bufio.NewReader(p.stdout)
		line, err := reader.ReadSlice('\n')
		ready <- result{string(line), reader, err}
	}()
	timer := time.NewTimer(p.containerCommandTimeout())
	defer timer.Stop()
	select {
	case got := <-ready:
		fields := strings.Fields(got.header)
		if got.err != nil || len(fields) != 3 || fields[0] != p.containerOwner {
			return errors.New("container process ownership handshake failed")
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil || pid <= 1 {
			return errors.New("invalid container session identity")
		}
		if _, err := strconv.ParseUint(fields[2], 10, 64); err != nil {
			return errors.New("invalid container session starttime")
		}
		p.containerSessionID, p.containerSessionStart = pid, fields[2]
		p.stdout = bufferedProcessOutput{Reader: got.reader, Closer: p.stdout}
		return nil
	case <-timer.C:
		return errors.New("container process ownership handshake timed out")
	}
}

// Read metadata only: never return environment contents or match command names.
// Removing through the final ') ' handles spaces/parentheses in Linux comm.
const containerSnapshotScript = `
marker="$1"
for path in /proc/[0-9]*; do
 IFS= read -r stat 2>/dev/null < "$path/stat" || continue
 rest=${stat##*) }
 set -- $rest
 [ "$#" -ge 20 ] || continue
 parent=$2
 session=$4
 shift 19
 start=$1
 owned=0
 if [ -r "$path/environ" ] && tr '\000' '\n' < "$path/environ" 2>/dev/null | grep -Fqx -- "$marker"; then owned=1; fi
 printf '%s %s %s %s %s\n' "${path##*/}" "$parent" "$start" "$owned" "$session"
done
`

// Starttime is checked again immediately before each signal, preventing a stale
// captured PID from targeting a later process. PID 1 is never a cleanup target.
const containerSignalScript = `
signal=$1
shift
signal_process() {
 pid=$1
 expected=$2
 [ "$pid" -gt 1 ] || return 0
 IFS= read -r stat 2>/dev/null < "/proc/$pid/stat" || return 0
 rest=${stat##*) }
 set -- $rest
 [ "$#" -ge 20 ] || return 1
 shift 19
 [ "$1" = "$expected" ] || return 0
 kill -"$signal" "$pid" 2>/dev/null || [ ! -e "/proc/$pid/stat" ]
}
failed=0
while [ "$#" -ge 2 ]; do
 signal_process "$1" "$2" || failed=1
 shift 2
done
exit "$failed"
`

type containerProcessIdentity struct {
	pid     int
	parent  int
	start   string
	owned   bool
	session int
}

// captureContainerProcesses retains ownership before parent exit can erase
// ancestry. New marked descendants are discovered again at each signal phase.
// Called only while Stop holds p.mu.
func (p *AgentProcess) captureContainerProcesses() error {
	if p.containerID == "" {
		return nil
	}
	if p.containerOwner == "" {
		return errors.New("container process ownership is missing; refusing broad cleanup")
	}
	ctx, cancel := context.WithTimeout(context.Background(), p.containerCommandTimeout())
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "exec", "-u", "0", p.containerID, "sh", "-c", containerSnapshotScript, "sam-process-snapshot", containerOwnerEnv+"="+p.containerOwner).Output()
	if err != nil {
		return fmt.Errorf("snapshot owned container processes: %w", err)
	}
	processes := make(map[int]containerProcessIdentity)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 5 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 1 {
			continue
		}
		parent, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		if _, err := strconv.ParseUint(fields[2], 10, 64); err != nil {
			continue
		}
		session, err := strconv.Atoi(fields[4])
		if err != nil {
			continue
		}
		processes[pid] = containerProcessIdentity{pid: pid, parent: parent, start: fields[2], owned: fields[3] == "1", session: session}
	}
	if p.containerTargets == nil {
		p.containerTargets = make(map[int]string)
	}
	// A live session pins its leader's PID even after the leader exits. Once
	// the PID is recycled for another session, its starttime no longer matches.
	sessionValid := p.containerSessionID > 1
	if leader, ok := processes[p.containerSessionID]; ok && leader.start != p.containerSessionStart {
		sessionValid = false
	}
	for pid, proc := range processes {
		if proc.owned || (sessionValid && proc.session == p.containerSessionID) {
			p.containerTargets[pid] = proc.start
		}
	}
	// Include env-cleared children while their ancestry can still be proven.
	for changed := true; changed; {
		changed = false
		for pid, proc := range processes {
			parent, ok := processes[proc.parent]
			if !ok || p.containerTargets[parent.pid] != parent.start || p.containerTargets[pid] == proc.start {
				continue
			}
			p.containerTargets[pid] = proc.start
			changed = true
		}
	}
	return nil
}

// killContainerProcesses signals only identities associated with this launch.
// A snapshot error is visible; it never falls back to command-pattern matching.
func (p *AgentProcess) killContainerProcesses(sig syscall.Signal) error {
	if p.containerID == "" {
		return nil
	}
	snapshotErr := p.captureContainerProcesses()
	if len(p.containerTargets) == 0 {
		return snapshotErr
	}
	signal := "TERM"
	if sig == syscall.SIGKILL {
		signal = "KILL"
	}
	args := []string{"exec", "-u", "0", p.containerID, "sh", "-c", containerSignalScript, "sam-process-signal", signal}
	for pid, start := range p.containerTargets {
		args = append(args, strconv.Itoa(pid), start)
	}
	ctx, cancel := context.WithTimeout(context.Background(), p.containerCommandTimeout())
	defer cancel()
	if err := exec.CommandContext(ctx, "docker", args...).Run(); err != nil {
		return errors.Join(snapshotErr, fmt.Errorf("signal owned container processes: %w", err))
	}
	return snapshotErr
}

// containerCommandTimeout also supports older manually constructed processes.
func (p *AgentProcess) containerCommandTimeout() time.Duration {
	if p.containerSignalTimeout > 0 {
		return p.containerSignalTimeout
	}
	return DefaultContainerSignalTimeout
}
