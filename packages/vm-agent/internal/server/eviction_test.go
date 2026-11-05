package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/ports"
	"github.com/workspace/vm-agent/internal/pty"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func newEvictionTestServer() *Server {
	ptyManager := pty.NewManager(pty.ManagerConfig{
		DefaultShell: "/bin/sh",
		DefaultRows:  24,
		DefaultCols:  80,
		WorkDir:      "/tmp",
		BufferSize:   1024,
	})
	return &Server{
		config: &config.Config{
			NodeID:                           "node-1",
			WorkspaceID:                      "workspace-1",
			ProjectID:                        "project-1",
			ChatSessionID:                    "boot-chat-session",
			CallbackToken:                    "node-callback-token",
			ControlPlaneURL:                  "https://api.example.com",
			EvictionDockerStopTimeout:        time.Second,
			EvictionSnapshotTimeout:          time.Second,
			EvictionDebounceWindow:           time.Second,
			EvictionResolveTimeout:           time.Second,
			EvictionCallbackRetryMaxInterval: time.Minute,
			ContainerMode:                    true,
			ContainerLabelKey:                "devcontainer.local_folder",
			ContainerStatsInterval:           time.Second,
			PSIPollInterval:                  time.Second,
			MaxNodeEvents:                    500,
			MaxWorkspaceEvents:               500,
			HTTPCallbackTimeout:              time.Second,
		},
		workspaces: map[string]*WorkspaceRuntime{
			"workspace-1": {
				ID:                  "workspace-1",
				Status:              "running",
				ProjectID:           "project-1",
				ChatSessionID:       "chat-session-1",
				CallbackToken:       "workspace-callback-token",
				ContainerLabelValue: "/workspace/repo",
				ContainerWorkDir:    "/workspaces/repo",
				ContainerUser:       "node",
				PTY:                 ptyManager,
			},
		},
		workspaceEvents:     map[string][]EventRecord{},
		nodeEvents:          []EventRecord{},
		agentSessions:       agentsessions.NewManager(),
		sessionHosts:        map[string]*acp.SessionHost{},
		sessionMcpServers:   map[string][]acp.McpServerEntry{},
		sessionProfileOvr:   map[string]profileOverrides{},
		sessionTaskCtx:      map[string]taskCallbackContext{},
		bootLogBroadcasters: NewBootLogBroadcasterManager(),
		portScanners:        map[string]*ports.Scanner{},
		portDiscoveries:     map[string]*container.Discovery{},
		done:                make(chan struct{}),
	}
}

func TestCaptureEvictionSessionSnapshotUsesSynchronousHibernateInput(t *testing.T) {
	s := newEvictionTestServer()
	setupEvictionDocker(t, evictionTestContainerID)
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "openai-codex"); err != nil {
		t.Fatal(err)
	}

	var captured *sessionSnapshotHandlerInput
	s.sessionSnapshotRunner = func(_ context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		copy := *input
		captured = &copy
		return map[string]interface{}{"status": "available"}, nil
	}

	_, err = s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID:    "workspace-1",
		ContainerID:    evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonMemoryPressure,
	})
	if err != nil {
		t.Fatalf("captureEvictionSessionSnapshot: %v", err)
	}
	if captured == nil {
		t.Fatal("snapshot runner was not called")
	}
	if captured.containerTarget == nil || captured.containerTarget.containerID != evictionTestContainerID {
		t.Fatalf("snapshot identity was not pinned: %#v", captured.containerTarget)
	}
	if captured.background {
		t.Fatal("eviction snapshot used background capture; want synchronous capture")
	}
	if captured.workspaceID != "workspace-1" ||
		captured.sessionID != "agent-session-1" ||
		captured.chatSessionID != "chat-session-1" ||
		captured.callbackToken != "workspace-callback-token" ||
		captured.acpSessionID != "acp-session-1" ||
		captured.agentType != "openai-codex" ||
		captured.runtimeName != defaultEvictionSnapshotRuntimeName {
		t.Fatalf("captured input = %#v", captured)
	}
}

