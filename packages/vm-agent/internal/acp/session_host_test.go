package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/gorilla/websocket"
)

type bufferWriteCloser struct {
	bytes.Buffer
}

func (w *bufferWriteCloser) Close() error {
	return nil
}

// testWSPair creates a connected client+server WebSocket pair using httptest.
func testWSPair(t *testing.T) (serverConn *websocket.Conn, clientConn *websocket.Conn) {
	t.Helper()

	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	var serverOnce sync.Once
	serverReady := make(chan *websocket.Conn, 1)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("test ws upgrade: %v", err)
			return
		}
		serverOnce.Do(func() { serverReady <- c })
	}))
	t.Cleanup(ts.Close)

	url := "ws" + strings.TrimPrefix(ts.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	select {
	case server := <-serverReady:
		return server, client
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for server websocket")
		return nil, nil
	}
}

func newTestSessionHost(t *testing.T) *SessionHost {
	t.Helper()
	return NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
}

type lifecycleReport struct {
	level       string
	message     string
	source      string
	workspaceID string
	context     map[string]interface{}
}

type recordingErrorReporter struct {
	reports []lifecycleReport
}

func (r *recordingErrorReporter) ReportError(err error, source, workspaceID string, ctx map[string]interface{}) {
	message := ""
	if err != nil {
		message = err.Error()
	}
	r.reports = append(r.reports, lifecycleReport{
		level:       "error",
		message:     message,
		source:      source,
		workspaceID: workspaceID,
		context:     ctx,
	})
}

func (r *recordingErrorReporter) ReportInfo(message, source, workspaceID string, ctx map[string]interface{}) {
	r.reports = append(r.reports, lifecycleReport{
		level:       "info",
		message:     message,
		source:      source,
		workspaceID: workspaceID,
		context:     ctx,
	})
}

func (r *recordingErrorReporter) ReportWarn(message, source, workspaceID string, ctx map[string]interface{}) {
	r.reports = append(r.reports, lifecycleReport{
		level:       "warn",
		message:     message,
		source:      source,
		workspaceID: workspaceID,
		context:     ctx,
	})
}

func TestSessionHostReportLifecycleSeverityMapping(t *testing.T) {
	t.Parallel()

	reporter := &recordingErrorReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:     "test-session",
			WorkspaceID:   "test-workspace",
			ErrorReporter: reporter,
		},
	})
	defer host.Stop()

	host.reportLifecycle("info", "ACP NewSession succeeded", map[string]interface{}{"agentType": "codex"})
	host.reportLifecycle("warn", "ACP SetSessionMode failed", map[string]interface{}{"reason": "unsupported"})
	host.reportLifecycle("error", "ACP prompt force-stopped", map[string]interface{}{"timeout": "5s"})

	if len(reporter.reports) != 3 {
		t.Fatalf("report count = %d, want 3", len(reporter.reports))
	}

	want := []lifecycleReport{
		{level: "info", message: "ACP NewSession succeeded"},
		{level: "warn", message: "ACP SetSessionMode failed"},
		{level: "error", message: "ACP prompt force-stopped"},
	}
	for i, w := range want {
		got := reporter.reports[i]
		if got.level != w.level {
			t.Fatalf("report %d level = %q, want %q", i, got.level, w.level)
		}
		if got.message != w.message {
			t.Fatalf("report %d message = %q, want %q", i, got.message, w.message)
		}
		if got.source != "session-host" {
			t.Fatalf("report %d source = %q, want session-host", i, got.source)
		}
		if got.workspaceID != "test-workspace" {
			t.Fatalf("report %d workspaceID = %q, want test-workspace", i, got.workspaceID)
		}
	}
}

func TestNewSessionHost_Defaults(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{})
	if host.Status() != HostIdle {
		t.Fatalf("initial status = %s, want %s", host.Status(), HostIdle)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("initial viewer count = %d, want 0", host.ViewerCount())
	}
	if host.AgentType() != "" {
		t.Fatalf("initial agent type = %q, want empty", host.AgentType())
	}
	if host.config.MessageBufferSize != DefaultMessageBufferSize {
		t.Fatalf("default MessageBufferSize = %d, want %d", host.config.MessageBufferSize, DefaultMessageBufferSize)
	}
	if host.config.ViewerSendBuffer != DefaultViewerSendBuffer {
		t.Fatalf("default ViewerSendBuffer = %d, want %d", host.config.ViewerSendBuffer, DefaultViewerSendBuffer)
	}
	host.Stop()
}

// TestSessionHostEnsureAgentInstalledLocalFastPath verifies that in
// standalone/local mode (custom ProcessLauncher, no ContainerResolver) the
// local install path is taken. Using a command that already exists on PATH
// exercises the fast path (returns nil without running the install script).
// Critically, ContainerResolver is nil here — if the code incorrectly fell
// through to the docker install path it would panic, so a nil return proves
// the local branch was used.
func TestSessionHostEnsureAgentInstalledLocalFastPath(t *testing.T) {
	t.Parallel()

	// Pick a binary guaranteed to be on PATH in the test/CI environment.
	existing := "sh"
	if _, err := exec.LookPath(existing); err != nil {
		t.Skipf("%q not on PATH in this environment", existing)
	}

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ProcessLauncher: LocalLauncher{},
			// ContainerResolver deliberately nil: the docker path would panic.
		},
	})
	defer host.Stop()

	err := host.ensureAgentInstalled(context.Background(), agentCommandInfo{
		command:    existing,
		installCmd: "npm install -g @zed-industries/claude-agent-acp",
		isNpmBased: true,
	})
	if err != nil {
		t.Fatalf("ensureAgentInstalled() error = %v, want nil", err)
	}
}

func TestPrepareAgentStartupAppliesStandaloneRuntimeAssets(t *testing.T) {
	t.Parallel()

	workDir := t.TempDir()
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			ContainerWorkDir: workDir,
			ProcessLauncher:  LocalLauncher{},
			SAMEnvFallback:   []string{"SAM_WORKSPACE_ID=test-workspace"},
		},
		RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
			return RuntimeAssets{
				EnvVars: []RuntimeEnvVar{{
					Key:      "CUSTOM_VALUE",
					Value:    "secret-runtime-value",
					IsSecret: true,
				}},
				Files: []RuntimeFile{{
					Path:    ".sam-runtime-test.txt",
					Content: "runtime-file-present",
				}},
			}, nil
		},
	})
	defer host.Stop()

	startup, err := host.prepareAgentStartup(context.Background(), "claude-code", &agentCredential{
		credential:     "agent-key",
		credentialKind: "api-key",
	}, nil)
	if err != nil {
		t.Fatalf("prepareAgentStartup returned error: %v", err)
	}

	if !hasEnvVar(startup.envVars, "CUSTOM_VALUE") {
		t.Fatalf("runtime env var was not added: %v", startup.envVars)
	}
	if !startup.secretEnvKey["CUSTOM_VALUE"] {
		t.Fatalf("runtime secret metadata was not preserved")
	}
	content, err := os.ReadFile(filepath.Join(workDir, ".sam-runtime-test.txt"))
	if err != nil {
		t.Fatalf("runtime file was not written: %v", err)
	}
	if string(content) != "runtime-file-present" {
		t.Fatalf("runtime file content = %q", string(content))
	}
}

func TestPrepareAgentStartupRuntimeAssetFailurePreventsStart(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			ContainerWorkDir: t.TempDir(),
			ProcessLauncher:  LocalLauncher{},
		},
		RuntimeAssetsProvider: func(context.Context) (RuntimeAssets, error) {
			return RuntimeAssets{}, errors.New("runtime asset fetch failed")
		},
	})
	defer host.Stop()

	_, err := host.prepareAgentStartup(context.Background(), "claude-code", &agentCredential{
		credential:     "agent-key",
		credentialKind: "api-key",
	}, nil)
	if err == nil {
		t.Fatal("expected runtime asset provider failure to prevent startup")
	}
	if !strings.Contains(err.Error(), "runtime asset fetch failed") {
		t.Fatalf("error = %v", err)
	}
}

func TestPrepareAgentStartupStandaloneCodexOAuthWritesAuthFileToHome(t *testing.T) {
	workDir := t.TempDir()
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("CODEX_HOME", "")

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			ContainerWorkDir: workDir,
			ProcessLauncher:  LocalLauncher{},
		},
	})
	defer host.Stop()

	credential := `{"tokens":{"id_token":"id-token","refresh_token":"refresh-token"}}`
	startup, err := host.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{
		credential:     credential,
		credentialKind: "oauth-token",
	}, nil)
	if err != nil {
		t.Fatalf("prepareAgentStartup returned error: %v", err)
	}

	if startup.containerID != "" {
		t.Fatalf("containerID = %q, want standalone empty container", startup.containerID)
	}
	if !hasEnvVar(startup.envVars, "NO_BROWSER") {
		t.Fatalf("NO_BROWSER was not injected: %v", startup.envVars)
	}

	authPath := filepath.Join(homeDir, ".codex", "auth.json")
	content, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("auth file was not written under home: %v", err)
	}
	if string(content) != credential {
		t.Fatalf("auth file content = %q, want %q", string(content), credential)
	}
	assertFileMode(t, filepath.Dir(authPath), 0o700)
	assertFileMode(t, authPath, 0o600)

	if _, err := os.Stat(filepath.Join(workDir, ".codex", "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("workspace-local auth file should not exist, stat err = %v", err)
	}
}

