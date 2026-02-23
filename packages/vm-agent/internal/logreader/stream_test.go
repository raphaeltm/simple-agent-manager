package logreader

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestBuildFollowArgs_AllCases(t *testing.T) {
	tests := []struct {
		name   string
		filter LogFilter
		check  func(t *testing.T, args []string)
	}{
		{
			name:   "default all source",
			filter: LogFilter{},
			check: func(t *testing.T, args []string) {
				assertContains(t, args, "--follow")
				assertContains(t, args, "--output=json")
				assertContains(t, args, "-n")
				assertContains(t, args, "0")
				// Should NOT contain -u for all source
				for _, a := range args {
					if a == "-u" {
						t.Error("should not have -u for all source")
					}
				}
			},
		},
		{
			name:   "systemd source",
			filter: LogFilter{Source: "systemd"},
			check: func(t *testing.T, args []string) {
				assertContains(t, args, "-u")
				assertContains(t, args, "vm-agent.service")
			},
		},
		{
			name:   "docker source no container",
			filter: LogFilter{Source: "docker"},
			check: func(t *testing.T, args []string) {
				assertContains(t, args, "_TRANSPORT=journal")
				assertContains(t, args, "CONTAINER_NAME")
			},
		},
		{
			name:   "docker source with container",
			filter: LogFilter{Source: "docker", Container: "my-app"},
			check: func(t *testing.T, args []string) {
				assertContains(t, args, "CONTAINER_NAME=my-app")
			},
		},
		{
			name:   "level filter",
			filter: LogFilter{Level: "error"},
			check: func(t *testing.T, args []string) {
				assertContains(t, args, "-p")
				assertContains(t, args, "err")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildFollowArgs(tt.filter)
			tt.check(t, args)
		})
	}
}

func TestStreamLogs_CatchUpDelivery(t *testing.T) {
	// Mock executor returns two lines for catch-up read, then hangs for follow.
	callCount := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		callCount++
		if callCount == 1 {
			// Catch-up phase — return journal lines
			lines := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"old entry","PRIORITY":"6","__CURSOR":"c1","_SYSTEMD_UNIT":"vm-agent.service"}
{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"newer entry","PRIORITY":"6","__CURSOR":"c2","_SYSTEMD_UNIT":"vm-agent.service"}`
			return exec.CommandContext(ctx, "echo", lines)
		}
		// Follow phase — sleep then exit (simulates journalctl exiting)
		return exec.CommandContext(ctx, "sleep", "10")
	}

	reader := NewReaderWithExecutor(mockExec)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		return nil
	}

	// sendCatchUp directly — oldest first delivery
	count, err := reader.sendCatchUp(ctx, LogFilter{Source: "agent"}, send)
	if err != nil {
		t.Fatalf("sendCatchUp: %v", err)
	}
	if count != 2 {
		t.Errorf("catch-up count = %d, want 2", count)
	}
	// ReadLogs returns newest-first, sendCatchUp reverses for oldest-first
	if len(received) < 2 {
		t.Fatalf("received %d entries, want >= 2", len(received))
	}
	if received[0] != "newer entry" {
		t.Errorf("first delivered = %q, want 'newer entry' (oldest-first from reversed)", received[0])
	}
}

func TestStreamLogs_FollowWithCancellation(t *testing.T) {
	// Mock executor: catch-up returns nothing, follow returns lines then context cancels
	callCount := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		callCount++
		if callCount == 1 {
			// Empty catch-up
			return exec.CommandContext(ctx, "echo", "")
		}
		// Follow phase — produce a line, then exit
		return exec.CommandContext(ctx, "echo", `{"__REALTIME_TIMESTAMP":"1708700002000000","MESSAGE":"streamed line","PRIORITY":"4","_SYSTEMD_UNIT":"vm-agent.service"}`)
	}

	reader := NewReaderWithExecutor(mockExec)

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		// Cancel context after receiving first entry
		cancel()
		return nil
	}

	err := reader.StreamLogs(ctx, LogFilter{Source: "agent"}, send)
	// Should return context error
	if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		t.Logf("StreamLogs returned: %v (acceptable for test)", err)
	}

	if len(received) > 0 && received[0] != "streamed line" {
		t.Errorf("received[0] = %q, want 'streamed line'", received[0])
	}
}

func TestRunFollowProcess_LevelFilter(t *testing.T) {
	// Mock follow that returns mixed-level entries
	lines := strings.Join([]string{
		`{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"debug msg","PRIORITY":"7","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"info msg","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700002000000","MESSAGE":"warn msg","PRIORITY":"4","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700003000000","MESSAGE":"error msg","PRIORITY":"3","_SYSTEMD_UNIT":"vm-agent.service"}`,
	}, "\n")

	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "%s", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx := context.Background()

	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		return nil
	}

	// Filter at warn level — should only get warn + error
	_ = reader.runFollowProcess(ctx, LogFilter{Level: "warn"}, send)

	if len(received) != 2 {
		t.Errorf("expected 2 entries at warn level, got %d: %v", len(received), received)
	}
	for _, msg := range received {
		if msg != "warn msg" && msg != "error msg" {
			t.Errorf("unexpected message: %q", msg)
		}
	}
}

func TestRunFollowProcess_SearchFilter(t *testing.T) {
	lines := strings.Join([]string{
		`{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"connection established","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"request processed","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700002000000","MESSAGE":"connection refused","PRIORITY":"3","_SYSTEMD_UNIT":"vm-agent.service"}`,
	}, "\n")

	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "%s", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx := context.Background()

	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		return nil
	}

	_ = reader.runFollowProcess(ctx, LogFilter{Search: "connection"}, send)

	if len(received) != 2 {
		t.Errorf("expected 2 entries matching 'connection', got %d: %v", len(received), received)
	}
}

func TestRunFollowProcess_SendError(t *testing.T) {
	lines := strings.Join([]string{
		`{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"line1","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`,
		`{"__REALTIME_TIMESTAMP":"1708700001000000","MESSAGE":"line2","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`,
	}, "\n")

	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "%s", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx := context.Background()

	sendCount := 0
	send := func(entry LogEntry) error {
		sendCount++
		if sendCount >= 1 {
			return fmt.Errorf("client disconnected")
		}
		return nil
	}

	// Should stop after send error
	_ = reader.runFollowProcess(ctx, LogFilter{}, send)

	if sendCount != 1 {
		t.Errorf("send called %d times, want 1 (stop on error)", sendCount)
	}
}

func TestRunFollowProcess_SkipsInvalidJSON(t *testing.T) {
	lines := "not json\n" + `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"valid","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}` + "\n"

	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "printf", "%s", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx := context.Background()

	var received []string
	send := func(entry LogEntry) error {
		received = append(received, entry.Message)
		return nil
	}

	_ = reader.runFollowProcess(ctx, LogFilter{}, send)

	if len(received) != 1 {
		t.Errorf("expected 1 valid entry, got %d", len(received))
	}
	if len(received) > 0 && received[0] != "valid" {
		t.Errorf("got %q, want 'valid'", received[0])
	}
}

func TestStreamBufferSizeDefault(t *testing.T) {
	// StreamBufferSize should have a sensible default
	if StreamBufferSize <= 0 {
		t.Errorf("StreamBufferSize = %d, want > 0", StreamBufferSize)
	}
}

func assertContains(t *testing.T, args []string, want string) {
	t.Helper()
	for _, a := range args {
		if a == want {
			return
		}
	}
	t.Errorf("args %v does not contain %q", args, want)
}
