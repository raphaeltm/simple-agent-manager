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
		name            string
		input           string
		wantOK          bool
		wantAction      string
		wantExitCode    string
		wantWorkspaceID string
		wantContainerID string
		wantName        string
	}{
		{
			name:            "oom event",
			input:           `{"status":"oom","id":"abc123","Type":"container","Action":"oom","Actor":{"ID":"abc123","Attributes":{"name":"workspace-app","sam.workspace.id":"ws-1"}},"time":1780000000}`,
			wantOK:          true,
			wantAction:      "oom",
			wantWorkspaceID: "ws-1",
			wantContainerID: "abc123",
			wantName:        "workspace-app",
		},
		{
			name:            "die 137 event",
			input:           `{"status":"die","id":"def456","Type":"container","Action":"die","Actor":{"ID":"def456","Attributes":{"name":"worker","sam.workspace.id":"ws-2","exitCode":"137"}},"timeNano":1780000000123456789}`,
			wantOK:          true,
			wantAction:      "die",
			wantExitCode:    "137",
			wantWorkspaceID: "ws-2",
			wantContainerID: "def456",
			wantName:        "worker",
		},
		{
			name:   "die non oom ignored",
			input:  `{"status":"die","id":"ghi789","Type":"container","Action":"die","Actor":{"ID":"ghi789","Attributes":{"name":"worker","sam.workspace.id":"ws-3","exitCode":"0"}}}`,
			wantOK: false,
		},
		{
			name:   "non container event ignored",
			input:  `{"status":"oom","id":"abc123","Type":"volume","Action":"oom","Actor":{"ID":"abc123","Attributes":{"name":"worker"}}}`,
			wantOK: false,
		},
		{
			name:   "invalid json",
			input:  `not json`,
			wantOK: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event, ok, err := ParseDockerOOMEvent(test.input)
			if test.input == "not json" {
				if err == nil {
					t.Fatal("expected parse error")
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDockerOOMEvent() error = %v", err)
			}
			if ok != test.wantOK {
				t.Fatalf("ParseDockerOOMEvent() ok = %v, want %v", ok, test.wantOK)
			}
			if !ok {
				return
			}
			if event.Action != test.wantAction {
				t.Fatalf("Action = %q, want %q", event.Action, test.wantAction)
			}
			if event.ExitCode != test.wantExitCode {
				t.Fatalf("ExitCode = %q, want %q", event.ExitCode, test.wantExitCode)
			}
			if event.WorkspaceID != test.wantWorkspaceID {
				t.Fatalf("WorkspaceID = %q, want %q", event.WorkspaceID, test.wantWorkspaceID)
			}
			if event.ContainerID != test.wantContainerID {
				t.Fatalf("ContainerID = %q, want %q", event.ContainerID, test.wantContainerID)
			}
			if event.ContainerName != test.wantName {
				t.Fatalf("ContainerName = %q, want %q", event.ContainerName, test.wantName)
			}
			if event.OccurredAt.IsZero() {
				t.Fatal("OccurredAt should be set")
			}
		})
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