func TestPrepareAgentStartupStandaloneCodexOAuthHonorsCodexHome(t *testing.T) {
	workDir := t.TempDir()
	homeDir := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("CODEX_HOME", codexHome)

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			ContainerWorkDir: workDir,
			ProcessLauncher:  LocalLauncher{},
		},
	})
	defer host.Stop()

	credential := `{"tokens":{"id_token":"id-token","refresh_token":"refresh-token"}}`
	if _, err := host.prepareAgentStartup(context.Background(), "openai-codex", &agentCredential{
		credential:     credential,
		credentialKind: "oauth-token",
	}, nil); err != nil {
		t.Fatalf("prepareAgentStartup returned error: %v", err)
	}

	authPath := filepath.Join(codexHome, "auth.json")
	content, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("auth file was not written under CODEX_HOME: %v", err)
	}
	if string(content) != credential {
		t.Fatalf("auth file content = %q, want %q", string(content), credential)
	}
	assertFileMode(t, filepath.Dir(authPath), 0o700)
	assertFileMode(t, authPath, 0o600)

	if _, err := os.Stat(filepath.Join(homeDir, ".codex", "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("home auth file should not exist when CODEX_HOME is set, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(workDir, ".codex", "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("workspace-local auth file should not exist, stat err = %v", err)
	}
}

func TestResolveLocalAuthFileTargetPath(t *testing.T) {
	homeDir := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("HOME", homeDir)

	tests := []struct {
		name         string
		authFilePath string
		codexHome    string
		want         string
		wantErr      string
	}{
		{
			name:         "codex auth path resolves under home when CODEX_HOME is empty",
			authFilePath: ".codex/auth.json",
			want:         filepath.Join(homeDir, ".codex", "auth.json"),
		},
		{
			name:         "codex auth path honors CODEX_HOME",
			authFilePath: ".codex/auth.json",
			codexHome:    codexHome,
			want:         filepath.Join(codexHome, "auth.json"),
		},
		{
			name:         "non-codex auth path ignores CODEX_HOME and resolves under home",
			authFilePath: ".vibe/config.toml",
			codexHome:    codexHome,
			want:         filepath.Join(homeDir, ".vibe", "config.toml"),
		},
		{
			name:         "path traversal is rejected",
			authFilePath: "../auth.json",
			wantErr:      "invalid authFilePath",
		},
		{
			name:         "shell metacharacter is rejected",
			authFilePath: ".codex/auth`bad.json",
			wantErr:      "invalid authFilePath",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("CODEX_HOME", tt.codexHome)

			got, err := resolveLocalAuthFileTargetPath(tt.authFilePath)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("resolveLocalAuthFileTargetPath() error = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveLocalAuthFileTargetPath() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("resolveLocalAuthFileTargetPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func assertFileMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode for %s = %o, want %o", path, got, want)
	}
}

func TestSessionHost_AttachDetachViewer(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	serverConn, clientConn := testWSPair(t)

	viewer := host.AttachViewer("v1", serverConn)
	if viewer == nil {
		t.Fatal("AttachViewer returned nil")
	}
	if host.ViewerCount() != 1 {
		t.Fatalf("viewer count = %d, want 1", host.ViewerCount())
	}

	// The attach sends initial session_state + session_replay_complete + post-replay session_state
	// Read session_state
	_, msg1, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_state: %v", err)
	}
	var stateMsg SessionStateMessage
	if err := json.Unmarshal(msg1, &stateMsg); err != nil {
		t.Fatalf("unmarshal session_state: %v", err)
	}
	if stateMsg.Type != MsgSessionState {
		t.Fatalf("first message type = %s, want %s", stateMsg.Type, MsgSessionState)
	}
	if stateMsg.Status != string(HostIdle) {
		t.Fatalf("session state status = %s, want %s", stateMsg.Status, HostIdle)
	}

	// Read session_replay_complete
	_, msg2, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_replay_complete: %v", err)
	}
	var replayDone map[string]interface{}
	if err := json.Unmarshal(msg2, &replayDone); err != nil {
		t.Fatalf("unmarshal replay_complete: %v", err)
	}
	if replayDone["type"] != string(MsgSessionReplayDone) {
		t.Fatalf("second message type = %v, want %s", replayDone["type"], MsgSessionReplayDone)
	}

	// Read post-replay authoritative session_state — must have replayCount=0
	_, msg3, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read post-replay session_state: %v", err)
	}
	var postStateMsg SessionStateMessage
	if err := json.Unmarshal(msg3, &postStateMsg); err != nil {
		t.Fatalf("unmarshal post-replay session_state: %v", err)
	}
	if postStateMsg.Type != MsgSessionState {
		t.Fatalf("third message type = %s, want %s", postStateMsg.Type, MsgSessionState)
	}
	if postStateMsg.ReplayCount != 0 {
		t.Fatalf("post-replay session_state replayCount = %d, want 0", postStateMsg.ReplayCount)
	}

	// Detach viewer
	host.DetachViewer("v1")
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after detach = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_AttachViewerWhenStopped(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	host.Stop()

	serverConn, _ := testWSPair(t)
	viewer := host.AttachViewer("v1", serverConn)
	if viewer != nil {
		t.Fatal("AttachViewer should return nil for stopped host")
	}
}

func TestSessionHost_BroadcastToMultipleViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Attach two viewers
	server1, client1 := testWSPair(t)
	server2, client2 := testWSPair(t)

	host.AttachViewer("v1", server1)
	host.AttachViewer("v2", server2)

	if host.ViewerCount() != 2 {
		t.Fatalf("viewer count = %d, want 2", host.ViewerCount())
	}

	// Drain the initial session_state + replay_complete messages
	drainAttachMessages := func(client *websocket.Conn) {
		for i := 0; i < 3; i++ {
			client.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, _, err := client.ReadMessage()
			if err != nil {
				t.Fatalf("drain message %d: %v", i, err)
			}
		}
	}
	drainAttachMessages(client1)
	drainAttachMessages(client2)

	// Broadcast a message
	testMsg := []byte(`{"test":"broadcast"}`)
	host.broadcastMessage(testMsg)

	// Both viewers should receive it
	readMsg := func(client *websocket.Conn, name string) []byte {
		client.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("%s read: %v", name, err)
		}
		return msg
	}

	got1 := readMsg(client1, "viewer1")
	got2 := readMsg(client2, "viewer2")

	if string(got1) != string(testMsg) {
		t.Fatalf("viewer1 got %q, want %q", got1, testMsg)
	}
	if string(got2) != string(testMsg) {
		t.Fatalf("viewer2 got %q, want %q", got2, testMsg)
	}
}

func TestSessionHost_MessageBuffer(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 5,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Add 8 messages (exceeds buffer of 5)
	for i := 0; i < 8; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	// Buffer should only contain the last 5
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()

	if bufLen != 5 {
		t.Fatalf("buffer length = %d, want 5", bufLen)
	}

	// First message in buffer should be seq 3 (0,1,2 were evicted)
	host.bufMu.RLock()
	firstMsg := host.messageBuf[0]
	host.bufMu.RUnlock()

	var parsed map[string]int
	if err := json.Unmarshal(firstMsg.Data, &parsed); err != nil {
		t.Fatalf("unmarshal first buffered message: %v", err)
	}
	if parsed["seq"] != 3 {
		t.Fatalf("first buffered message seq = %d, want 3", parsed["seq"])
	}
}

func TestSessionHost_LateJoinReplay(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Pre-fill some messages before any viewer connects
	for i := 0; i < 3; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	// Now attach a viewer — it should get session_state, 3 replayed messages,
	// replay_complete, then post-replay session_state.
	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("late-v1", serverConn)

	readAndParse := func(desc string) map[string]interface{} {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, msg, err := clientConn.ReadMessage()
		if err != nil {
			t.Fatalf("read %s: %v", desc, err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(msg, &parsed); err != nil {
			t.Fatalf("parse %s: %v", desc, err)
		}
		return parsed
	}

	// 1. session_state
	state := readAndParse("session_state")
	if state["type"] != string(MsgSessionState) {
		t.Fatalf("expected session_state, got type=%v", state["type"])
	}
	replayCount := int(state["replayCount"].(float64))
	if replayCount != 3 {
		t.Fatalf("replayCount = %d, want 3", replayCount)
	}

	// 2-4. replayed messages
	for i := 0; i < 3; i++ {
		msg := readAndParse("replay message")
		if int(msg["seq"].(float64)) != i {
			t.Fatalf("replay message %d: seq = %v, want %d", i, msg["seq"], i)
		}
	}

	// 5. session_replay_complete
	done := readAndParse("session_replay_complete")
	if done["type"] != string(MsgSessionReplayDone) {
		t.Fatalf("expected session_replay_complete, got type=%v", done["type"])
	}

	// 6. post-replay session_state — must have replayCount=0
	postState := readAndParse("post-replay session_state")
	if postState["type"] != string(MsgSessionState) {
		t.Fatalf("expected session_state, got type=%v", postState["type"])
	}
	postReplayCount := int(postState["replayCount"].(float64))
	if postReplayCount != 0 {
		t.Fatalf("post-replay session_state replayCount = %d, want 0 (non-zero would trigger double-clear on browser)", postReplayCount)
	}
}

// TestSessionHost_ReplayDoesNotDropMessages verifies that replay delivers all
// buffered messages even when the buffer exceeds the viewer's send channel
// capacity (previously messages were silently dropped by non-blocking sends).
func TestSessionHost_ReplayDoesNotDropMessages(t *testing.T) {
	t.Parallel()

	// Use a small send buffer to test the blocking replay path
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 500,
		ViewerSendBuffer:  8, // Much smaller than message count
	})
	defer host.Stop()

	// Fill buffer with more messages than the send channel capacity
	const messageCount = 50
	for i := 0; i < messageCount; i++ {
		msg, _ := json.Marshal(map[string]int{"seq": i})
		host.broadcastMessage(msg)
	}

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("replay-v1", serverConn)

	clientConn.SetReadDeadline(time.Now().Add(10 * time.Second))

	// Read session_state (pre-replay)
	_, raw, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("read session_state: %v", err)
	}
	var stateMsg SessionStateMessage
	if err := json.Unmarshal(raw, &stateMsg); err != nil {
		t.Fatalf("unmarshal session_state: %v", err)
	}
	if stateMsg.ReplayCount != messageCount {
		t.Fatalf("pre-replay replayCount = %d, want %d", stateMsg.ReplayCount, messageCount)
	}

	// Read all replay messages
	receivedCount := 0
	for {
		_, raw, err = clientConn.ReadMessage()
		if err != nil {
			t.Fatalf("read replay message: %v", err)
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatalf("parse message: %v", err)
		}
		// Check if this is the replay_complete control message
		if parsed["type"] == string(MsgSessionReplayDone) {
			break
		}
		// Check if this is a control message (session_state, etc.) — skip
		if _, isType := parsed["type"]; isType {
			continue
		}
		receivedCount++
	}

	if receivedCount != messageCount {
		t.Fatalf("received %d replay messages, want %d (messages were dropped)", receivedCount, messageCount)
	}
}

func TestSessionHost_StopDisconnectsViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	// Stop the host
	host.Stop()

	if host.Status() != HostStopped {
		t.Fatalf("status after Stop = %s, want %s", host.Status(), HostStopped)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after Stop = %d, want 0", host.ViewerCount())
	}

	// Client should get a close frame or error on next read
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := clientConn.ReadMessage()
	if err == nil {
		t.Fatal("expected error reading from client after stop, got nil")
	}
}

func TestSessionHost_StopIsIdempotent(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	host.Stop()
	host.Stop() // should not panic
	host.Stop() // should not panic

	if host.Status() != HostStopped {
		t.Fatalf("status = %s, want %s", host.Status(), HostStopped)
	}
}

