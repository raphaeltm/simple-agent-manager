package logreader

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildFollowArgs_AllCases(t *testing.T) {
	tests := []struct {
		name   string
		filter LogFilter
		want   []string
	}{
		{
			name:   "default all source",
			filter: LogFilter{},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0"},
		},
		{
			name:   "agent source",
			filter: LogFilter{Source: "agent"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "-u", "vm-agent.service"},
		},
		{
			name:   "systemd source uses vm agent unit",
			filter: LogFilter{Source: "systemd"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "-u", "vm-agent.service"},
		},
		{
			name:   "docker source no container",
			filter: LogFilter{Source: "docker"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "_TRANSPORT=journal", "CONTAINER_NAME"},
		},
		{
			name:   "docker source with container",
			filter: LogFilter{Source: "docker", Container: "my-app"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "_TRANSPORT=journal", "CONTAINER_NAME=my-app"},
		},
		{
			name:   "level filter",
			filter: LogFilter{Level: "error"},
			want:   []string{"--follow", "--output=json", "--no-pager", "-n", "0", "-p", "err"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildFollowArgs(tt.filter)
			if !reflect.DeepEqual(args, tt.want) {
				t.Fatalf("args mismatch\ngot:  %v\nwant: %v", args, tt.want)
			}
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
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("StreamLogs error = %v, want context.Canceled", err)
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
	err := reader.runFollowProcess(ctx, LogFilter{Level: "warn"}, send)
	if !errors.Is(err, ErrFollowCleanExit) {
		t.Fatalf("runFollowProcess error = %v, want ErrFollowCleanExit", err)
	}

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

	err := reader.runFollowProcess(ctx, LogFilter{Search: "connection"}, send)
	if !errors.Is(err, ErrFollowCleanExit) {
		t.Fatalf("runFollowProcess error = %v, want ErrFollowCleanExit", err)
	}

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

	err := reader.runFollowProcess(ctx, LogFilter{}, send)
	if !errors.Is(err, ErrStreamSend) {
		t.Fatalf("runFollowProcess error = %v, want ErrStreamSend", err)
	}

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

	err := reader.runFollowProcess(ctx, LogFilter{}, send)
	if !errors.Is(err, ErrFollowCleanExit) {
		t.Fatalf("runFollowProcess error = %v, want ErrFollowCleanExit", err)
	}

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

func TestFollowLogs_SendErrorReturnsWithoutRetry(t *testing.T) {
	lines := `{"__REALTIME_TIMESTAMP":"1708700000000000","MESSAGE":"line1","PRIORITY":"6","_SYSTEMD_UNIT":"vm-agent.service"}`
	calls := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		calls++
		return exec.CommandContext(ctx, "printf", "%s", lines)
	}

	reader := NewReaderWithExecutor(mockExec)
	err := reader.followLogs(context.Background(), LogFilter{Source: "agent"}, func(entry LogEntry) error {
		return fmt.Errorf("client write failed")
	})

	if !errors.Is(err, ErrStreamSend) {
		t.Fatalf("followLogs error = %v, want ErrStreamSend", err)
	}
	if calls != 1 {
		t.Fatalf("follow process calls = %d, want 1", calls)
	}
}

func TestRunFollowProcess_ScannerTooLongLine(t *testing.T) {
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", "head -c 262145 /dev/zero | tr '\\000' x")
	}

	reader := NewReaderWithExecutor(mockExec)
	err := reader.runFollowProcess(context.Background(), LogFilter{}, func(entry LogEntry) error {
		t.Fatalf("send should not be called for oversized scanner token")
		return nil
	})

	if !errors.Is(err, ErrStreamScanner) {
		t.Fatalf("runFollowProcess error = %v, want ErrStreamScanner", err)
	}
}

func TestFollowLogs_CleanExitRetriesWithDelayUntilContext(t *testing.T) {
	origDelay := FollowRestartDelay
	FollowRestartDelay = 30 * time.Millisecond
	defer func() { FollowRestartDelay = origDelay }()

	calls := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		calls++
		return exec.CommandContext(ctx, "true")
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx, cancel := context.WithTimeout(context.Background(), 95*time.Millisecond)
	defer cancel()

	err := reader.followLogs(ctx, LogFilter{}, func(entry LogEntry) error {
		t.Fatalf("send should not be called for empty clean exits")
		return nil
	})

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("followLogs error = %v, want context deadline", err)
	}
	if calls < 2 {
		t.Fatalf("follow process calls = %d, want at least 2 retries", calls)
	}
	if calls > 5 {
		t.Fatalf("follow process calls = %d, want bounded retries with delay", calls)
	}
}

func TestFollowLogs_ProcessFailureRetriesUntilContext(t *testing.T) {
	origDelay := FollowRestartDelay
	FollowRestartDelay = 20 * time.Millisecond
	defer func() { FollowRestartDelay = origDelay }()

	calls := 0
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		calls++
		return exec.CommandContext(ctx, "sh", "-c", "exit 7")
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
	defer cancel()

	err := reader.followLogs(ctx, LogFilter{}, func(entry LogEntry) error {
		t.Fatalf("send should not be called for failed process")
		return nil
	})

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("followLogs error = %v, want context deadline", err)
	}
	if calls < 2 {
		t.Fatalf("follow process calls = %d, want retry after process failure", calls)
	}
	if calls > 6 {
		t.Fatalf("follow process calls = %d, want retry delay to prevent spin", calls)
	}
}

func TestRunFollowProcess_ContextCancellation(t *testing.T) {
	mockExec := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "sleep", "10")
	}

	reader := NewReaderWithExecutor(mockExec)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := reader.runFollowProcess(ctx, LogFilter{}, func(entry LogEntry) error {
		t.Fatalf("send should not be called after context cancellation")
		return nil
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("runFollowProcess error = %v, want context.Canceled", err)
	}
}

func TestJournalEntryToLogEntry_AllSourceDerivation(t *testing.T) {
	tests := []struct {
		name string
		raw  map[string]interface{}
		want string
	}{
		{
			name: "agent unit",
			raw: map[string]interface{}{
				"MESSAGE":       "agent",
				"_SYSTEMD_UNIT": "vm-agent.service",
			},
			want: "agent",
		},
		{
			name: "systemd unit",
			raw: map[string]interface{}{
				"MESSAGE":       "unit",
				"_SYSTEMD_UNIT": "ssh.service",
			},
			want: "systemd",
		},
		{
			name: "docker container",
			raw: map[string]interface{}{
				"MESSAGE":        "container",
				"CONTAINER_NAME": "workspace",
			},
			want: "docker:workspace",
		},
		{
			name: "journald entry without source hints defaults to systemd",
			raw: map[string]interface{}{
				"MESSAGE": "generic",
			},
			want: "systemd",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := journalEntryToLogEntry(tt.raw, "all")
			if got == nil {
				t.Fatal("expected entry")
			}
			if got.Source != tt.want {
				t.Fatalf("Source = %q, want %q", got.Source, tt.want)
			}
		})
	}
}
