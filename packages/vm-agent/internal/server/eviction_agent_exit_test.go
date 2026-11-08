package server

// Production 2026-11-08 (14 sessions, 3 stranded): the eviction's `docker stop` killed the
// docker-exec'd agent ~100ms before the stop returned. The production SessionHost treated
// the disconnect as a crash, retried one second later, found no devcontainer and posted a
// terminal `failed` task callback, racing the eviction that would have resumed the work.
//
// These tests run a real ACP agent subprocess under the production SessionHost and task
// completion callback, and let the real eviction stop path kill it: the fake `docker
// stop` SIGKILLs the agent, marks the container gone, and returns 100ms later.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

// Compiled only into Go test binaries: an ACP agent whose prompt never finishes. It
// records its PID so the fake `docker stop` can kill it like a container teardown.
func TestEvictionACPFixtureProcess(t *testing.T) {
	pidFile := os.Getenv("SAM_TEST_EVICTION_ACP_PID_FILE")
	if pidFile == "" {
		return
	}
	if os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0600) != nil {
		os.Exit(2)
	}
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := decoder.Decode(&request); err != nil {
			if err == io.EOF {
				os.Exit(0)
			}
			os.Exit(2)
		}
		if len(request.ID) == 0 {
			continue
		}
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "initialize":
			response["result"] = map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}}
		case "session/new":
			response["result"] = map[string]any{"sessionId": "fixture-evicted-session"}
		case "session/prompt":
			_ = os.WriteFile(pidFile+".prompting", nil, 0600)
			continue // Working until the container is stopped underneath it.
		default:
			response["result"] = map[string]any{}
		}
		if encoder.Encode(response) != nil {
			os.Exit(2)
		}
	}
}

// evictionFixtureLauncher starts the fixture agent until the container is gone, then
// fails exactly as the devcontainer launcher does once `docker stop` has run.
type evictionFixtureLauncher struct {
	pidFile  string
	goneFile string
	starts   *atomic.Int32
}

func (l evictionFixtureLauncher) Start(cfg acp.ProcessConfig) (*acp.AgentProcess, error) {
	l.starts.Add(1)
	if _, err := os.Stat(l.goneFile); err == nil {
		return nil, errors.New("failed to discover devcontainer: no running devcontainer found (label: devcontainer.local_folder=/workspace/repo)")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cfg.AcpCommand = executable
	cfg.AcpArgs = []string{"-test.run=^TestEvictionACPFixtureProcess$"}
	cfg.EnvVars = append(cfg.EnvVars, "SAM_TEST_EVICTION_ACP_PID_FILE="+l.pidFile)
	return (acp.LocalLauncher{}).Start(cfg)
}

type evictionAgentFixture struct {
	server         *Server
	host           *acp.SessionHost
	launcher       evictionFixtureLauncher
	taskCallbacks  chan map[string]any
	evictCallbacks chan map[string]any
}

// startEvictionAgentFixture runs a production SessionHost with a prompt in flight on a
// workspace the eviction test server can evict, wired to a recording control plane.
func startEvictionAgentFixture(t *testing.T) *evictionAgentFixture {
	t.Helper()
	bin := t.TempDir()
	installACPAdapterFixtureShims(t, bin)
	f := &evictionAgentFixture{
		launcher: evictionFixtureLauncher{pidFile: filepath.Join(bin, "agent.pid"),
			goneFile: filepath.Join(bin, "container-gone"), starts: new(atomic.Int32)},
		taskCallbacks:  make(chan map[string]any, 8),
		evictCallbacks: make(chan map[string]any, 4),
	}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		record := func(into chan map[string]any) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			into <- body
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/agent-key"):
			json.NewEncoder(w).Encode(map[string]any{"apiKey": "test-only", "credentialKind": "api-key", "credentialSource": "user",
				"credentialReference": "cc_credentials:provider-1", "credentialGeneration": 1, "credentialProvider": "anthropic", "providerMode": "direct"})
		case strings.HasSuffix(r.URL.Path, "/runtime-assets"):
			json.NewEncoder(w).Encode(map[string]any{"workspaceId": "workspace-1", "envVars": []any{}, "files": []any{}})
		case strings.HasSuffix(r.URL.Path, "/status/callback"):
			record(f.taskCallbacks)
			io.WriteString(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/eviction"):
			record(f.evictCallbacks)
			w.WriteHeader(http.StatusNoContent)
		default:
			io.WriteString(w, `{}`)
		}
	}))
	t.Cleanup(control.Close)

	s := newEvictionTestServer()
	initializeEvictionTestStore(t, s)
	s.config.ControlPlaneURL = control.URL
	s.acpConfig = acp.GatewayConfig{ControlPlaneURL: control.URL, CallbackToken: "test-token", NodeID: "node-1",
		ProcessLauncher: f.launcher, ContainerWorkDir: bin, SettingsResolved: true,
		TerminalActivityReportAttempts: 1, ActivityReportTimeout: time.Second}
	session, _, err := s.agentSessions.Create("workspace-1", "agent-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	const key = "workspace-1:agent-1"
	s.sessionTaskCtx[key] = taskCallbackContext{ProjectID: "project-1", TaskID: "task-1", WorkspaceID: "workspace-1",
		TaskMode: config.TaskModeConversation}
	// The agent runs as a local process (ProcessLauncher), as in the provider-limit
	// fixture; container mode stays on for the eviction path the test drives.
	s.config.ContainerMode = false
	host := s.getOrCreateSessionHost(key, "workspace-1", "agent-1", session, &WorkspaceRuntime{ID: "workspace-1"}, "")
	s.config.ContainerMode = true
	if host == nil {
		t.Fatal("no session host")
	}
	t.Cleanup(host.Stop)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	host.SelectAgent(ctx, "claude-code")
	if host.Status() != acp.HostReady {
		t.Fatalf("fixture agent did not initialize: %s", host.Status())
	}
	params := json.RawMessage(`{"sessionId":"fixture-evicted-session","prompt":[{"type":"text","text":"long-running work"}]}`)
	// The prompt outlives this setup function, so it must not take the setup context.
	accepted, ok := host.AcceptPrompt(context.Background(), json.RawMessage(`1`), params, "fixture-viewer", true, "", nil)
	if !ok {
		t.Fatal("fixture prompt was not accepted")
	}
	go accepted.Run()
	waitForFile(t, f.launcher.pidFile+".prompting")
	f.server, f.host = s, host
	return f
}