func TestSessionHost_DetachNonexistentViewer(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Should not panic
	host.DetachViewer("nonexistent")

	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_SequenceNumbers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Broadcast several messages
	for i := 0; i < 5; i++ {
		msg, _ := json.Marshal(map[string]int{"i": i})
		host.broadcastMessage(msg)
	}

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()

	if len(host.messageBuf) != 5 {
		t.Fatalf("buffer length = %d, want 5", len(host.messageBuf))
	}

	// Sequence numbers should be monotonically increasing
	for i := 1; i < len(host.messageBuf); i++ {
		if host.messageBuf[i].SeqNum <= host.messageBuf[i-1].SeqNum {
			t.Fatalf("sequence numbers not monotonically increasing: %d <= %d at index %d",
				host.messageBuf[i].SeqNum, host.messageBuf[i-1].SeqNum, i)
		}
	}

	// First should be 1
	if host.messageBuf[0].SeqNum != 1 {
		t.Fatalf("first sequence number = %d, want 1", host.messageBuf[0].SeqNum)
	}
}

func TestSessionHost_ConcurrentBroadcast(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 1000,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Broadcast from many goroutines concurrently
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				msg, _ := json.Marshal(map[string]int{"goroutine": n, "seq": j})
				host.broadcastMessage(msg)
			}
		}(i)
	}
	wg.Wait()

	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()

	if bufLen != 1000 {
		t.Fatalf("buffer length = %d, want 1000", bufLen)
	}

	// Verify all sequence numbers are unique and increasing
	host.bufMu.RLock()
	for i := 1; i < len(host.messageBuf); i++ {
		if host.messageBuf[i].SeqNum <= host.messageBuf[i-1].SeqNum {
			host.bufMu.RUnlock()
			t.Fatalf("sequence numbers not monotonic at index %d: %d <= %d",
				i, host.messageBuf[i].SeqNum, host.messageBuf[i-1].SeqNum)
		}
	}
	host.bufMu.RUnlock()
}

func TestSessionHost_SetStatus(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	host.setStatus(HostReady, "")
	if host.Status() != HostReady {
		t.Fatalf("status = %s, want %s", host.Status(), HostReady)
	}

	host.setStatus(HostError, "something broke")
	if host.Status() != HostError {
		t.Fatalf("status = %s, want %s", host.Status(), HostError)
	}
}

func TestSessionHost_MarshalSessionState(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Add some messages to the buffer
	for i := 0; i < 7; i++ {
		msg, _ := json.Marshal(map[string]int{"i": i})
		host.broadcastMessage(msg)
	}

	data := host.marshalSessionState(HostReady, "claude-code", "")
	var state SessionStateMessage
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if state.Type != MsgSessionState {
		t.Fatalf("type = %s, want %s", state.Type, MsgSessionState)
	}
	if state.Status != string(HostReady) {
		t.Fatalf("status = %s, want %s", state.Status, HostReady)
	}
	if state.AgentType != "claude-code" {
		t.Fatalf("agentType = %s, want claude-code", state.AgentType)
	}
	if state.ReplayCount != 7 {
		t.Fatalf("replayCount = %d, want 7", state.ReplayCount)
	}
}

func TestSessionHost_MarshalJSONRPCError(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	reqID := json.RawMessage(`"req-123"`)
	data := host.marshalJSONRPCError(reqID, -32603, "test error")

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed["jsonrpc"] != "2.0" {
		t.Fatalf("jsonrpc = %v, want 2.0", parsed["jsonrpc"])
	}
	if parsed["id"] != "req-123" {
		t.Fatalf("id = %v, want req-123", parsed["id"])
	}
	errObj := parsed["error"].(map[string]interface{})
	if errObj["message"] != "test error" {
		t.Fatalf("error message = %v, want 'test error'", errObj["message"])
	}
}

func TestSessionHost_BroadcastAgentStatus(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	host.broadcastAgentStatus(StatusReady, "claude-code", "")

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()

	if len(host.messageBuf) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(host.messageBuf))
	}

	var status AgentStatusMessage
	if err := json.Unmarshal(host.messageBuf[0].Data, &status); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if status.Type != MsgAgentStatus {
		t.Fatalf("type = %s, want %s", status.Type, MsgAgentStatus)
	}
	if status.Status != StatusReady {
		t.Fatalf("status = %s, want %s", status.Status, StatusReady)
	}
	if status.AgentType != "claude-code" {
		t.Fatalf("agentType = %s, want claude-code", status.AgentType)
	}
}

func TestIsCrashPromptError(t *testing.T) {
	t.Parallel()

	crashErrors := []error{
		io.EOF,
		fmt.Errorf("wrapped pipe: %w", syscall.EPIPE),
		fmt.Errorf("wrapped reset: %w", syscall.ECONNRESET),
		fmt.Errorf("connection closed, peer disconnected"),
		fmt.Errorf("write: broken pipe"),
		fmt.Errorf("read tcp: connection reset by peer"),
		fmt.Errorf("write_stdin failed: stdin is closed for this session"),
	}
	for _, err := range crashErrors {
		if !isCrashPromptError(err) {
			t.Fatalf("isCrashPromptError(%q) = false, want true", err.Error())
		}
	}

	if isCrashPromptError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded should not be treated as an agent crash")
	}
	if isCrashPromptError(context.Canceled) {
		t.Fatal("context canceled should not be treated as an agent crash")
	}
	if isCrashPromptError(errors.New("permission denied")) {
		t.Fatal("unrelated errors should not be treated as agent crashes")
	}
}

func TestRedactAgentDiagnosticText(t *testing.T) {
	t.Parallel()

	input := strings.Join([]string{
		"Authorization: Bearer secret-bearer-token-123456",
		"OPENAI_API_KEY=sk-secret1234567890",
		"GH_TOKEN=ghp_secret1234567890",
		"SMOKE_TEST_TOKEN=sam_test_secret-token-123456",
		"safe diagnostic line",
	}, "\n")
	got := redactAgentDiagnosticText(input)

	for _, leaked := range []string{
		"secret-bearer-token-123456",
		"sk-secret1234567890",
		"ghp_secret1234567890",
		"sam_test_secret-token-123456",
	} {
		if strings.Contains(got, leaked) {
			t.Fatalf("redacted text leaked %q: %s", leaked, got)
		}
	}
	if !strings.Contains(got, "safe diagnostic line") {
		t.Fatalf("redacted text removed safe diagnostic line: %s", got)
	}
}

func TestSessionHost_BeginCrashRecoveryRequiresLoadSession(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-1"
	host.agentSupportsLoadSession = false
	host.mu.Unlock()

	if _, _, _, _, ok := host.beginCrashRecovery(json.RawMessage(`"req-1"`), "viewer-1"); ok {
		t.Fatal("beginCrashRecovery succeeded without LoadSession support")
	}

	host.mu.Lock()
	host.agentSupportsLoadSession = true
	host.mu.Unlock()

	agentType, _, _, _, ok := host.beginCrashRecovery(json.RawMessage(`"req-1"`), "viewer-1")
	if !ok {
		t.Fatal("beginCrashRecovery failed with LoadSession support")
	}
	if agentType != "openai-codex" {
		t.Fatalf("agentType = %q, want openai-codex", agentType)
	}

	host.mu.RLock()
	defer host.mu.RUnlock()
	if !host.crashRecoveryInProgress {
		t.Fatal("crashRecoveryInProgress = false, want true")
	}
	if string(host.crashPromptReqID) != `"req-1"` {
		t.Fatalf("crashPromptReqID = %s, want \"req-1\"", string(host.crashPromptReqID))
	}
	if host.crashPromptViewerID != "viewer-1" {
		t.Fatalf("crashPromptViewerID = %q, want viewer-1", host.crashPromptViewerID)
	}
}

