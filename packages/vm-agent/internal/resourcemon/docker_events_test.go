package resourcemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestParseDockerOOMEvent(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    parsedDockerOOMEvent
		wantErr bool
	}{
		{
			name:  "oom event",
			input: `{"status":"oom","id":"abc123","Type":"container","Action":"oom","Actor":{"ID":"abc123","Attributes":{"name":"workspace-app","sam.workspace.id":"ws-1"}},"time":1780000000}`,
			want: parsedDockerOOMEvent{
				ok:            true,
				action:        "oom",
				workspaceID:   "ws-1",
				containerID:   "abc123",
				containerName: "workspace-app",
			},
		},
		{
			name:  "die 137 event",
			input: `{"status":"die","id":"def456","Type":"container","Action":"die","Actor":{"ID":"def456","Attributes":{"name":"worker","sam.workspace.id":"ws-2","exitCode":"137"}},"timeNano":1780000000123456789}`,
			want: parsedDockerOOMEvent{
				ok:            true,
				action:        "die",
				exitCode:      "137",
				workspaceID:   "ws-2",
				containerID:   "def456",
				containerName: "worker",
			},
		},
		{
			name:  "die non oom ignored",
			input: `{"status":"die","id":"ghi789","Type":"container","Action":"die","Actor":{"ID":"ghi789","Attributes":{"name":"worker","sam.workspace.id":"ws-3","exitCode":"0"}}}`,
		},
		{
			name:  "non container event ignored",
			input: `{"status":"oom","id":"abc123","Type":"volume","Action":"oom","Actor":{"ID":"abc123","Attributes":{"name":"worker"}}}`,
		},
		{
			name:    "invalid json",
			input:   `not json`,
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event, ok, err := ParseDockerOOMEvent(test.input)
			assertParsedDockerOOMEvent(t, event, ok, err, test.want, test.wantErr)
		})
	}
}

type parsedDockerOOMEvent struct {
	ok            bool
	action        string
	exitCode      string
	workspaceID   string
	containerID   string
	containerName string
}

func assertParsedDockerOOMEvent(t *testing.T, event ContainerOOMEvent, ok bool, err error, want parsedDockerOOMEvent, wantErr bool) {
	t.Helper()
	if (err != nil) != wantErr {
		t.Fatalf("ParseDockerOOMEvent() error = %v, wantErr %v", err, wantErr)
	}
	if wantErr {
		return
	}
	if err != nil {
		t.Fatalf("ParseDockerOOMEvent() error = %v", err)
	}

	got := parsedDockerOOMEvent{
		ok:            ok,
		action:        event.Action,
		exitCode:      event.ExitCode,
		workspaceID:   event.WorkspaceID,
		containerID:   event.ContainerID,
		containerName: event.ContainerName,
	}
	if got != want {
		t.Fatalf("ParseDockerOOMEvent() = %#v, want %#v", got, want)
	}
	if ok && event.OccurredAt.IsZero() {
		t.Fatal("OccurredAt should be set")
	}
}

func TestDockerEventTimeUsesNanoWhenPresent(t *testing.T) {
	got := dockerEventTime(1, 2_000_000_000)
	want := time.Unix(2, 0).UTC()
	if !got.Equal(want) {
		t.Fatalf("dockerEventTime() = %s, want %s", got, want)
	}
}

func TestDefaultDockerEventCommandArgs(t *testing.T) {
	cmd := defaultDockerEventCommand(context.Background())
	want := []string{
		"docker",
		"events",
		"--filter", "event=oom",
		"--filter", "event=die",
		"--format", "{{json .}}",
	}
	if len(cmd.Args) != len(want) {
		t.Fatalf("Args=%#v, want %#v", cmd.Args, want)
	}
	for i := range want {
		if cmd.Args[i] != want[i] {
			t.Fatalf("Args[%d]=%q, want %q; full args=%#v", i, cmd.Args[i], want[i], cmd.Args)
		}
	}
}

func TestDockerEventSubscriberCloseStopsCommand(t *testing.T) {
	var callbackWorkspaceID string
	var callbackContainerID string
	subscriber := NewDockerEventSubscriber(DockerEventSubscriberConfig{
		EventBuffer: 1,
		CommandFactory: func(ctx context.Context) *exec.Cmd {
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestDockerEventSubscriberHelperProcess", "--")
			cmd.Env = append(os.Environ(), "SAM_TEST_DOCKER_EVENT_HELPER=1")
			return cmd
		},
		OnContainerOOM: func(workspaceID, containerID string) {
			callbackWorkspaceID = workspaceID
			callbackContainerID = containerID
		},
	})

	if err := subscriber.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	select {
	case event := <-subscriber.Events():
		if event.WorkspaceID != "ws-helper" || event.ContainerID != "container-helper" {
			t.Fatalf("unexpected event: %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for helper OOM event")
	}

	done := make(chan struct{})
	go func() {
		_ = subscriber.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close() timed out; Docker event command was not cleaned up")
	}
	if callbackWorkspaceID != "ws-helper" || callbackContainerID != "container-helper" {
		t.Fatalf("callback got workspace=%q container=%q", callbackWorkspaceID, callbackContainerID)
	}
}

func TestDockerEventSubscriberHelperProcess(t *testing.T) {
	if os.Getenv("SAM_TEST_DOCKER_EVENT_HELPER") != "1" {
		return
	}
	_, _ = fmt.Fprintln(os.Stdout, `{"status":"oom","id":"container-helper","Type":"container","Action":"oom","Actor":{"ID":"container-helper","Attributes":{"name":"helper","sam.workspace.id":"ws-helper"}}}`)
	_ = os.Stdout.Sync()
	select {}
}