// killAgentWithContainer is the container teardown: SIGKILL the agent, then the
// devcontainer is gone for any later restart.
func (f *evictionAgentFixture) killAgentWithContainer(t *testing.T) {
	t.Helper()
	raw, err := os.ReadFile(f.launcher.pidFile)
	if err != nil {
		t.Error(err)
		return
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		t.Error(err)
		return
	}
	if err := os.WriteFile(f.launcher.goneFile, nil, 0600); err != nil {
		t.Error(err)
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Error(err)
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func expectNoTaskCallback(t *testing.T, callbacks chan map[string]any, wait time.Duration, during string) {
	t.Helper()
	select {
	case body := <-callbacks:
		t.Fatalf("%s: task status posted for an evicted prompt: %v", during, body)
	case <-time.After(wait):
	}
}

func TestEvictionStopKillingTheAgentDoesNotFailTheTask(t *testing.T) {
	f := startEvictionAgentFixture(t)
	setupEvictionDocker(t, evictionTestContainerID)
	dir := t.TempDir()
	started, release := filepath.Join(dir, "stop-started"), filepath.Join(dir, "stop-release")
	t.Setenv("SAM_EVICTION_TEST_STOP_STARTED", started)
	t.Setenv("SAM_EVICTION_TEST_STOP_RELEASE", release)
	go func() {
		// Measured locally (Docker 29, devcontainer-style PID1): the exec'd agent exits
		// 137 ~40ms into `docker stop`, ~100ms before the stop returns.
		waitForFile(t, started)
		f.killAgentWithContainer(t)
		time.Sleep(100 * time.Millisecond)
		_ = os.WriteFile(release, nil, 0600)
	}()

	target := evictionTargetFixture(f.server)
	if err := f.server.stopEvictedWorkspaceContainer(context.Background(), target); err != nil {
		t.Fatalf("eviction stop: %v", err)
	}
	// The final capture runs here in production (15-75s). Outlast the 1s restart delay.
	expectNoTaskCallback(t, f.taskCallbacks, 2*time.Second, "between stop and record")
	if n := f.launcher.starts.Load(); n != 1 {
		t.Fatalf("agent launched %d times; an eviction-owned exit must not restart", n)
	}

	result := resourcemon.EvictionResult{Target: target, SnapshotCaptured: true, ContainerStopped: true,
		CompletedAt: time.Now().UTC()}
	if !f.server.markWorkspaceEvicted(result) {
		t.Fatal("eviction could not be recorded")
	}
	expectNoTaskCallback(t, f.taskCallbacks, 300*time.Millisecond, "after record")
	if f.host.Status() != acp.HostStopped {
		t.Fatalf("host status = %s, want stopped", f.host.Status())
	}
	if err := f.server.notifyWorkspaceEvicted(context.Background(), result); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-f.evictCallbacks:
		if body["interruptedWork"] != true || body["containerStopped"] != true {
			t.Fatalf("eviction callback = %v, want the in-flight prompt reported as interrupted work", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("eviction callback was not delivered")
	}
}

// Control on the same production host: a container lost without an eviction still
// produces the terminal verdict, so the test above can see a callback when one is sent.
func TestContainerLossWithoutEvictionStillFailsTheTask(t *testing.T) {
	f := startEvictionAgentFixture(t)
	f.killAgentWithContainer(t)
	select {
	case body := <-f.taskCallbacks:
		if body["toStatus"] != "failed" {
			t.Fatalf("callback = %v, want failed", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an unowned container loss posted no task verdict")
	}
}