func TestSessionHost_FinishPromptWithPeerDisconnectBeginsCrashRecovery(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	completed := make(chan string, 1)
	host.config.OnPromptComplete = func(stopReason string, _ error) {
		completed <- stopReason
	}
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-1"
	host.agentSupportsLoadSession = true
	host.mu.Unlock()

	host.finishPromptWithError(
		context.Background(),
		json.RawMessage(`"req-1"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
		errors.New(`{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`),
	)

	select {
	case stopReason := <-completed:
		t.Fatalf("prompt completed before crash recovery: %q", stopReason)
	case <-time.After(50 * time.Millisecond):
	}

	host.mu.RLock()
	defer host.mu.RUnlock()
	if !host.crashRecoveryInProgress {
		t.Fatal("crashRecoveryInProgress = false, want true")
	}
	if host.status != HostStarting {
		t.Fatalf("status = %s, want %s", host.status, HostStarting)
	}
}

func TestSessionHost_FinishPromptWithPeerDisconnectUsesPromptStartPrerequisitesAfterLiveStateClears(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-before-disconnect"
	host.agentSupportsLoadSession = true
	host.mu.Unlock()

	captured := host.captureCrashRecoveryPrerequisites()
	host.mu.Lock()
	host.clearCurrentAgentSessionLocked()
	host.mu.Unlock()

	host.finishPromptWithError(
		context.Background(),
		json.RawMessage(`"req-race"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1", recovery: captured},
		errors.New(`{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`),
	)

	host.mu.RLock()
	defer host.mu.RUnlock()
	if !host.crashRecoveryInProgress {
		t.Fatal("crashRecoveryInProgress = false after live prerequisites cleared, want true")
	}
	if host.crashSessionID != "acp-session-before-disconnect" {
		t.Fatalf("crashSessionID = %q, want prompt-start session ID", host.crashSessionID)
	}
	if host.crashAgentType != "openai-codex" {
		t.Fatalf("crashAgentType = %q, want openai-codex", host.crashAgentType)
	}
}

// TestSessionHost_FinishPromptRecoveryUsesCapturedAgentTypeWhenLiveAgentTypeCleared
// exercises the partial-clear merge branch: the live sessionID and LoadSession
// capability survive, but the live agentType has been cleared. Recovery must
// fill agentType from the prompt-start capture (not fail), so a LoadSession-
// capable prompt still recovers with the captured agent type.
func TestSessionHost_FinishPromptRecoveryUsesCapturedAgentTypeWhenLiveAgentTypeCleared(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-live"
	host.agentSupportsLoadSession = true
	host.mu.Unlock()

	captured := host.captureCrashRecoveryPrerequisites()
	// Clear ONLY the live agentType; sessionID and LoadSession capability remain
	// live and must win over the captured snapshot.
	host.mu.Lock()
	host.agentType = ""
	host.mu.Unlock()

	host.finishPromptWithError(
		context.Background(),
		json.RawMessage(`"req-agenttype"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1", recovery: captured},
		errors.New(`{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`),
	)

	host.mu.RLock()
	defer host.mu.RUnlock()
	if !host.crashRecoveryInProgress {
		t.Fatal("crashRecoveryInProgress = false when only live agentType was cleared, want true (captured agentType fallback)")
	}
	if host.crashAgentType != "openai-codex" {
		t.Fatalf("crashAgentType = %q, want captured openai-codex", host.crashAgentType)
	}
	if host.crashSessionID != "acp-session-live" {
		t.Fatalf("crashSessionID = %q, want live acp-session-live (live sessionID must win)", host.crashSessionID)
	}
}

func TestSessionHost_FinishPromptWithUnrecoverablePeerDisconnectReportsActionableFailure(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	completed := make(chan error, 1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		if stopReason != fatalErrorStopReason {
			t.Errorf("stopReason = %q, want %s", stopReason, fatalErrorStopReason)
		}
		completed <- promptErr
	}
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-1"
	host.agentSupportsLoadSession = false
	host.mu.Unlock()
	host.stderrMu.Lock()
	host.stderrBuf.WriteString("fatal: peer disconnected before response\nOPENAI_API_KEY=sk-secret1234567890")
	host.stderrMu.Unlock()

	host.finishPromptWithError(
		context.Background(),
		json.RawMessage(`"req-1"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
		errors.New(`{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`),
	)

	select {
	case err := <-completed:
		if err == nil {
			t.Fatal("promptErr = nil, want actionable failure")
		}
		if !strings.Contains(err.Error(), "cannot be recovered automatically") {
			t.Fatalf("promptErr = %q, want actionable recovery message", err.Error())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for prompt completion callback")
	}

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()
	foundReport := false
	foundRPCError := false
	for _, msg := range host.messageBuf {
		var report AgentCrashReportMessage
		if err := json.Unmarshal(msg.Data, &report); err == nil && report.Type == MsgAgentCrashReport {
			foundReport = true
			if report.Recovered {
				t.Fatal("crash report recovered = true, want false")
			}
			if strings.Contains(report.Stderr, "sk-secret1234567890") {
				t.Fatalf("crash report leaked secret: %q", report.Stderr)
			}
			if report.RecoveryError != "LoadSession recovery is unavailable; missing prerequisites: loadSessionCapability" {
				t.Fatalf("recoveryError = %q, want missing LoadSession capability diagnostic", report.RecoveryError)
			}
		}

		var rpc struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(msg.Data, &rpc); err == nil && strings.Contains(rpc.Error.Message, "cannot be recovered automatically") {
			foundRPCError = true
		}
	}
	if !foundReport {
		t.Fatal("missing unrecovered crash report")
	}
	if !foundRPCError {
		t.Fatal("missing actionable JSON-RPC error")
	}

	// After an unrecoverable crash the host must be in HostError, not HostReady.
	if status := host.Status(); status != HostError {
		t.Fatalf("host.Status() = %s after unrecoverable crash, want %s", status, HostError)
	}

	// No recovery episode may be left armed on the unrecoverable path: a lingering
	// crashRecoveryInProgress would let the watchdog fire a second terminal
	// completion. The terminal error must be the only outcome.
	host.mu.RLock()
	inRecovery := host.crashRecoveryInProgress
	host.mu.RUnlock()
	if inRecovery {
		t.Fatal("crashRecoveryInProgress = true after unrecoverable crash, want false (no recovery episode may be armed)")
	}
}

// TestSessionHost_UnrecoverablePeerDisconnectNamesEachMissingPrerequisite proves
// the sanitized terminal diagnostic identifies exactly which recovery
// prerequisites were absent — for each prerequisite in isolation and for all
// three together — never leaking the actual session ID value. The existing
// TestSessionHost_FinishPromptWithUnrecoverablePeerDisconnectReportsActionableFailure
// covers only the loadSessionCapability-missing permutation.
func TestSessionHost_UnrecoverablePeerDisconnectNamesEachMissingPrerequisite(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name                string
		sessionID           string
		agentType           string
		supportsLoadSession bool
		wantMissing         string
	}{
		{
			name:                "only acpSessionId missing",
			sessionID:           "",
			agentType:           "openai-codex",
			supportsLoadSession: true,
			wantMissing:         "acpSessionId",
		},
		{
			name:                "only agentType missing",
			sessionID:           "acp-session-1",
			agentType:           "",
			supportsLoadSession: true,
			wantMissing:         "agentType",
		},
		{
			name:                "all three missing",
			sessionID:           "",
			agentType:           "",
			supportsLoadSession: false,
			wantMissing:         "acpSessionId, loadSessionCapability, agentType",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			host := newTestSessionHost(t)
			defer host.Stop()

			completed := make(chan string, 1)
			host.config.OnPromptComplete = func(stopReason string, _ error) { completed <- stopReason }
			host.mu.Lock()
			host.agentType = tc.agentType
			host.sessionID = acpsdk.SessionId(tc.sessionID)
			host.agentSupportsLoadSession = tc.supportsLoadSession
			host.mu.Unlock()

			// Empty recovery snapshot: no captured fallback, so the live gaps are
			// the only prerequisites and the diagnostic must name exactly them.
			host.finishPromptWithError(
				context.Background(),
				json.RawMessage(`"req-diag"`),
				promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"},
				errors.New(`{"code":-32603,"message":"Internal error","data":{"error":"peer disconnected before response"}}`),
			)

			select {
			case reason := <-completed:
				if reason != fatalErrorStopReason {
					t.Fatalf("stopReason = %q, want %s", reason, fatalErrorStopReason)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for terminal completion")
			}

			wantErr := "LoadSession recovery is unavailable; missing prerequisites: " + tc.wantMissing
			host.bufMu.RLock()
			foundReport := false
			for _, msg := range host.messageBuf {
				var report AgentCrashReportMessage
				if err := json.Unmarshal(msg.Data, &report); err == nil && report.Type == MsgAgentCrashReport {
					foundReport = true
					if report.RecoveryError != wantErr {
						t.Fatalf("recoveryError = %q, want %q", report.RecoveryError, wantErr)
					}
					// The diagnostic must never contain a real session ID value.
					if tc.sessionID != "" && strings.Contains(report.RecoveryError, tc.sessionID) {
						t.Fatalf("recoveryError leaked session ID value: %q", report.RecoveryError)
					}
				}
			}
			host.bufMu.RUnlock()
			if !foundReport {
				t.Fatal("missing unrecovered crash report")
			}

			host.mu.RLock()
			inRecovery := host.crashRecoveryInProgress
			host.mu.RUnlock()
			if inRecovery {
				t.Fatal("crashRecoveryInProgress = true after terminal diagnostic, want false")
			}
		})
	}
}

func TestSessionHost_FinishPromptDeadlineExceededReportsFatalWithoutCrashRecovery(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	completed := make(chan string, 1)
	host.config.OnPromptComplete = func(stopReason string, _ error) {
		completed <- stopReason
	}
	host.mu.Lock()
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-1"
	host.agentSupportsLoadSession = true
	host.mu.Unlock()

	promptCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	host.finishPromptWithError(
		promptCtx,
		json.RawMessage(`"req-1"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1", timeout: 6 * time.Hour},
		errors.New("peer disconnected before response"),
	)

	select {
	case stopReason := <-completed:
		if stopReason != fatalErrorStopReason {
			t.Fatalf("stopReason = %q, want %s", stopReason, fatalErrorStopReason)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for prompt completion callback")
	}

	host.mu.RLock()
	defer host.mu.RUnlock()
	if host.crashRecoveryInProgress {
		t.Fatal("crashRecoveryInProgress = true, want false for prompt deadline")
	}
}

func TestSessionHost_BroadcastAgentCrashReport(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	report := host.crashReport(crashRecoverySnapshot{
		stderr:      "write_stdin failed: stdin is closed\nOPENAI_API_KEY=sk-secret1234567890",
		agentType:   "openai-codex",
		promptReqID: json.RawMessage(`"req-1"`),
	}, true, "")
	host.broadcastAgentCrashReport(report)

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()

	if len(host.messageBuf) != 1 {
		t.Fatalf("buffer length = %d, want 1", len(host.messageBuf))
	}

	var got AgentCrashReportMessage
	if err := json.Unmarshal(host.messageBuf[0].Data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != MsgAgentCrashReport {
		t.Fatalf("type = %s, want %s", got.Type, MsgAgentCrashReport)
	}
	if got.AgentType != "openai-codex" {
		t.Fatalf("agentType = %q, want openai-codex", got.AgentType)
	}
	if !got.Recovered {
		t.Fatal("recovered = false, want true")
	}
	if !strings.Contains(got.Attribution, "not SAM") {
		t.Fatalf("attribution = %q, want SAM fault attribution", got.Attribution)
	}
	if !strings.Contains(got.Stderr, "stdin is closed") {
		t.Fatalf("stderr = %q, want captured stderr", got.Stderr)
	}
	if strings.Contains(got.Stderr, "sk-secret1234567890") {
		t.Fatalf("stderr leaked secret: %q", got.Stderr)
	}
	if !strings.Contains(got.Suggestion, "OpenAI") {
		t.Fatalf("suggestion = %q, want OpenAI vendor attribution", got.Suggestion)
	}
	if strings.Contains(string(host.messageBuf[0].Data), "originalPromptId") {
		t.Fatalf("crash report exposed originalPromptId: %s", string(host.messageBuf[0].Data))
	}
}

func TestSessionHost_MonitorRapidExitCrashRecoveryFailsWithReport(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	done := make(chan string, 1)
	host.config.OnPromptComplete = func(stopReason string, promptErr error) {
		if promptErr == nil {
			t.Errorf("promptErr = nil, want rapid-exit error")
		}
		done <- stopReason
	}

	cmd := exec.Command("sh", "-c", "exit 1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start command: %v", err)
	}
	process := &AgentProcess{
		agentType: "openai-codex",
		cmd:       cmd,
		startTime: time.Now(),
		waitDone:  make(chan struct{}),
	}
	process.SetRecoveryNotify(func(stopReason string, promptErr error) {
		host.notifyPromptComplete(stopReason, promptErr)
	})

	host.mu.Lock()
	host.process = process
	host.status = HostReady
	host.agentType = "openai-codex"
	host.sessionID = "acp-session-1"
	host.crashRecoveryInProgress = true
	host.crashAgentType = "openai-codex"
	host.crashStderr = "write_stdin failed: stdin is closed\nOPENAI_API_KEY=sk-secret1234567890"
	host.mu.Unlock()

	host.monitorProcessExit(context.Background(), process, "openai-codex", nil, nil)

	select {
	case stopReason := <-done:
		if stopReason != fatalErrorStopReason {
			t.Fatalf("stopReason = %q, want %s", stopReason, fatalErrorStopReason)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for prompt completion callback")
	}

	host.bufMu.RLock()
	defer host.bufMu.RUnlock()
	if len(host.messageBuf) == 0 {
		t.Fatal("message buffer empty, want crash report/status")
	}
	var report AgentCrashReportMessage
	foundReport := false
	for _, msg := range host.messageBuf {
		if err := json.Unmarshal(msg.Data, &report); err == nil && report.Type == MsgAgentCrashReport {
			foundReport = true
			break
		}
	}
	if !foundReport {
		t.Fatalf("crash report not broadcast; buffered messages = %d", len(host.messageBuf))
	}
	if report.Recovered {
		t.Fatal("recovered = true, want false for rapid exit")
	}
	if strings.Contains(report.Stderr, "sk-secret1234567890") {
		t.Fatalf("crash report leaked secret: %q", report.Stderr)
	}
}

func TestSessionHost_ViewerDisconnectDoesNotStopAgent(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate agent is ready
	host.setStatus(HostReady, "")

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	// Close the client connection (simulates browser closing)
	clientConn.Close()

	// Detach the viewer (this is what the server does when WS closes)
	host.DetachViewer("v1")

	// Agent should still be "ready" — NOT stopped
	if host.Status() != HostReady {
		t.Fatalf("status after viewer disconnect = %s, want %s", host.Status(), HostReady)
	}
	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count = %d, want 0", host.ViewerCount())
	}
}

func TestSessionHost_CancelPrompt_NoPromptInFlight(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// CancelPrompt when no prompt is running should be a no-op (not panic)
	host.CancelPrompt()

	// Status should remain idle
	if host.Status() != HostIdle {
		t.Fatalf("status = %s, want %s", host.Status(), HostIdle)
	}
}

func TestSessionHost_CancelPrompt_CancelsContext(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate a prompt in flight by manually setting up the cancel state
	// (we can't easily start a real ACP prompt without a full agent process,
	// but we can test the cancel mechanism directly).
	ctx, cancel := context.WithCancel(context.Background())

	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Verify context is not yet cancelled
	select {
	case <-ctx.Done():
		t.Fatal("context should not be cancelled yet")
	default:
		// good
	}

	// Cancel the prompt
	host.CancelPrompt()

	// Context should now be cancelled
	select {
	case <-ctx.Done():
		// good — context was cancelled
	default:
		t.Fatal("context should be cancelled after CancelPrompt")
	}
}

func TestSessionHost_CancelPromptFromControlPlane_ForwardsSessionCancel(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer func() {
		host.mu.Lock()
		host.process = nil
		host.mu.Unlock()
		host.Stop()
	}()

	stdin := &bufferWriteCloser{}
	host.mu.Lock()
	host.agentType = "claude-code"
	host.process = &AgentProcess{stdin: stdin}
	host.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	host.CancelPromptFromControlPlane()

	select {
	case <-ctx.Done():
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected prompt context to be cancelled")
	}

	got := strings.TrimSpace(stdin.String())
	want := `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"test-session"}}`
	if got != want {
		t.Fatalf("forwarded cancel = %q, want %q", got, want)
	}

	host.mu.RLock()
	process := host.process
	intentionalStop := host.intentionalPromptCancelProcessStop
	host.mu.RUnlock()
	agentProc, ok := process.(*AgentProcess)
	if process == nil || !ok || !agentProc.stopped {
		t.Fatal("expected control-plane cancel to stop the agent process")
	}
	if !intentionalStop {
		t.Fatal("expected control-plane cancel to mark process stop as intentional")
	}
}

func TestSessionHost_MonitorIntentionalPromptCancelDoesNotConsumeRestartBudget(t *testing.T) {
	t.Parallel()

	process := newExitedAgentProcess(t, "claude-code")
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			MaxRestartAttempts: 1,
			ContainerResolver:  func() (string, error) { return "", errors.New("container unavailable") },
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	host.mu.Lock()
	host.process = process
	host.status = HostReady
	host.agentType = "claude-code"
	host.sessionID = "acp-session-1"
	host.restartCount = 1
	host.intentionalPromptCancelProcessStop = true
	host.mu.Unlock()

	host.monitorProcessExit(context.Background(), process, "claude-code", nil, nil)

	host.mu.RLock()
	restartCount := host.restartCount
	statusErr := host.statusErr
	host.mu.RUnlock()

	if restartCount != 1 {
		t.Fatalf("restartCount = %d, want 1 after intentional prompt cancel", restartCount)
	}
	if strings.Contains(statusErr, "could not be restarted") {
		t.Fatalf("statusErr = %q, expected restart attempt rather than max-restarts failure", statusErr)
	}
	if !strings.Contains(statusErr, "container unavailable") {
		t.Fatalf("statusErr = %q, expected restart attempt failure from container resolver", statusErr)
	}
}

func TestSessionHost_MonitorUnexpectedExitConsumesRestartBudget(t *testing.T) {
	t.Parallel()

	process := newExitedAgentProcess(t, "claude-code")
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			MaxRestartAttempts: 1,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	host.mu.Lock()
	host.process = process
	host.status = HostReady
	host.agentType = "claude-code"
	host.sessionID = "acp-session-1"
	host.restartCount = 1
	host.mu.Unlock()

	host.monitorProcessExit(context.Background(), process, "claude-code", nil, nil)

	host.mu.RLock()
	restartCount := host.restartCount
	status := host.status
	statusErr := host.statusErr
	host.mu.RUnlock()

	if restartCount != 2 {
		t.Fatalf("restartCount = %d, want 2 after unexpected exit", restartCount)
	}
	if status != HostError {
		t.Fatalf("status = %s, want %s", status, HostError)
	}
	if !strings.Contains(statusErr, "could not be restarted") {
		t.Fatalf("statusErr = %q, expected max-restarts failure", statusErr)
	}
}

func newExitedAgentProcess(t *testing.T, agentType string) *AgentProcess {
	t.Helper()

	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start command: %v", err)
	}

	return &AgentProcess{
		agentType: agentType,
		cmd:       cmd,
		startTime: time.Now().Add(-10 * time.Second),
		waitDone:  make(chan struct{}),
	}
}

func TestSessionHost_CancelPrompt_ConcurrentSafety(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Set up a cancel function
	_, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Call CancelPrompt from many goroutines concurrently — should not race or panic
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			host.CancelPrompt()
		}()
	}
	wg.Wait()
}

func TestSessionHost_CancelPrompt_ClearedAfterPromptDone(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	// Simulate: promptCancel is set, then cleared (as HandlePrompt does after Prompt() returns)
	_, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.promptCancelMu.Unlock()

	// Simulate prompt completion clearing the cancel
	host.promptCancelMu.Lock()
	host.promptCancel = nil
	host.promptCancelMu.Unlock()

	// CancelPrompt should now be a no-op
	host.CancelPrompt()
	// No panic, no side effects — just verifying safety
}

func TestSessionHost_SendToViewerPriority_EvictsQueuedMessage(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	viewer := &Viewer{
		ID:     "v1",
		sendCh: make(chan []byte, 1),
		done:   make(chan struct{}),
	}

	viewer.sendCh <- []byte(`{"old":true}`)
	host.sendToViewerPriority(viewer, []byte(`{"priority":true}`))

	select {
	case msg := <-viewer.sendCh:
		if string(msg) != `{"priority":true}` {
			t.Fatalf("priority message not delivered, got %s", string(msg))
		}
	default:
		t.Fatal("expected a priority message in viewer channel")
	}
}

func TestSessionHost_Suspend(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	// Set up some state to verify it's preserved
	host.mu.Lock()
	host.agentType = "claude-code"
	host.sessionID = "acp-session-xyz"
	host.status = HostReady
	host.mu.Unlock()

	acpSessionID, agentType := host.Suspend()

	if acpSessionID != "acp-session-xyz" {
		t.Fatalf("acpSessionID = %q, want 'acp-session-xyz'", acpSessionID)
	}
	if agentType != "claude-code" {
		t.Fatalf("agentType = %q, want 'claude-code'", agentType)
	}
	if host.Status() != HostStopped {
		t.Fatalf("status after suspend = %s, want %s", host.Status(), HostStopped)
	}
}

func TestSessionHost_SuspendDisconnectsViewers(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	serverConn, clientConn := testWSPair(t)
	host.AttachViewer("v1", serverConn)

	// Drain attach messages
	for i := 0; i < 3; i++ {
		clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = clientConn.ReadMessage()
	}

	host.Suspend()

	if host.ViewerCount() != 0 {
		t.Fatalf("viewer count after suspend = %d, want 0", host.ViewerCount())
	}

	// Client should get a close frame or error
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := clientConn.ReadMessage()
	if err == nil {
		t.Fatal("expected error reading from client after suspend")
	}
}

func TestSessionHost_SuspendWhenStopped(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	host.Stop()

	acpSessionID, agentType := host.Suspend()
	if acpSessionID != "" {
		t.Fatalf("acpSessionID = %q, want empty for already-stopped host", acpSessionID)
	}
	if agentType != "" {
		t.Fatalf("agentType = %q, want empty for already-stopped host", agentType)
	}
}

func TestSessionHost_IsPrompting(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	if host.IsPrompting() {
		t.Fatal("expected IsPrompting=false for idle host")
	}

	host.setStatus(HostReady, "")
	if host.IsPrompting() {
		t.Fatal("expected IsPrompting=false for ready host")
	}

	host.setStatus(HostPrompting, "")
	if !host.IsPrompting() {
		t.Fatal("expected IsPrompting=true for prompting host")
	}
}

func TestSessionHost_AutoSuspendTimerStartsOnLastViewerDetach(t *testing.T) {
	t.Parallel()

	suspendCalled := make(chan struct{}, 1)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 50 * time.Millisecond,
			OnSuspend: func(wsID, sessID string) {
				suspendCalled <- struct{}{}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	// Attach and detach a viewer to trigger the timer
	serverConn, _ := testWSPair(t)
	host.AttachViewer("v1", serverConn)
	host.DetachViewer("v1")

	// Timer should fire and call OnSuspend
	select {
	case <-suspendCalled:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("expected OnSuspend to be called after idle timeout")
	}
}

func TestSessionHost_AutoSuspendCancelledByViewerAttach(t *testing.T) {
	t.Parallel()

	suspendCalled := make(chan struct{}, 1)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 100 * time.Millisecond,
			OnSuspend: func(wsID, sessID string) {
				suspendCalled <- struct{}{}
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Attach, detach (starts timer), then re-attach (should cancel timer)
	server1, _ := testWSPair(t)
	host.AttachViewer("v1", server1)
	host.DetachViewer("v1")

	// Re-attach before timer fires
	time.Sleep(30 * time.Millisecond) // well before 100ms timeout
	server2, _ := testWSPair(t)
	host.AttachViewer("v2", server2)

	// Wait past the original timeout — suspend should NOT fire
	select {
	case <-suspendCalled:
		t.Fatal("OnSuspend should NOT have been called — viewer re-attached")
	case <-time.After(300 * time.Millisecond):
		// good — timer was cancelled
	}
}

func TestSessionHost_AutoSuspendDisabledWhenTimeoutZero(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:          "test-session",
			WorkspaceID:        "test-workspace",
			IdleSuspendTimeout: 0, // disabled
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	serverConn, _ := testWSPair(t)
	host.AttachViewer("v1", serverConn)
	host.DetachViewer("v1")

	// Verify no timer was set
	host.viewerMu.RLock()
	hasTimer := host.suspendTimer != nil
	host.viewerMu.RUnlock()

	if hasTimer {
		t.Fatal("suspendTimer should be nil when IdleSuspendTimeout is 0")
	}
}

// --- phaseTimeout tests ---

func TestPhaseTimeout_UsesPerPhaseWhenSet(t *testing.T) {
	t.Parallel()

	fallback := 30 * time.Second

	if got := phaseTimeout(45000, fallback); got != 45*time.Second {
		t.Fatalf("InitializeTimeout: got %v, want 45s", got)
	}
	if got := phaseTimeout(60000, fallback); got != 60*time.Second {
		t.Fatalf("NewSessionTimeout: got %v, want 60s", got)
	}
	if got := phaseTimeout(15000, fallback); got != 15*time.Second {
		t.Fatalf("LoadSessionTimeout: got %v, want 15s", got)
	}
}

func TestPhaseTimeout_FallsBackWhenZero(t *testing.T) {
	t.Parallel()

	fallback := 30 * time.Second

	if got := phaseTimeout(0, fallback); got != fallback {
		t.Fatalf("phaseTimeout(0, 30s): got %v, want %v", got, fallback)
	}
}

func TestPhaseTimeout_FallsBackWhenNegative(t *testing.T) {
	t.Parallel()

	fallback := 30 * time.Second

	if got := phaseTimeout(-1, fallback); got != fallback {
		t.Fatalf("phaseTimeout(-1, 30s): got %v, want %v", got, fallback)
	}
	if got := phaseTimeout(-99999, fallback); got != fallback {
		t.Fatalf("phaseTimeout(-99999, 30s): got %v, want %v", got, fallback)
	}
}

// --- Message reporter integration tests (T025) ---

// mockMessageReporter captures enqueued messages for testing.
type mockMessageReporter struct {
	mu       sync.Mutex
	messages []MessageReportEntry
	errOnce  error // if set, return this error on first Enqueue call
}

func (m *mockMessageReporter) Enqueue(msg MessageReportEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.errOnce != nil {
		err := m.errOnce
		m.errOnce = nil
		return err
	}
	m.messages = append(m.messages, msg)
	return nil
}

func (m *mockMessageReporter) Messages() []MessageReportEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]MessageReportEntry, len(m.messages))
	copy(cp, m.messages)
	return cp
}

func TestSessionUpdate_NilReporter_StillBroadcasts(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: nil, // no reporter
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "hello"},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	// Message should be in the broadcast buffer.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 1 {
		t.Fatalf("expected 1 buffered message, got %d", bufLen)
	}
}

func TestSessionUpdate_WithReporter_EnqueuesMessages(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentMessageChunk: &acpsdk.SessionUpdateAgentMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "assistant response"},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	msgs := reporter.Messages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 enqueued message, got %d", len(msgs))
	}
	if msgs[0].Role != "assistant" {
		t.Fatalf("role = %q, want assistant", msgs[0].Role)
	}
	if msgs[0].Content != "assistant response" {
		t.Fatalf("content = %q, want 'assistant response'", msgs[0].Content)
	}
	if msgs[0].MessageID == "" {
		t.Fatal("expected non-empty messageId")
	}
}

func TestSessionUpdate_MarshalError_NonBlocking(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			ToolCall: &acpsdk.SessionUpdateToolCall{
				ToolCallId: "tool-1",
				Title:      "Run tool",
				RawInput:   make(chan int),
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate should not fail on marshal error: %v", err)
	}

	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 0 {
		t.Fatalf("expected broadcast to be skipped, got %d buffered messages", bufLen)
	}

	msgs := reporter.Messages()
	if len(msgs) != 1 {
		t.Fatalf("expected message extraction to continue, got %d enqueued messages", len(msgs))
	}
	if msgs[0].Role != "tool" {
		t.Fatalf("role = %q, want tool", msgs[0].Role)
	}
}

func TestSessionUpdate_EnqueueError_NonBlocking(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{
		errOnce: fmt.Errorf("outbox full"),
	}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: "user msg"},
				},
			},
		},
	}

	// SessionUpdate should return nil even if Enqueue fails.
	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate should not fail on Enqueue error: %v", err)
	}

	// Broadcast should still have worked.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufLen != 1 {
		t.Fatalf("expected broadcast to still work, got %d buffered messages", bufLen)
	}
}

func TestSessionUpdate_EmptyUpdate_NoEnqueue(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	client := &sessionHostClient{host: host}

	// Send an update with an AgentThoughtChunk that has empty text.
	// ExtractMessages skips thought chunks with empty text content.
	notif := acpsdk.SessionNotification{
		SessionId: "acp-sess",
		Update: acpsdk.SessionUpdate{
			AgentThoughtChunk: &acpsdk.SessionUpdateAgentThoughtChunk{
				Content: acpsdk.ContentBlock{
					Text: &acpsdk.ContentBlockText{Text: ""},
				},
			},
		},
	}

	if err := client.SessionUpdate(context.Background(), notif); err != nil {
		t.Fatalf("SessionUpdate: %v", err)
	}

	msgs := reporter.Messages()
	if len(msgs) != 0 {
		t.Fatalf("expected 0 enqueued messages for empty thought text, got %d", len(msgs))
	}
}

func TestSessionHost_CancelPrompt_ForceStopsAfterGracePeriod(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:               "test-session",
			WorkspaceID:             "test-workspace",
			PromptCancelGracePeriod: 10 * time.Millisecond,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	host.mu.Lock()
	host.status = HostPrompting
	host.agentType = "claude-code"
	host.mu.Unlock()

	host.promptMu.Lock()
	host.promptInFlight = true
	host.promptMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	host.promptCancelMu.Lock()
	host.promptCancel = cancel
	host.activePromptID = 42
	host.promptCancelMu.Unlock()

	host.CancelPrompt()

	select {
	case <-ctx.Done():
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected prompt context to be cancelled")
	}

	deadline := time.Now().Add(1 * time.Second)
	for host.Status() != HostError {
		if time.Now().After(deadline) {
			t.Fatal("expected host to transition to error after cancel grace elapsed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	host.mu.RLock()
	statusErr := host.statusErr
	host.mu.RUnlock()
	if !strings.Contains(statusErr, "Prompt cancel grace elapsed") {
		t.Fatalf("statusErr = %q, expected cancel grace reason", statusErr)
	}

	host.promptCancelMu.Lock()
	if host.activePromptID != 0 {
		t.Fatalf("activePromptID = %d, want 0", host.activePromptID)
	}
	if host.promptCancel != nil {
		t.Fatal("promptCancel should be cleared after force-stop")
	}
	host.promptCancelMu.Unlock()

	host.promptMu.Lock()
	if host.promptInFlight {
		t.Fatal("promptInFlight should be false after force-stop")
	}
	host.promptMu.Unlock()

	bufferDeadline := time.Now().Add(500 * time.Millisecond)
	for {
		host.bufMu.RLock()
		buffered := len(host.messageBuf)
		host.bufMu.RUnlock()
		if buffered >= 2 {
			break
		}
		if time.Now().After(bufferDeadline) {
			t.Fatalf("expected prompt_done + error status messages, buffered=%d", buffered)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHandlePrompt_InjectsSyntheticUserMessage(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	// Create a minimal ACP connection backed by a pipe. We close both agent-
	// side ends so that Prompt() fails immediately: agentWriter.Close causes
	// the receive loop to exit (peer closed), agentReader.Close causes the
	// sendMessage write to fail (broken pipe). The synthetic user message
	// injection happens BEFORE Prompt() is called, so the buffer and reporter
	// will have the user messages regardless.
	agentReader, clientWriter := io.Pipe()
	clientReader, agentWriter := io.Pipe()
	agentWriter.Close()
	agentReader.Close()

	acpConn := acpsdk.NewClientSideConnection(
		&sessionHostClient{host: host},
		clientWriter,
		clientReader,
	)

	// Set up host state so HandlePrompt passes the nil checks.
	host.mu.Lock()
	host.acpConn = acpConn
	host.sessionID = "acp-session-123"
	host.status = HostReady
	host.mu.Unlock()

	// Build a prompt request payload
	promptParams, _ := json.Marshal(map[string]interface{}{
		"messageId": "pre-persisted-msg-001",
		"prompt": []map[string]string{
			{"type": "text", "text": "Hello, please fix the bug"},
		},
	})
	reqID, _ := json.Marshal(42)

	// HandlePrompt is blocking but will return quickly because Prompt() fails.
	host.HandlePrompt(context.Background(), reqID, promptParams, "viewer-1", false)

	// Verify: the replay buffer should contain the synthetic user_message_chunk.
	host.bufMu.RLock()
	bufCopy := make([]BufferedMessage, len(host.messageBuf))
	copy(bufCopy, host.messageBuf)
	host.bufMu.RUnlock()

	foundUserMessage := false
	for _, bm := range bufCopy {
		var envelope struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(bm.Data, &envelope); err != nil {
			continue
		}
		if envelope.Method != "session/update" {
			continue
		}

		var notif struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"update"`
		}
		if err := json.Unmarshal(envelope.Params, &notif); err != nil {
			continue
		}
		if notif.Update.SessionUpdate == "user_message_chunk" &&
			notif.Update.Content.Text == "Hello, please fix the bug" {
			foundUserMessage = true
			break
		}
	}

	if !foundUserMessage {
		var types []string
		for _, bm := range bufCopy {
			types = append(types, string(bm.Data[:min(len(bm.Data), 120)]))
		}
		t.Fatalf("replay buffer missing synthetic user_message_chunk; buffer contents (%d items): %v",
			len(bufCopy), types)
	}

	// Verify: the message reporter should have the user message enqueued.
	msgs := reporter.Messages()
	foundReported := false
	for _, m := range msgs {
		if m.MessageID == "pre-persisted-msg-001" &&
			m.Role == "user" &&
			m.Content == "Hello, please fix the bug" {
			foundReported = true
			break
		}
	}
	if !foundReported {
		t.Fatalf("message reporter missing user message; got %d messages: %+v", len(msgs), msgs)
	}
}

// A browser viewer prompt (trustedSource=false) must NOT be able to mark its own
// content origin=system via the ACP _meta marker — the marker is stripped so the
// reported message has an empty Origin. Only the SAM control-plane initial prompt
// (trustedSource=true) may set origin=system. This closes the evasion where a
// viewer could hide their content from search/dedup/topic/attention.
func TestHandlePrompt_OriginMarkerHonoredOnlyForTrustedSource(t *testing.T) {
	t.Parallel()

	reportedOrigin := func(trusted bool) string {
		reporter := &mockMessageReporter{}
		host := NewSessionHost(SessionHostConfig{
			GatewayConfig: GatewayConfig{
				SessionID:       "test-session",
				WorkspaceID:     "test-workspace",
				MessageReporter: reporter,
			},
			MessageBufferSize: 100,
			ViewerSendBuffer:  32,
		})
		defer host.Stop()

		agentReader, clientWriter := io.Pipe()
		clientReader, agentWriter := io.Pipe()
		agentWriter.Close()
		agentReader.Close()
		acpConn := acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, clientWriter, clientReader)

		host.mu.Lock()
		host.acpConn = acpConn
		host.sessionID = "acp-session-origin"
		host.status = HostReady
		host.mu.Unlock()

		// A prompt block carrying the SAM system-origin marker in _meta.
		promptParams, _ := json.Marshal(map[string]any{
			"messageId": "origin-msg-001",
			"prompt": []map[string]any{
				{"type": "text", "text": "sneaky content", "_meta": map[string]any{MetaOriginKey: OriginSystem}},
			},
		})
		reqID, _ := json.Marshal(77)
		host.HandlePrompt(context.Background(), reqID, promptParams, "viewer-1", trusted)

		for _, m := range reporter.Messages() {
			if m.MessageID == "origin-msg-001" && m.Role == "user" {
				return m.Origin
			}
		}
		t.Fatalf("reporter missing user message (trusted=%v)", trusted)
		return ""
	}

	if got := reportedOrigin(false); got != "" {
		t.Fatalf("untrusted viewer prompt: Origin = %q, want empty (marker must be stripped)", got)
	}
	if got := reportedOrigin(true); got != OriginSystem {
		t.Fatalf("trusted control-plane prompt: Origin = %q, want %q", got, OriginSystem)
	}
}

func TestHandlePrompt_MultiBlockPrompt_InjectsAllBlocks(t *testing.T) {
	t.Parallel()

	reporter := &mockMessageReporter{}

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: reporter,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	agentReader, clientWriter := io.Pipe()
	clientReader, agentWriter := io.Pipe()
	agentWriter.Close()
	agentReader.Close()

	acpConn := acpsdk.NewClientSideConnection(
		&sessionHostClient{host: host},
		clientWriter,
		clientReader,
	)

	host.mu.Lock()
	host.acpConn = acpConn
	host.sessionID = "acp-session-456"
	host.status = HostReady
	host.mu.Unlock()

	promptParams, _ := json.Marshal(map[string]interface{}{
		"prompt": []map[string]string{
			{"type": "text", "text": "First block"},
			{"type": "text", "text": "Second block"},
		},
	})
	reqID, _ := json.Marshal(43)

	host.HandlePrompt(context.Background(), reqID, promptParams, "viewer-1", false)

	// Both text blocks should be reported.
	msgs := reporter.Messages()
	userMsgs := []string{}
	for _, m := range msgs {
		if m.Role == "user" {
			userMsgs = append(userMsgs, m.Content)
		}
	}

	if len(userMsgs) != 2 {
		t.Fatalf("expected 2 user messages, got %d: %v", len(userMsgs), userMsgs)
	}
	if userMsgs[0] != "First block" {
		t.Fatalf("first user message = %q, want 'First block'", userMsgs[0])
	}
	if userMsgs[1] != "Second block" {
		t.Fatalf("second user message = %q, want 'Second block'", userMsgs[1])
	}
}

func TestHandlePrompt_NoReporter_StillBuffers(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:       "test-session",
			WorkspaceID:     "test-workspace",
			MessageReporter: nil, // no reporter
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	defer host.Stop()

	agentReader, clientWriter := io.Pipe()
	clientReader, agentWriter := io.Pipe()
	agentWriter.Close()
	agentReader.Close()

	acpConn := acpsdk.NewClientSideConnection(
		&sessionHostClient{host: host},
		clientWriter,
		clientReader,
	)

	host.mu.Lock()
	host.acpConn = acpConn
	host.sessionID = "acp-session-789"
	host.status = HostReady
	host.mu.Unlock()

	promptParams, _ := json.Marshal(map[string]interface{}{
		"prompt": []map[string]string{
			{"type": "text", "text": "test without reporter"},
		},
	})
	reqID, _ := json.Marshal(44)

	host.HandlePrompt(context.Background(), reqID, promptParams, "viewer-1", false)

	// Buffer should have the synthetic user message even without a reporter.
	host.bufMu.RLock()
	bufLen := len(host.messageBuf)
	host.bufMu.RUnlock()

	// At minimum: user_message_chunk + some control messages from prompt flow
	if bufLen < 1 {
		t.Fatalf("expected at least 1 buffered message, got %d", bufLen)
	}

	// Verify the user message is in the buffer.
	host.bufMu.RLock()
	var foundUser bool
	for _, bm := range host.messageBuf {
		if strings.Contains(string(bm.Data), "user_message_chunk") &&
			strings.Contains(string(bm.Data), "test without reporter") {
			foundUser = true
			break
		}
	}
	host.bufMu.RUnlock()

	if !foundUser {
		t.Fatal("expected user_message_chunk in buffer when no reporter is configured")
	}
}

// mockCredentialSyncer implements CredentialSyncer for testing.
type mockCredentialSyncer struct {
	mu          sync.Mutex
	called      bool
	workspaceID string
	agentType   string
	credKind    string
	credential  string
	err         error
}

func (m *mockCredentialSyncer) SyncCredential(_ context.Context, workspaceID, agentType, credKind, credential string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.called = true
	m.workspaceID = workspaceID
	m.agentType = agentType
	m.credKind = credKind
	m.credential = credential
	return m.err
}

func TestSyncCredentialOnStop_SkipsEnvInjection(t *testing.T) {
	t.Parallel()

	syncer := &mockCredentialSyncer{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			CredentialSyncer: syncer,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	// Default injection mode is "" (env), so sync should be skipped.
	snap := credSyncSnapshot{injectionMode: ""}
	host.syncCredentialOnStop(snap)

	syncer.mu.Lock()
	defer syncer.mu.Unlock()
	if syncer.called {
		t.Fatal("syncCredentialOnStop should not call syncer for env injection mode")
	}
}

func TestSyncCredentialOnStop_SkipsNilSyncer(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
			// CredentialSyncer is nil
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	// auth-file mode but nil syncer — should not panic.
	snap := credSyncSnapshot{
		injectionMode: "auth-file",
		authFilePath:  ".codex/auth.json",
		credKind:      "oauth-token",
		agentType:     "openai-codex",
	}
	host.syncCredentialOnStop(snap)
}

func TestSyncCredentialOnStop_SkipsNilContainerResolver(t *testing.T) {
	t.Parallel()

	syncer := &mockCredentialSyncer{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			CredentialSyncer: syncer,
			// ContainerResolver deliberately nil
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	snap := credSyncSnapshot{
		injectionMode: "auth-file",
		authFilePath:  ".codex/auth.json",
		credKind:      "oauth-token",
		agentType:     "openai-codex",
	}

	// Must not panic — should skip sync when ContainerResolver is nil.
	host.syncCredentialOnStop(snap)

	syncer.mu.Lock()
	defer syncer.mu.Unlock()
	if syncer.called {
		t.Fatal("syncCredentialOnStop should not call syncer when ContainerResolver is nil")
	}
}

func TestSyncCredentialOnStop_SkipsContainerResolverError(t *testing.T) {
	t.Parallel()

	syncer := &mockCredentialSyncer{}
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:        "test-session",
			WorkspaceID:      "test-workspace",
			CredentialSyncer: syncer,
			ContainerResolver: func() (string, error) {
				return "", fmt.Errorf("container not found")
			},
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	snap := credSyncSnapshot{
		injectionMode: "auth-file",
		authFilePath:  ".codex/auth.json",
		credKind:      "oauth-token",
		agentType:     "openai-codex",
	}

	host.syncCredentialOnStop(snap)

	syncer.mu.Lock()
	defer syncer.mu.Unlock()
	if syncer.called {
		t.Fatal("syncCredentialOnStop should not call syncer when container resolver fails")
	}
}

func TestCredentialMetadataTracking(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:   "test-session",
			WorkspaceID: "test-workspace",
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})

	// Verify initial state — no credential metadata.
	if host.credInjectionMode != "" {
		t.Fatalf("expected empty credInjectionMode, got %q", host.credInjectionMode)
	}
	if host.credAuthFilePath != "" {
		t.Fatalf("expected empty credAuthFilePath, got %q", host.credAuthFilePath)
	}
	if host.credKind != "" {
		t.Fatalf("expected empty credKind, got %q", host.credKind)
	}

	host.Stop()
}

func newProxyCredentialTestHost(t *testing.T, callbackToken string) *SessionHost {
	t.Helper()
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			WorkspaceID:   "test-workspace",
			CallbackToken: callbackToken,
		},
	})
	t.Cleanup(host.Stop)
	return host
}