func TestCaptureEvictionSessionSnapshotRequiresChatSessionID(t *testing.T) {
	s := newEvictionTestServer()
	s.workspaces["workspace-1"].ChatSessionID = ""
	s.config.ChatSessionID = ""
	if _, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", ""); err != nil {
		t.Fatal(err)
	}

	_, err := s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID:    "workspace-1",
		ContainerID:    evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonMemoryPressure,
	})
	if err == nil {
		t.Fatal("captureEvictionSessionSnapshot returned nil error without chat session ID")
	}
}

func TestCaptureOOMEvictionSnapshotsExitedVictimThroughIsolatedHelper(t *testing.T) {
	s := newEvictionTestServer()
	helperID := strings.Repeat("b", 64)
	logPath := setupExitedEvictionDocker(t, evictionTestContainerID, helperID)
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "openai-codex"); err != nil {
		t.Fatal(err)
	}

	var captured *containerSnapshotTarget
	s.sessionSnapshotRunner = func(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		captured = input.containerTarget
		// hibernateSessionSnapshot evaluates the quiescence check just before completion.
		quiesced := input.quiescence != nil && input.quiescence(ctx) == nil
		return map[string]interface{}{"status": "available", "quiesced": quiesced}, nil
	}
	outcome, err := s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID:    "workspace-1",
		ContainerID:    evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonOOMKill,
	})
	if err != nil {
		t.Fatalf("captureEvictionSessionSnapshot: %v", err)
	}
	// The OOM victim had already exited, so this capture is final and no post-stop
	// recapture is needed.
	if !outcome.Quiesced {
		t.Fatal("helper capture of an exited OOM victim was not reported quiesced")
	}
	if captured == nil || captured.containerID != helperID || captured.workDir != "/workspaces/repo" || captured.user != "node" {
		t.Fatalf("snapshot helper target = %#v", captured)
	}

	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"commit --change LABEL sam.snapshot-helper.workspace=workspace-1 " + evictionTestContainerID,
		"--volumes-from " + evictionTestContainerID,
		"--label devcontainer.local_folder=sam-eviction-snapshot-helper --label sam.snapshot-helper.workspace=workspace-1",
		"--network none --cap-drop ALL --security-opt no-new-privileges --memory 1g --pids-limit 256",
		"start " + helperID,
		"rm --force --volumes sam-eviction-snapshot-",
		"image rm --force sam-eviction-snapshot:",
	} {
		if !strings.Contains(string(calls), want) {
			t.Fatalf("missing %q in Docker calls:\n%s", want, calls)
		}
	}
}

func TestCaptureOOMEvictionRefusesHelperForRunningContainer(t *testing.T) {
	s := newEvictionTestServer()
	logPath := setupExitedEvictionDocker(t, evictionTestContainerID, strings.Repeat("b", 64))
	setEvictionTestSourceState(t, "true|false|0|2026-11-05T01:00:00Z|0001-01-01T00:00:00Z")
	if _, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", ""); err != nil {
		t.Fatal(err)
	}

	_, err := s.captureEvictionSessionSnapshot(context.Background(), resourcemon.EvictionTarget{
		WorkspaceID:    "workspace-1",
		ContainerID:    evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonOOMKill,
	})
	if err == nil || !strings.Contains(err.Error(), "not an exited OOM container") {
		t.Fatalf("captureEvictionSessionSnapshot error = %v", err)
	}
	calls, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.Contains(string(calls), "commit ") || strings.Contains(string(calls), "create ") {
		t.Fatalf("running container reached helper creation:\n%s", calls)
	}
}

func TestMarkWorkspaceEvictedUpdatesRuntimeAndAgentSessions(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "openai-codex"); err != nil {
		t.Fatal(err)
	}

	s.markWorkspaceEvicted(resourcemon.EvictionResult{
		Target: resourcemon.EvictionTarget{
			WorkspaceID:    "workspace-1",
			ContainerID:    evictionTestContainerID,
			RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
			Reason:         resourcemon.EvictionReasonOOMKill,
		},
		SnapshotCaptured: true,
		ContainerStopped: true,
	})

	runtime := s.workspaces["workspace-1"]
	if runtime.Status != "evicted" {
		t.Fatalf("runtime status = %q, want evicted", runtime.Status)
	}
	gotSession, ok := s.agentSessions.Get("workspace-1", "agent-session-1")
	if !ok {
		t.Fatal("agent session missing")
	}
	if gotSession.Status != agentsessions.StatusError {
		t.Fatalf("agent session status = %s, want error", gotSession.Status)
	}
	if gotSession.AcpSessionID != "acp-session-1" {
		t.Fatalf("AcpSessionID = %q, want preserved", gotSession.AcpSessionID)
	}
	if len(s.workspaceEvents["workspace-1"]) == 0 {
		t.Fatal("workspace eviction event was not appended")
	}
}

