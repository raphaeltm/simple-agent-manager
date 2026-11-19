// Package secretexec executes a bounded job with private, literal stdin framing.
package secretexec

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SupervisorScript requires bash and setsid inside the current container. It
// never sources profiles. EOF/cancel on the private control pipe kills the
// command's container-side process group, rather than only the host docker CLI.
const SupervisorScript = `set +m
IFS= read -r -d '' count || exit 125
env_entries=()
for ((i=0;i<count;i++)); do
 IFS= read -r -d '' key || exit 125
 IFS= read -r -d '' value || exit 125
 env_entries+=("$key=$value")
done
IFS= read -r -d '' count || exit 125
argv=()
for ((i=0;i<count;i++)); do
 IFS= read -r -d '' value || exit 125
 argv+=("$value")
done
unset BASH_ENV ENV
test -x /usr/bin/setsid || exit 125
# Preserve the private stdin pipe explicitly: background jobs otherwise get /dev/null.
exec 3<&0
apply_env() {
 for item in "$@"; do unset "${item%%=*}" || return 125; done
 if (( $# > 0 )); then export "$@" || return 125; fi
}
( set -- "${argv[@]}"
  apply_env "${env_entries[@]}" || exit 125
  exec /usr/bin/setsid --wait /usr/bin/env -u BASH_ENV -u ENV "$@"
) </dev/null 3<&- &
child=$!
cleanup() { if kill -0 -- "-$child" 2>/dev/null; then kill -TERM -- "-$child" 2>/dev/null; /bin/sleep "$1"; kill -KILL -- "-$child" 2>/dev/null; fi; }
trap 'cleanup "$1"; exit 125' HUP INT TERM
( IFS= read -r signal <&3; cleanup "$1" ) 3<&3 &
watcher=$!
wait "$child"
code=$?
cleanup "$1"
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
exit "$code"
`

const DefaultGracePeriod = time.Second
const DefaultTransportGracePeriod = 2 * time.Second

type Input struct {
	Argv                 []string
	Env                  map[string]string
	Secrets              []string
	OutputLimit          int
	GracePeriod          time.Duration
	TransportGracePeriod time.Duration
}
type Result struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	TimedOut  bool   `json:"timedOut"`
	Redacted  bool   `json:"redacted"`
	Truncated bool   `json:"truncated"`
}

// Run owns cmd and stdin until exit. Cancellation is delivered to the in-container
// supervisor first; the host CLI is killed only after its cleanup budget expires.
func Run(ctx context.Context, cmd *exec.Cmd, input Input) Result {
	out := NewRedactor(input.Secrets, input.OutputLimit)
	errOut := NewRedactor(input.Secrets, input.OutputLimit)
	cmd.Stdout = out
	cmd.Stderr = errOut
	writer, pipeErr := cmd.StdinPipe()
	if pipeErr != nil {
		return Result{ExitCode: -1, Stderr: "Execution stdin unavailable"}
	}
	if input.GracePeriod <= 0 {
		input.GracePeriod = DefaultGracePeriod
	}
	if input.TransportGracePeriod <= 0 {
		input.TransportGracePeriod = DefaultTransportGracePeriod
	}
	result := Result{ExitCode: -1}
	if err := cmd.Start(); err != nil {
		_ = writer.Close()
		_, _ = errOut.Write([]byte("Unable to start execution supervisor"))
		return finish(result, out, errOut)
	}
	feedDone := make(chan struct{})
	go func() { defer close(feedDone); _, _ = writer.Write(frame(input)) }()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var runErr error
	select {
	case runErr = <-done:
	case <-ctx.Done():
		result.TimedOut = ctx.Err() == context.DeadlineExceeded
		// Closing the pipe also interrupts a blocked frame write.
		_ = writer.Close()
		timer := time.NewTimer(input.GracePeriod + input.TransportGracePeriod)
		select {
		case runErr = <-done:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
			_ = cmd.Process.Kill()
			runErr = <-done
		}
	}
	_ = writer.Close()
	<-feedDone
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}
	if runErr != nil && result.ExitCode == -1 {
		_, _ = errOut.Write([]byte("Execution transport failed"))
	}
	return finish(result, out, errOut)
}
func frame(input Input) []byte {
	var b bytes.Buffer
	keys := make([]string, 0, len(input.Env))
	for key := range input.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	field := func(v string) { b.WriteString(v); b.WriteByte(0) }
	field(strconv.Itoa(len(keys)))
	for _, key := range keys {
		field(key)
		field(input.Env[key])
	}
	field(strconv.Itoa(len(input.Argv)))
	for _, arg := range input.Argv {
		field(arg)
	}
	return b.Bytes()
}
func finish(result Result, out, errOut *Redactor) Result {
	var r1, r2, t1, t2 bool
	result.Stdout, r1, t1 = out.Finish()
	result.Stderr, r2, t2 = errOut.Finish()
	result.Redacted = r1 || r2
	result.Truncated = t1 || t2
	return result
}

// Redactor holds a suffix across writes so a secret split at a chunk boundary
// cannot escape. It continues consuming after the output cap without retaining it.
type Redactor struct {
	mu        sync.Mutex
	secrets   []string
	pending   string
	output    strings.Builder
	overlap   int
	limit     int
	redacted  bool
	truncated bool
}

func NewRedactor(secrets []string, limit int) *Redactor {
	w := &Redactor{limit: limit}
	for _, s := range secrets {
		if s != "" {
			w.secrets = append(w.secrets, s)
			if len(s) > w.overlap {
				w.overlap = len(s)
			}
		}
	}
	sort.Slice(w.secrets, func(i, j int) bool { return len(w.secrets[i]) > len(w.secrets[j]) })
	return w
}
func (w *Redactor) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending += string(p)
	w.drain(false)
	return len(p), nil
}
func (w *Redactor) drain(final bool) {
	for len(w.pending) > 0 {
		if !final && len(w.pending) < w.overlap {
			return
		}
		match := ""
		for _, s := range w.secrets {
			if strings.HasPrefix(w.pending, s) {
				match = s
				break
			}
		}
		if match != "" {
			w.append("[REDACTED]")
			w.redacted = true
			w.pending = w.pending[len(match):]
		} else {
			w.append(w.pending[:1])
			w.pending = w.pending[1:]
		}
	}
}
func (w *Redactor) append(s string) {
	remaining := w.limit - w.output.Len()
	if remaining < len(s) {
		w.truncated = true
		if remaining > 0 {
			w.output.WriteString(s[:remaining])
		}
		return
	}
	w.output.WriteString(s)
}
func (w *Redactor) Finish() (string, bool, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.drain(true)
	return w.output.String(), w.redacted, w.truncated
}

func SupervisorArgs(grace time.Duration) []string {
	return []string{"env", "-u", "BASH_ENV", "-u", "ENV", "bash", "--noprofile", "--norc", "-c", SupervisorScript, "sam-secret-exec", fmt.Sprintf("%.3f", grace.Seconds())}
}