func proxyCredentialForTest(credential, provider, baseURL, model, apiKeySource string) *agentCredential {
	return &agentCredential{
		credential: credential,
		inferenceConfig: &inferenceConfig{
			Provider:     provider,
			BaseURL:      baseURL,
			Model:        model,
			APIKeySource: apiKeySource,
		},
	}
}

func injectProxyCredentialForTest(
	t *testing.T,
	host *SessionHost,
	agentType string,
	cred *agentCredential,
) ([]string, *agentSettingsPayload) {
	t.Helper()
	envVars, settings, err := host.injectAgentCredential(
		context.Background(),
		"container-id",
		agentType,
		cred,
		nil,
		getAgentCommandInfo(agentType, "api-key"),
		nil,
	)
	if err != nil {
		t.Fatalf("injectAgentCredential returned error: %v", err)
	}
	return envVars, settings
}

func injectProxyCredentialErrForTest(
	t *testing.T,
	host *SessionHost,
	agentType string,
	cred *agentCredential,
) error {
	t.Helper()
	_, _, err := host.injectAgentCredential(
		context.Background(),
		"container-id",
		agentType,
		cred,
		nil,
		getAgentCommandInfo(agentType, "api-key"),
		nil,
	)
	return err
}

func TestInjectAgentCredential_UserPassthroughProxy(t *testing.T) {
	t.Parallel()

	host := newProxyCredentialTestHost(t, "workspace-token")
	cred := proxyCredentialForTest(
		"sk-user",
		"anthropic-passthrough",
		"https://api.example.com/ai/{wstoken}/v1",
		"claude-sonnet",
		"user-credential",
	)
	envVars, settings := injectProxyCredentialForTest(t, host, "claude-code", cred)
	if settings != nil {
		t.Fatalf("settings = %#v, want nil", settings)
	}
	assertEnvEntry(t, envVars, "ANTHROPIC_BASE_URL=https://api.example.com/ai/workspace-token/v1")
	assertEnvEntry(t, envVars, "ANTHROPIC_API_KEY=sk-user")
	assertEnvEntry(t, envVars, "ANTHROPIC_MODEL=claude-sonnet")
}