func TestNotifyWorkspaceEvictedPostsCallbackPayload(t *testing.T) {
	s := newEvictionTestServer()
	type callbackBody struct {
		NodeID             string `json:"nodeId"`
		WorkspaceID        string `json:"workspaceId"`
		Reason             string `json:"reason"`
		SnapshotCaptured   bool   `json:"snapshotCaptured"`
		ContainerStopped   bool   `json:"containerStopped"`
		EvictionGeneration string `json:"evictionGeneration"`
	}
	type callbackRequest struct {
		Method        string
		Path          string
		Authorization string
		ContentType   string
		Body          callbackBody
		Err           string
	}
	requests := make(chan callbackRequest, 1)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body callbackBody
		req := callbackRequest{
			Method:        r.Method,
			Path:          r.URL.EscapedPath(),
			Authorization: r.Header.Get("Authorization"),
			ContentType:   r.Header.Get("Content-Type"),
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			req.Err = err.Error()
			requests <- req
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		req.Body = body
		requests <- req
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	s.config.ControlPlaneURL = controlPlane.URL
	s.workspaces["workspace-1"].EvictionGeneration = "generation-at-selection"
	initializeEvictionTestStore(t, s)

	result := resourcemon.EvictionResult{
		Target: resourcemon.EvictionTarget{
			WorkspaceID:        "workspace-1",
			ContainerID:        "container-1",
			EvictionGeneration: "generation-at-selection",
			Reason:             resourcemon.EvictionReasonOOMKill,
		},
		SnapshotCaptured: false,
		ContainerStopped: true,
	}
	if applied, err := s.store.RecordWorkspaceEviction(context.Background(), s.workspaceEvictionDelivery(result)); err != nil || !applied {
		t.Fatalf("queue callback: %v %v", applied, err)
	}
	s.workspaces["workspace-1"].EvictionGeneration = "generation-after-restart"
	if err := s.notifyWorkspaceEvicted(context.Background(), result); err != nil {
		t.Fatalf("notifyWorkspaceEvicted: %v", err)
	}

	select {
	case got := <-requests:
		if got.Err != "" {
			t.Fatalf("callback decode error: %s", got.Err)
		}
		if got.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", got.Method)
		}
		if got.Path != "/api/projects/project-1/workspaces/workspace-1/eviction" {
			t.Fatalf("path = %q", got.Path)
		}
		if got.Authorization != "Bearer workspace-callback-token" {
			t.Fatalf("Authorization = %q, want workspace callback token", got.Authorization)
		}
		if got.ContentType != "application/json" {
			t.Fatalf("Content-Type = %q, want application/json", got.ContentType)
		}
		wantBody := callbackBody{
			NodeID:             "node-1",
			WorkspaceID:        "workspace-1",
			Reason:             string(resourcemon.EvictionReasonOOMKill),
			SnapshotCaptured:   false,
			ContainerStopped:   true,
			EvictionGeneration: "generation-at-selection",
		}
		if got.Body != wantBody {
			t.Fatalf("body = %#v, want %#v", got.Body, wantBody)
		}
	case <-time.After(time.Second):
		t.Fatal("control plane callback was not sent")
	}
}

func TestEvictionDockerStopArgsPreserveOverlayFilesystem(t *testing.T) {
	got := evictionDockerStopArgs(10, "container-1")
	want := []string{"stop", "--time", "10", "container-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("evictionDockerStopArgs = %#v, want %#v", got, want)
	}
	for _, arg := range got {
		if arg == "rm" || arg == "-f" || arg == "--force" {
			t.Fatalf("eviction docker args include destructive removal flag: %#v", got)
		}
	}
}

func TestEvictionDockerStopCommandTimeoutAllowsDockerClientToReturn(t *testing.T) {
	stopTimeout := 10 * time.Second
	if got := evictionDockerStopCommandTimeout(stopTimeout); got <= stopTimeout {
		t.Fatalf("evictionDockerStopCommandTimeout = %s, want greater than docker --time %s", got, stopTimeout)
	}
}

const evictionTestContainerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func setupEvictionDocker(t *testing.T, currentID string) string {
	t.Helper()
	dir := t.TempDir()
	command := filepath.Join(dir, "docker")
	logPath := filepath.Join(dir, "calls")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$SAM_EVICTION_TEST_CALLS"
case "$1" in
  ps) printf '%s\n' "$SAM_EVICTION_TEST_CURRENT_ID" ;;
  stop)
    if [ -n "$SAM_EVICTION_TEST_STOP_STARTED" ]; then
      touch "$SAM_EVICTION_TEST_STOP_STARTED"
      while [ ! -e "$SAM_EVICTION_TEST_STOP_RELEASE" ]; do sleep 0.01; done
    fi
    exit "${SAM_EVICTION_TEST_STOP_EXIT:-0}" ;;
  inspect) printf '%s\n' "$SAM_EVICTION_TEST_STARTED_AT" ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(command, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", command)
	t.Setenv("SAM_EVICTION_TEST_CURRENT_ID", currentID)
	t.Setenv("SAM_EVICTION_TEST_CALLS", logPath)
	return logPath
}

// setupExitedEvictionDocker fakes the Docker CLI for the stopped-source helper flow.
// Optional environment shapes each answer: SAM_EVICTION_TEST_STATE_FILE (source state,
// re-read on every inspect so a test can "restart" the source mid-capture),
// SAM_EVICTION_TEST_RUNNING (running container IDs), SAM_EVICTION_TEST_MOUNTS (mount
// inspect output), SAM_EVICTION_TEST_SIZE_RW, SAM_EVICTION_TEST_DOCKER_ROOT and
// SAM_EVICTION_TEST_LEAKED (helpers left by an earlier crash).
func setupExitedEvictionDocker(t *testing.T, currentID, helperID string) string {
	t.Helper()
	dir := t.TempDir()
	command := filepath.Join(dir, "docker")
	logPath := filepath.Join(dir, "calls")
	stateFile := filepath.Join(dir, "state")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$SAM_EVICTION_TEST_CALLS"
case "$1" in
  ps)
    case " $* " in
      *" --all "*) printf '%s\n' "$SAM_EVICTION_TEST_CURRENT_ID" ;;
      *" -aq "*) [ -n "$SAM_EVICTION_TEST_LEAKED" ] && printf '%s\n' "$SAM_EVICTION_TEST_LEAKED" ;;
      *" -a "*) [ -n "$SAM_EVICTION_TEST_STALE" ] && printf '%b\n' "$SAM_EVICTION_TEST_STALE" ;;
      *" -q "*) [ -n "$SAM_EVICTION_TEST_RUNNING" ] && printf '%s\n' "$SAM_EVICTION_TEST_RUNNING" ;;
    esac
    exit 0 ;;
  inspect)
    case "$*" in
      *Mounts*) printf '%s\n' "$SAM_EVICTION_TEST_MOUNTS" ;;
      *) cat "$SAM_EVICTION_TEST_STATE_FILE" ;;
    esac ;;
  container) printf '%s\n' "${SAM_EVICTION_TEST_SIZE_RW:-1024}" ;;
  info) printf '%s\n' "${SAM_EVICTION_TEST_DOCKER_ROOT:-/}" ;;
  commit|start|rm) exit 0 ;;
  create) printf '%s\n' "$SAM_EVICTION_TEST_HELPER_ID" ;;
  image)
    case "$2 $*" in
      ls*--format*) [ -n "$SAM_EVICTION_TEST_STALE_IMAGES" ] && printf '%b\n' "$SAM_EVICTION_TEST_STALE_IMAGES" ;;
    esac
    exit 0 ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(command, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", command)
	t.Setenv("SAM_EVICTION_TEST_CURRENT_ID", currentID)
	t.Setenv("SAM_EVICTION_TEST_HELPER_ID", helperID)
	t.Setenv("SAM_EVICTION_TEST_STATE_FILE", stateFile)
	setEvictionTestSourceState(t, "false|true|137|2026-11-05T01:00:00Z|2026-11-05T01:09:00Z")
	t.Setenv("SAM_EVICTION_TEST_CALLS", logPath)
	return logPath
}

