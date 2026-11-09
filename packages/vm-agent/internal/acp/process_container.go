package acp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const containerOwnerEnv = "SAM_ACP_PROCESS_OWNER"

// Container IDs are immutable; share one bounded probe among launches on that ID.
// No environment contents leave the container, only capability booleans.
type containerCapabilities struct{ proc, session, marker bool }

var containerCapabilityCache sync.Map

const containerCapabilityScript = `
[ -r /proc/self/stat ] && printf 'proc\n'
setsid --wait sh -c 'exit 0' >/dev/null 2>&1 && printf 'session\n'
grep -Fxlz -- "$1" /proc/self/environ >/dev/null 2>&1 && printf 'marker\n'
exit 0
`

func containerCapabilitiesFor(cfg ProcessConfig, dockerPath, owner string) containerCapabilities {
	key := dockerPath + "\x00" + cfg.ContainerID
	probe := sync.OnceValue(func() containerCapabilities {
		timeout := cfg.ContainerSignalTimeout
		if timeout <= 0 {
			timeout = DefaultContainerSignalTimeout
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		out, err := exec.CommandContext(ctx, dockerPath, "exec", "-e", containerOwnerEnv+"="+owner, cfg.ContainerID, "sh", "-c", containerCapabilityScript, "sam-process-capabilities", containerOwnerEnv+"="+owner).Output()
		if err != nil {
			slog.Warn("Container cleanup capability probe failed", "containerId", cfg.ContainerID, "error", err)
			return containerCapabilities{}
		}
		fields := "\n" + string(out)
		return containerCapabilities{strings.Contains(fields, "\nproc\n"), strings.Contains(fields, "\nsession\n"), strings.Contains(fields, "\nmarker\n")}
	})
	cached, _ := containerCapabilityCache.LoadOrStore(key, probe)
	return cached.(func() containerCapabilities)()
}
func (c containerCapabilities) reason() string {
	var reasons []string
	if !c.proc {
		reasons = append(reasons, "/proc unavailable")
	}
	if !c.session {
		reasons = append(reasons, "setsid --wait unavailable")
	}
	if !c.marker {
		reasons = append(reasons, "NUL-safe batch grep unavailable")
	}
	return strings.Join(reasons, "; ")
}

// Record the launch root before the adapter can fork or clear its env.
// Private Linux sessions are optional on arbitrary devcontainer images.
// The readiness line is consumed by the launcher, never exposed to ACP.
const containerSessionLaunchScript = `
grace=$1
private_session=$2
marker_scan=$3
shift 3
command_session() {
 IFS= read -r stat < /proc/self/stat || return 125
 rest=${stat##*) }
 set -- $rest
 if [ "$private_session" = true ]; then [ "$4" = "$$" ] || return 125; fi
 ancestor=$2
 shift 19
 started=$1
 ancestor_pids=" "
 while [ "$ancestor" -gt 1 ]; do
  ancestor_pids="$ancestor_pids$ancestor "
  IFS= read -r ancestor_stat 2>/dev/null < "/proc/$ancestor/stat" || break
  ancestor_rest=${ancestor_stat##*) }
  set -- $ancestor_rest
  ancestor=$2
 done
 printf '%s %s %s %s\n' "$SAM_ACP_PROCESS_OWNER" "$$" "$started" "$private_session"
}
signal_owned() {
 signal=$1
 owned_paths=""
 if [ "$marker_scan" = true ]; then owned_paths=$(grep -Fxlz -- "SAM_ACP_PROCESS_OWNER=$SAM_ACP_PROCESS_OWNER" /proc/[0-9]*/environ 2>/dev/null); fi
 for path in /proc/[0-9]*; do
  pid=${path##*/}
  [ "$pid" -gt 1 ] && [ "$pid" != "$$" ] || continue
  case "$ancestor_pids" in *" $pid "*) continue ;; esac
  IFS= read -r stat 2>/dev/null < "$path/stat" || continue
  rest=${stat##*) }
  set -- $rest
  [ "$#" -ge 20 ] || continue
  owned=0
  case "$owned_paths" in *"$path/environ"*) owned=1 ;; esac
  if { [ "$private_session" = true ] && [ "$4" = "$$" ]; } || [ "$owned" = 1 ]; then
   kill -"$signal" "$pid" 2>/dev/null || :
  fi
 done
}
cleanup() {
 trap '' TERM INT HUP
 signal_owned TERM
 sleep "$grace"
 signal_owned KILL
 wait "$child" 2>/dev/null || :
}
command_session || exit 125
trap 'cleanup; exit 143' TERM INT HUP
# Background POSIX jobs otherwise read /dev/null; preserve ACP stdin explicitly.
exec 3<&0
( trap - TERM INT HUP; exec "$@" ) <&3 3<&- &
child=$!
exec 3<&-
wait "$child"
code=$?
cleanup
exit "$code"
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
		if got.err != nil || len(fields) != 4 || fields[0] != p.containerOwner {
			return errors.New("container process ownership handshake failed")
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil || pid <= 1 {
			return errors.New("invalid container session identity")
		}
		if _, err := strconv.ParseUint(fields[2], 10, 64); err != nil {
			return errors.New("invalid container session starttime")
		}
		p.containerRootPID, p.containerRootStart = pid, fields[2]
		if fields[3] == "true" {
			p.containerSessionID, p.containerSessionStart = pid, fields[2]
		} else if fields[3] != "false" {
			return errors.New("invalid container ownership mode")
		}
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
owned_paths=""
if [ "$2" = true ]; then owned_paths=$(grep -Fxlz -- "$marker" /proc/[0-9]*/environ 2>/dev/null); fi
for owned_path in $owned_paths; do
 owned_path=${owned_path%/environ}
 printf 'owned %s\n' "${owned_path##*/}"
done
for path in /proc/[0-9]*; do
 IFS= read -r stat 2>/dev/null < "$path/stat" || continue
 rest=${stat##*) }
 set -- $rest
 [ "$#" -ge 20 ] || continue
 parent=$2
 session=$4
 shift 19
 start=$1
 printf '%s %s %s 0 %s\n' "${path##*/}" "$parent" "$start" "$session"
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
	if p.containerCleanupUnavailable {
		return errors.New("container process ownership unavailable; refusing broad cleanup")
	}
	if p.containerOwner == "" {
		return errors.New("container process ownership is missing; refusing broad cleanup")
	}
	ctx, cancel := context.WithTimeout(context.Background(), p.containerCommandTimeout())
	defer cancel()
	out, err := exec.CommandContext(ctx, p.dockerCommandPath(), "exec", "-u", "0", p.containerID, "sh", "-c", containerSnapshotScript, "sam-process-snapshot", containerOwnerEnv+"="+p.containerOwner, strconv.FormatBool(p.containerMarkerScan)).Output()
	if err != nil {
		return fmt.Errorf("snapshot owned container processes: %w", err)
	}
	processes := parseContainerProcessSnapshot(string(out))
	p.retainOwnedContainerProcesses(processes)
	return nil
}

func parseContainerProcessSnapshot(output string) map[int]containerProcessIdentity {
	processes := make(map[int]containerProcessIdentity)
	owned := make(map[int]bool)
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "owned" {
			if pid, err := strconv.Atoi(fields[1]); err == nil && pid > 1 {
				owned[pid] = true
			}
			continue
		}
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
	for pid := range owned {
		if proc, ok := processes[pid]; ok {
			proc.owned = true
			processes[pid] = proc
		}
	}
	return processes
}

func (p *AgentProcess) retainOwnedContainerProcesses(processes map[int]containerProcessIdentity) {
	if p.containerTargets == nil {
		p.containerTargets = make(map[int]string)
	}
	// Only the live supervisor proves session continuity. A missing leader
	// could belong to an extinct/recycled SID, so never adopt it by SID alone.
	leader, leaderPresent := processes[p.containerSessionID]
	sessionValid := leaderPresent && leader.start == p.containerSessionStart
	for pid, proc := range processes {
		if proc.owned || (pid == p.containerRootPID && proc.start == p.containerRootStart) || (sessionValid && proc.session == p.containerSessionID) {
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
	if err := exec.CommandContext(ctx, p.dockerCommandPath(), args...).Run(); err != nil {
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

// dockerCommandPath avoids PATH resolution in the privileged host service.
func (p *AgentProcess) dockerCommandPath() string {
	if p.dockerExecutable != "" {
		return p.dockerExecutable
	}
	return DefaultDockerExecutable
}