func TestInjectAgentCredential_CallbackTokenPassthroughProxyReplacesWorkspaceToken(t *testing.T) {
	t.Parallel()

	host := newProxyCredentialTestHost(t, "workspace-token")
	cred := proxyCredentialForTest(
		"__sam_proxy__",
		"openai-passthrough",
		"https://api.example.com/ai/proxy/{wstoken}/openai/v1",
		"gpt-4.1",
		"callback-token",
	)
	envVars, settings := injectProxyCredentialForTest(t, host, "openai-codex", cred)
	if settings != nil {
		t.Fatalf("settings = %#v, want nil", settings)
	}
	assertEnvEntry(t, envVars, "OPENAI_BASE_URL=https://api.example.com/ai/proxy/workspace-token/openai/v1")
	assertEnvEntry(t, envVars, "OPENAI_API_KEY=workspace-token")
	assertEnvEntry(t, envVars, "OPENAI_MODEL=gpt-4.1")
	for _, entry := range envVars {
		if strings.Contains(entry, "{wstoken}") {
			t.Fatalf("env var still contains placeholder: %q", entry)
		}
		if strings.Contains(entry, "__sam_proxy__") {
			t.Fatalf("env var leaked proxy sentinel as credential: %q", entry)
		}
	}
}

func TestInjectAgentCredential_ProxyRequiresCallbackToken(t *testing.T) {
	t.Parallel()

	host := newProxyCredentialTestHost(t, "")
	cred := proxyCredentialForTest(
		"sk-user",
		"openai-passthrough",
		"https://api.example.com/ai/{wstoken}/v1",
		"",
		"user-credential",
	)
	err := injectProxyCredentialErrForTest(t, host, "openai-codex", cred)
	if err == nil {
		t.Fatal("injectAgentCredential returned nil error, want missing CallbackToken error")
	}
	if !strings.Contains(err.Error(), "CallbackToken is empty") {
		t.Fatalf("error = %q, want CallbackToken message", err.Error())
	}
}