func setEvictionTestSourceState(t *testing.T, state string) {
	t.Helper()
	if err := os.WriteFile(os.Getenv("SAM_EVICTION_TEST_STATE_FILE"), []byte(state+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestEvictionResolverUsesActualLabelAndIncludesExitedVictim(t *testing.T) {
	s := newEvictionTestServer()
	logPath := setupEvictionDocker(t, evictionTestContainerID)
	got, ok := s.resolveEvictionWorkspaceForMetric(context.Background(), resourcemon.ContainerMetric{ID: evictionTestContainerID[:12]})
	if !ok || got.WorkspaceID != "workspace-1" || got.ContainerID != evictionTestContainerID {
		t.Fatalf("resolution = %#v, %v", got, ok)
	}
	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--all", "--latest", "--no-trunc", "label=devcontainer.local_folder=/workspace/repo"} {
		if !strings.Contains(string(calls), want) {
			t.Fatalf("missing %s in Docker call %s", want, calls)
		}
	}
}

func TestEvictionRejectsReplacementBeforeSnapshotAndStop(t *testing.T) {
	s := newEvictionTestServer()
	logPath := setupEvictionDocker(t, strings.Repeat("b", 64))
	target := resourcemon.EvictionTarget{WorkspaceID: "workspace-1", ContainerID: evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano)}
	if _, err := s.captureEvictionSessionSnapshot(context.Background(), target); err == nil {
		t.Fatal("snapshotted replacement")
	}
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err == nil {
		t.Fatal("stopped replacement")
	}
	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "stop ") {
		t.Fatalf("unexpected stop: %s", calls)
	}
}

func TestEvictionRejectsRuntimeChangedDuringSnapshot(t *testing.T) {
	s := newEvictionTestServer()
	setupEvictionDocker(t, evictionTestContainerID)
	target := resourcemon.EvictionTarget{WorkspaceID: "workspace-1", ContainerID: evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano)}
	s.workspaces["workspace-1"].UpdatedAt = time.Now()
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err == nil {
		t.Fatal("stopped newer runtime")
	}
	if s.markWorkspaceEvicted(resourcemon.EvictionResult{Target: target, ContainerStopped: true}) {
		t.Fatal("marked newer runtime")
	}
	if s.workspaces["workspace-1"].Status != "running" {
		t.Fatal("changed newer runtime status")
	}
}

func TestMarkWorkspaceEvictedRejectsStopFailure(t *testing.T) {
	s := newEvictionTestServer()
	if s.markWorkspaceEvicted(resourcemon.EvictionResult{Target: resourcemon.EvictionTarget{WorkspaceID: "workspace-1"}}) {
		t.Fatal("marked failed eviction")
	}
	if s.workspaces["workspace-1"].Status != "running" {
		t.Fatal("failed stop changed runtime status")
	}
}

func TestEvictionRejectsOOMFromPreviousRunOfSameContainer(t *testing.T) {
	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	logPath := setupEvictionDocker(t, evictionTestContainerID)
	now := time.Now().UTC()
	t.Setenv("SAM_EVICTION_TEST_STARTED_AT", now.Format(time.RFC3339Nano))
	target := resourcemon.EvictionTarget{WorkspaceID: "workspace-1", ContainerID: evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonOOMKill,
		Event:          resourcemon.PressureEvent{Type: resourcemon.PressureEventContainerOOM, OccurredAt: now.Add(-time.Minute)}}
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err == nil {
		t.Fatal("stopped container restarted after OOM event")
	}
	calls, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "stop ") {
		t.Fatalf("stopped newer run: %s", calls)
	}
	target.Event.OccurredAt = now.Add(time.Second)
	if err := s.stopEvictedWorkspaceContainer(context.Background(), target); err != nil {
		t.Fatalf("current OOM could not stop: %v", err)
	}
}

func initializeEvictionTestStore(t *testing.T, s *Server) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "eviction.db")
	store, err := persistence.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetCallbackTokenEncryptionSecret("eviction-test-encryption-key"); err != nil {
		t.Fatal(err)
	}
	s.store = store
	t.Cleanup(func() { _ = store.Close() })
	for _, runtime := range s.workspaces {
		if err := s.writeWorkspaceMetadata(runtime); err != nil {
			t.Fatal(err)
		}
	}
	return path
}
