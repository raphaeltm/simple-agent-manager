package deploy

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// writeComposeScript writes an executable stub standing in for `docker compose`.
func writeComposeScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "compose-stub.sh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}
	return path
}

// A compose command that keeps producing output must keep the apply watchdog
// alive. This is the 2026-09-05 incident: `docker compose up` emits one release
// event when it starts and then nothing, so a legitimately slow image pull hit
// the idle timeout and was SIGKILLed mid-pull. Compose reports pull progress on
// stderr, so that output is what proves liveness.
func TestRunComposeSignalsLivenessFromChildOutput(t *testing.T) {
	// Emits to stderr repeatedly, the way `docker compose up` reports pull progress.
	script := writeComposeScript(t, `
i=0
while [ $i -lt 5 ]; do
  echo "Pulling fs layer $i" >&2
  i=$((i+1))
done
`)

	var signals atomic.Int64
	var gotEnv atomic.Value
	var gotSeq atomic.Int64

	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ComposeCmd:    script,
		ApplyLiveness: func(environmentID string, seq int64) {
			signals.Add(1)
			gotEnv.Store(environmentID)
			gotSeq.Store(seq)
		},
	})

	// Apply normally sets this; set it directly since we are calling runCompose.
	restore := engine.setActiveApplySeq(7)
	defer restore()

	if err := engine.runCompose(context.Background(), "compose.yaml", nil, "up", "-d"); err != nil {
		t.Fatalf("runCompose: %v", err)
	}

	if signals.Load() == 0 {
		t.Fatal("child output produced no liveness signals — a slow pull would be killed as stalled")
	}
	if env, _ := gotEnv.Load().(string); env != "env-1" {
		t.Fatalf("liveness environmentID = %q, want env-1", env)
	}
	if got := gotSeq.Load(); got != 7 {
		t.Fatalf("liveness seq = %d, want 7 (the active apply)", got)
	}
}

// Control: a command that produces NO output must not fabricate liveness.
// Without this, a signal fired unconditionally per invocation would look like
// the fix while leaving a genuinely hung compose undetectable.
func TestRunComposeSilentCommandProducesNoLiveness(t *testing.T) {
	script := writeComposeScript(t, `exit 0`)

	var signals atomic.Int64
	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ComposeCmd:    script,
		ApplyLiveness: func(string, int64) { signals.Add(1) },
	})
	defer engine.setActiveApplySeq(7)()

	if err := engine.runCompose(context.Background(), "compose.yaml", nil, "up", "-d"); err != nil {
		t.Fatalf("runCompose: %v", err)
	}
	if signals.Load() != 0 {
		t.Fatalf("silent command emitted %d liveness signals, want 0", signals.Load())
	}
}

// Outside an apply there is no watchdog to feed, so liveness must stay quiet
// rather than addressing signals to seq 0.
func TestRunComposeOutsideApplyEmitsNoLiveness(t *testing.T) {
	script := writeComposeScript(t, `echo "tearing down" >&2`)

	var signals atomic.Int64
	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ComposeCmd:    script,
		ApplyLiveness: func(string, int64) { signals.Add(1) },
	})
	// activeSeq deliberately left at 0 (no apply in flight).

	if err := engine.runCompose(context.Background(), "compose.yaml", nil, "down"); err != nil {
		t.Fatalf("runCompose: %v", err)
	}
	if signals.Load() != 0 {
		t.Fatalf("teardown emitted %d liveness signals, want 0", signals.Load())
	}
}

// The stderr captured for the error message must survive being wrapped for
// liveness, since it is the operator's only view of why compose failed.
func TestRunComposePreservesStderrInError(t *testing.T) {
	script := writeComposeScript(t, `
echo "no such image: ghcr.io/example/missing:1" >&2
exit 1
`)

	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ComposeCmd:    script,
		ApplyLiveness: func(string, int64) {},
	})
	defer engine.setActiveApplySeq(7)()

	err := engine.runCompose(context.Background(), "compose.yaml", nil, "up", "-d")
	if err == nil {
		t.Fatal("expected runCompose to fail")
	}
	if !strings.Contains(err.Error(), "no such image") {
		t.Fatalf("error lost compose stderr: %v", err)
	}
}