func TestInjectAgentCredential_OpencodeRejectsInferenceProxy(t *testing.T) {
	t.Parallel()

	// OpenCode has no proxy descriptor, so any non-nil inferenceConfig (platform
	// or passthrough proxy) must be a hard error rather than silently degrading
	// to a plain env-var injection. CallbackToken is set so the failure is the
	// "not supported" descriptor error, not the missing-token error.
	host := newProxyCredentialTestHost(t, "workspace-token")
	cred := proxyCredentialForTest(
		"sk-user",
		"opencode-zen",
		"",
		"opencode/claude-sonnet-4-6",
		"callback-token",
	)
	err := injectProxyCredentialErrForTest(t, host, "opencode", cred)
	if err == nil {
		t.Fatal("injectAgentCredential returned nil error, want unsupported-proxy error")
	}
	if !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("error = %q, want not-supported message", err.Error())
	}
	if !strings.Contains(err.Error(), "opencode") {
		t.Fatalf("error = %q, want agent name in message", err.Error())
	}
}

func TestCodexRefreshProxyEnv(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			WorkspaceID:     "test-workspace",
			SessionID:       "test-session",
			ControlPlaneURL: "https://api.example.com/",
			CallbackToken:   "token with spaces",
		},
		MessageBufferSize: 100,
	})
	defer host.Stop()

	envVar, ok := host.codexRefreshProxyEnv("openai-codex", &agentCredential{credentialKind: "oauth-token"})
	if !ok {
		t.Fatal("codexRefreshProxyEnv ok = false, want true")
	}
	want := "CODEX_REFRESH_TOKEN_URL_OVERRIDE=https://api.example.com/api/auth/codex-refresh?token=token+with+spaces"
	if envVar != want {
		t.Fatalf("envVar = %q, want %q", envVar, want)
	}
}

func assertEnvEntry(t *testing.T, envVars []string, want string) {
	t.Helper()
	for _, got := range envVars {
		if got == want {
			return
		}
	}
	t.Fatalf("env vars missing %q: %#v", want, envVars)
}

func TestSessionHost_SelectAgent_SkipsRestartWhenSameAgentRunning(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	// Simulate an agent that is already running with status Ready.
	host.mu.Lock()
	host.agentType = "mistral-vibe"
	host.status = HostReady
	host.process = &AgentProcess{agentType: "mistral-vibe"} // stub process
	host.mu.Unlock()

	// Call SelectAgent with the SAME agent type. This simulates the browser's
	// auto-select sending select_agent("mistral-vibe") while the task-driven
	// agent is already running. The call should be a no-op.
	host.SelectAgent(context.Background(), "mistral-vibe")

	// The process should NOT have been replaced or stopped.
	host.mu.RLock()
	status := host.status
	agentType := host.agentType
	hasProcess := host.process != nil
	host.mu.RUnlock()

	if status != HostReady {
		t.Fatalf("status = %s, want %s (agent should not have been restarted)", status, HostReady)
	}
	if agentType != "mistral-vibe" {
		t.Fatalf("agentType = %s, want mistral-vibe", agentType)
	}
	if !hasProcess {
		t.Fatal("process is nil, should still be set (not stopped)")
	}

	// Clean up stub process before Stop() tries to call process.Stop().
	host.mu.Lock()
	host.process = nil
	host.mu.Unlock()
	host.Stop()
}

func TestSessionHost_SelectAgent_SkipsRestartWhenSameAgentStarting(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)

	// Simulate an agent that is starting (HostStarting with process set).
	host.mu.Lock()
	host.agentType = "mistral-vibe"
	host.status = HostStarting
	host.process = &AgentProcess{agentType: "mistral-vibe"}
	host.mu.Unlock()

	host.SelectAgent(context.Background(), "mistral-vibe")

	host.mu.RLock()
	status := host.status
	hasProcess := host.process != nil
	host.mu.RUnlock()

	if status != HostStarting {
		t.Fatalf("status = %s, want %s (should not change during starting)", status, HostStarting)
	}
	if !hasProcess {
		t.Fatal("process is nil, should still be set")
	}

	// Clean up stub process before Stop().
	host.mu.Lock()
	host.process = nil
	host.mu.Unlock()
	host.Stop()
}

func TestSessionHost_SelectAgent_AllowsSwitchToDifferentAgent(t *testing.T) {
	t.Parallel()

	// This test verifies that SelectAgent DOES proceed when the agent type
	// is different, even if an agent is currently running. We can only verify
	// the early part since we don't have a real container for startAgent.
	host := newTestSessionHost(t)

	host.mu.Lock()
	host.agentType = "claude-code"
	host.status = HostReady
	host.process = &AgentProcess{agentType: "claude-code", stopped: true} // pre-mark stopped to avoid nil deref
	host.mu.Unlock()

	// SelectAgent with a DIFFERENT agent type. It will proceed (and eventually
	// fail because there's no real container), but the important thing is that
	// it does NOT return early — it should change status to HostStarting.
	host.SelectAgent(context.Background(), "mistral-vibe")

	// After SelectAgent tries and fails (no container), status should be error,
	// NOT still HostReady (which would mean the early-return fired incorrectly).
	host.mu.RLock()
	status := host.status
	agentType := host.agentType
	host.mu.RUnlock()

	if status == HostReady && agentType == "claude-code" {
		t.Fatal("SelectAgent returned early for different agent type — should have proceeded")
	}

	host.Stop()
}

func TestSessionHost_RestoreAgentRequiresPreviousACPContext(t *testing.T) {
	t.Parallel()

	host := newTestSessionHost(t)
	defer host.Stop()

	err := host.RestoreAgent(context.Background(), "openai-codex")
	if err == nil {
		t.Fatal("RestoreAgent returned nil error without previous ACP context")
	}
	if !strings.Contains(err.Error(), "previous ACP session") {
		t.Fatalf("error = %q, want missing previous ACP session", err.Error())
	}
}

func TestFindModelConfigOptionID(t *testing.T) {
	t.Parallel()

	modelCategory := acpsdk.SessionConfigOptionCategoryModel
	modeCategory := acpsdk.SessionConfigOptionCategoryMode

	tests := []struct {
		name    string
		options []acpsdk.SessionConfigOption
		want    acpsdk.SessionConfigId
		wantOK  bool
	}{
		{
			name: "finds model select option",
			options: []acpsdk.SessionConfigOption{
				{Select: &acpsdk.SessionConfigOptionSelect{Id: "mode", Category: &modeCategory}},
				{Select: &acpsdk.SessionConfigOptionSelect{Id: "model", Category: &modelCategory}},
			},
			want:   "model",
			wantOK: true,
		},
		{
			name: "ignores uncategorized select option",
			options: []acpsdk.SessionConfigOption{
				{Select: &acpsdk.SessionConfigOptionSelect{Id: "model"}},
			},
			wantOK: false,
		},
		{
			name: "ignores boolean model option",
			options: []acpsdk.SessionConfigOption{
				{Boolean: &acpsdk.SessionConfigOptionBoolean{Id: "model", Category: &modelCategory}},
			},
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, ok := findModelConfigOptionID(tt.options)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if got != tt.want {
				t.Fatalf("id = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestInjectAgentCredential_OpenCodeProviderEnvVarOverrides(t *testing.T) {
	t.Parallel()

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{WorkspaceID: "test-workspace"},
	})
	defer host.Stop()

	tests := []struct {
		name     string
		provider string
		wantEnv  string
	}{
		{name: "default uses opencode env", provider: "", wantEnv: "OPENCODE_API_KEY=sk-test"},
		{name: "zen uses opencode env", provider: "opencode-zen", wantEnv: "OPENCODE_API_KEY=sk-test"},
		{name: "go uses opencode env", provider: "opencode-go", wantEnv: "OPENCODE_API_KEY=sk-test"},
		{name: "custom uses opencode env", provider: "custom", wantEnv: "OPENCODE_API_KEY=sk-test"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			envVars, settings, err := host.injectAgentCredential(
				context.Background(),
				"container-id",
				"opencode",
				&agentCredential{credential: "sk-test"},
				&agentSettingsPayload{OpencodeProvider: tt.provider},
				getAgentCommandInfo("opencode", "api-key"),
				nil,
			)
			if err != nil {
				t.Fatalf("injectAgentCredential returned error: %v", err)
			}
			if settings == nil || settings.OpencodeProvider != tt.provider {
				t.Fatalf("settings provider = %#v, want %q", settings, tt.provider)
			}
			assertEnvEntry(t, envVars, tt.wantEnv)
		})
	}
}