// Retained output is capped, but the liveness signal must keep firing past the
// cap — otherwise a very chatty pull would go silent and be killed as stalled
// precisely because it was producing too much output.
func TestLivenessWriterSignalsPastRetentionCap(t *testing.T) {
	var signals atomic.Int64
	w := &livenessWriter{signal: func() { signals.Add(1) }, limit: 8}

	chunk := []byte("0123456789")
	for i := 0; i < 5; i++ {
		if n, err := w.Write(chunk); err != nil || n != len(chunk) {
			t.Fatalf("Write = (%d, %v), want (%d, nil)", n, err, len(chunk))
		}
	}

	if got := len(w.String()); got != 8 {
		t.Fatalf("retained %d bytes, want cap of 8", got)
	}
	if got := signals.Load(); got != 5 {
		t.Fatalf("signals = %d, want 5 (one per write, including past the cap)", got)
	}
}

// The cap must retain the TAIL. Compose prints megabytes of progress and then
// the actual failure on its last lines, so head-retention would discard exactly
// the diagnostic the buffer exists to preserve.
func TestLivenessWriterRetainsTailNotHead(t *testing.T) {
	w := &livenessWriter{limit: 16}

	w.Write([]byte("EARLY-PROGRESS-NOISE-"))
	for i := 0; i < 50; i++ {
		w.Write([]byte("Pulling fs layer "))
	}
	w.Write([]byte("FATAL: no such image"))

	got := w.String()
	if len(got) > 16 {
		t.Fatalf("retained %d bytes, want <= 16", len(got))
	}
	if !strings.Contains(got, "no such image") {
		t.Fatalf("tail lost the failure reason; retained %q", got)
	}
	if strings.Contains(got, "EARLY-PROGRESS") {
		t.Fatalf("retained the head instead of the tail: %q", got)
	}
}

// End-to-end through the real child process, emitting well over the 64 KiB
// retention cap so the trimming path is actually exercised: a compose run that
// emits a lot of progress and then fails must surface the failing line.
func TestRunComposeErrorKeepsTailOfChattyOutput(t *testing.T) {
	script := writeComposeScript(t, `
i=0
while [ $i -lt 3000 ]; do
  echo "Pulling fs layer $i ................................................" >&2
  i=$((i+1))
done
echo "FATAL: manifest unknown for ghcr.io/example/db:17" >&2
exit 1
`)

	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ComposeCmd:    script,
		ApplyLiveness: func(string, int64) {},
	})
	defer engine.setActiveApplySeq(7)()

	err := engine.runCompose(context.Background(), "compose.yaml", nil, "up", "-d")
	if err == nil {
		t.Fatal("expected runCompose to fail")
	}
	if !strings.Contains(err.Error(), "manifest unknown") {
		t.Fatalf("error lost the failing tail line: %v", err)
	}
}

// setActiveApplySeq must restore the previous value so a nested/reverting apply
// cannot leave liveness addressed to the wrong release.
func TestSetActiveApplySeqRestoresPrevious(t *testing.T) {
	engine := NewEngine(nil, nil, EngineConfig{EnvironmentID: "env-1"})

	restoreOuter := engine.setActiveApplySeq(3)
	func() {
		defer engine.setActiveApplySeq(9)()
		engine.activeSeqMu.RLock()
		inner := engine.activeSeq
		engine.activeSeqMu.RUnlock()
		if inner != 9 {
			t.Fatalf("inner activeSeq = %d, want 9", inner)
		}
	}()

	engine.activeSeqMu.RLock()
	outer := engine.activeSeq
	engine.activeSeqMu.RUnlock()
	if outer != 3 {
		t.Fatalf("activeSeq after inner restore = %d, want 3", outer)
	}
	restoreOuter()
}

// The liveness callback is invoked from the goroutine draining child output
// while Apply writes activeSeq, so the pair must be race-free under -race.
func TestActiveApplySeqConcurrentAccess(t *testing.T) {
	engine := NewEngine(nil, nil, EngineConfig{
		EnvironmentID: "env-1",
		ApplyLiveness: func(string, int64) {},
	})

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				engine.signalLiveness()
			}
		}
	}()

	for i := int64(1); i <= 200; i++ {
		engine.setActiveApplySeq(i)()
	}
	close(stop)
	wg.Wait()
}
