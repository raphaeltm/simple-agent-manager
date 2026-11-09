package acp

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// rotationProcessRecorder captures every agent process the host spawns and the
// environment it was started with.
type rotationProcessRecorder struct {
	mu        sync.Mutex
	processes []*fakeAgentProcess
	envs      [][]string
}

func (r *rotationProcessRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.processes)
}

func (r *rotationProcessRecorder) at(i int) (*fakeAgentProcess, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.processes[i], append([]string(nil), r.envs[i]...)
}

func envValue(env []string, name string) string {
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, name+"="); ok {
			return value
		}
	}
	return ""
}

// newCredentialRotationTestHost builds a restart-harness host on the platform AI
// proxy (apiKeySource=callback-token), so the workspace callback token is the
// agent's AI credential, with a sam-mcp server carrying initialMcpToken. Spawned
// processes report a start startedAgo in the past: a minute makes an exit
// non-rapid, so the crash counter is what distinguishes an intentional restart
// from a crash; zero makes it a rapid exit, which a crash turns into HostError.
func newCredentialRotationTestHost(t *testing.T, initialMcpToken string, startedAgo time.Duration) (*SessionHost, *restartControlPlane, *fakeACPServer, *rotationProcessRecorder) {
	t.Helper()
	installFakeAgentBinary(t, "claude-agent-acp")
	cp := newRestartControlPlane(t)
	cp.agentKeyBody = `{"apiKey":"","credentialKind":"api-key","inferenceConfig":{"provider":"anthropic-proxy","baseURL":"https://ai.example.test/{wstoken}/v1","apiKeySource":"callback-token"}}`
	acpServer := newFakeACPServer(true, false)
	acpServer.loadSessionParams = make(chan json.RawMessage, 8)
	host := newRestartTestHost(t, cp, acpServer, &restartContextProbe{})
	host.config.McpServers = []McpServerEntry{{URL: "https://api.example.test/mcp", Token: initialMcpToken, Name: SamMcpServerName}}
	recorder := &rotationProcessRecorder{}
	host.config.StartProcess = func(startup *agentStartup) (agentProcess, error) {
		proc, reader, writer := newFakeAgentProcess(time.Now().Add(-startedAgo), true)
		acpServer.serve(reader, writer)
		recorder.mu.Lock()
		recorder.processes = append(recorder.processes, proc)
		recorder.envs = append(recorder.envs, append([]string(nil), startup.envVars...))
		recorder.mu.Unlock()
		return proc, nil
	}
	return host, cp, acpServer, recorder
}

func nextLoadSessionParams(t *testing.T, acpServer *fakeACPServer) string {
	t.Helper()
	select {
	case params := <-acpServer.loadSessionParams:
		return string(params)
	case <-time.After(5 * time.Second):
		t.Fatal("no LoadSession request recorded")
		return ""
	}
}

// A workspace credential rotation (restart/rebuild delivering a new callback
// generation) must replace the running agent process WITHOUT stopping the host
// and WITHOUT counting a crash, and the replacement must start with the host's
// CURRENT callback token and MCP servers. The control plane revoked the old
// generation, so a replacement started from construction-time credentials would
// be as dead as the process it replaced. Entered through the production start
// path (RestoreAgent) and the production restart trigger (the exported method).
func TestSessionHost_RestartAgentProcessForCredentialRotation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		startedAgo time.Duration
	}{
		{name: "long-running agent", startedAgo: time.Minute},
		{name: "agent started moments ago (rapid exit)", startedAgo: 0},
	} {
		t.Run(tc.name, func(t *testing.T) { testRestartAgentProcessForCredentialRotation(t, tc.startedAgo) })
	}
}

func testRestartAgentProcessForCredentialRotation(t *testing.T, startedAgo time.Duration) {
	host, cp, acpServer, recorder := newCredentialRotationTestHost(t, "mcp-gen-a", startedAgo)
	defer host.Stop()

	startAgentThroughDoomedRequest(t, host, true)
	if recorder.count() != 1 {
		t.Fatalf("agent processes after start = %d, want 1", recorder.count())
	}
	firstProcess, firstEnv := recorder.at(0)
	if got := envValue(firstEnv, "ANTHROPIC_AUTH_TOKEN"); got != "test-token" {
		t.Fatalf("setup: initial AI proxy credential = %q, want the construction-time callback token", got)
	}
	if params := nextLoadSessionParams(t, acpServer); !strings.Contains(params, "Bearer mcp-gen-a") {
		t.Fatalf("setup: initial LoadSession MCP servers = %s, want the generation-A sam-mcp token", params)
	}
	<-acpServer.loadSessionIDs // drain the initial LoadSession id

	// The server installs generation B before restarting: the callback token
	// during the restart claim, the sam-mcp token after rotation.
	host.SetCallbackToken("callback-gen-b")
	host.SetMcpServers([]McpServerEntry{{URL: "https://api.example.test/mcp", Token: "mcp-gen-b", Name: SamMcpServerName}})

	if !host.RestartAgentProcessForCredentialRotation() {
		t.Fatal("RestartAgentProcessForCredentialRotation reported no running process")
	}

	// (a) the generation-A process is terminated.
	if firstProcess.stopCount.Load() == 0 {
		t.Fatal("the generation-A agent process was not stopped")
	}
	// (b) the monitor restarts it in place.
	waitFor(t, 8*time.Second, func() bool { return recorder.count() >= 2 })
	waitFor(t, 8*time.Second, func() bool { return host.Status() == HostReady && cp.count("idle") >= 1 })

	host.mu.RLock()
	restartCount := host.restartCount
	intentional := host.intentionalProcessStop != nil
	sessionID := string(host.sessionID)
	host.mu.RUnlock()
	if restartCount != 0 {
		t.Fatalf("restartCount = %d, want 0: a credential rotation is not a crash", restartCount)
	}
	if intentional {
		t.Fatal("intentionalProcessStop still set after the monitor consumed it")
	}
	if got := cp.count("error"); got != 0 {
		t.Fatalf("activities = %v, want no error report for a credential-rotation restart", cp.activities())
	}
	if idle, ok := cp.lastWith("idle"); !ok || idle.RestartCount != 0 {
		t.Fatalf("idle report restartCount = %d, want 0", idle.RestartCount)
	}
	if sessionID != "acp-session-1" {
		t.Fatalf("resumed sessionID = %q, want acp-session-1 (same conversation)", sessionID)
	}
	if got := acpServer.newSessionCalls.Load(); got != 0 {
		t.Fatalf("NewSession calls = %d, want 0: the restart must resume, not fork", got)
	}
	select {
	case id := <-acpServer.loadSessionIDs:
		if id != "acp-session-1" {
			t.Fatalf("restart LoadSession target = %q, want acp-session-1", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the restart did not LoadSession")
	}

	// (c) the replacement starts with generation-B credentials.
	_, restartedEnv := recorder.at(1)
	if got := envValue(restartedEnv, "ANTHROPIC_AUTH_TOKEN"); got != "callback-gen-b" {
		t.Fatalf("restarted AI proxy credential = %q, want the rotated callback token", got)
	}
	if got := envValue(restartedEnv, "ANTHROPIC_BASE_URL"); got != "https://ai.example.test/callback-gen-b/v1" {
		t.Fatalf("restarted AI proxy base URL = %q, want it built from the rotated callback token", got)
	}
	params := nextLoadSessionParams(t, acpServer)
	if !strings.Contains(params, "Bearer mcp-gen-b") || strings.Contains(params, "mcp-gen-a") {
		t.Fatalf("restart LoadSession MCP servers = %s, want only the rotated sam-mcp token", params)
	}
}

// (d) With no running agent process the method does nothing: an idle host's
// next agent start already reads the current credentials, and a stopped host
// must stay stopped.
func TestSessionHost_RestartAgentProcessForCredentialRotationNoProcess(t *testing.T) {
	t.Run("never started", func(t *testing.T) {
		host, cp, _, recorder := newCredentialRotationTestHost(t, "mcp-gen-a", time.Minute)
		defer host.Stop()
		before := host.Status()
		if host.RestartAgentProcessForCredentialRotation() {
			t.Fatal("reported a running process on a host that never started one")
		}
		time.Sleep(1500 * time.Millisecond) // longer than the monitor's restart delay
		if recorder.count() != 0 || host.Status() != before {
			t.Fatalf("idle host spawned %d process(es) or changed status %s -> %s", recorder.count(), before, host.Status())
		}
		host.mu.RLock()
		intentional := host.intentionalProcessStop != nil
		host.mu.RUnlock()
		if intentional {
			t.Fatal("intentionalProcessStop latched with no process; a later real crash would be hidden")
		}
		if len(cp.activities()) != 0 {
			t.Fatalf("activities = %v, want none", cp.activities())
		}
	})
	t.Run("stopped", func(t *testing.T) {
		host, _, _, recorder := newCredentialRotationTestHost(t, "mcp-gen-a", time.Minute)
		startAgentThroughDoomedRequest(t, host, true)
		host.Stop()
		if host.RestartAgentProcessForCredentialRotation() {
			t.Fatal("reported a running process on a stopped host")
		}
		time.Sleep(1500 * time.Millisecond)
		if recorder.count() != 1 || host.Status() != HostStopped {
			t.Fatalf("stopped host spawned a replacement (processes=%d) or left HostStopped (%s)", recorder.count(), host.Status())
		}
	})
}

// A credential rotation that lands after the agent process already exited on its
// own must not relabel that crash as an intentional stop: the crash still
// spends the restart budget, so a crash-looping agent cannot slip past
// MaxRestartAttempts because rotations keep coinciding with its exits. The
// mark is read when Wait returns and names the process it was set for.
func TestSessionHost_IntentionalStopMarkMustPredateTheExit(t *testing.T) {
	t.Parallel()

	newHost := func(t *testing.T, process agentProcess) *SessionHost {
		t.Helper()
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
		t.Cleanup(host.Stop)
		host.mu.Lock()
		host.process = process
		host.setStatusLocked(HostReady)
		host.agentType = "claude-code"
		host.setSessionIDLocked("acp-session-1")
		host.restartCount = 1 // the next counted crash exceeds the budget
		host.mu.Unlock()
		return host
	}
	restartOutcome := func(host *SessionHost) (int, string) {
		host.mu.RLock()
		defer host.mu.RUnlock()
		return host.restartCount, host.statusErr
	}

	t.Run("rotation requested after the exit counts the crash", func(t *testing.T) {
		process := newExitedAgentProcess(t, "claude-code")
		host := newHost(t, process)
		rotated := false
		host.processExitObservedHook = func(exited agentProcess) {
			// The process has exited but is still the host's current process,
			// exactly the window a rotation can land in.
			rotated = host.RestartAgentProcessForCredentialRotation()
		}
		host.monitorProcessExit(process, "claude-code", nil, nil)

		if !rotated {
			t.Fatal("setup: the rotation did not see a running process in the exit window")
		}
		restartCount, statusErr := restartOutcome(host)
		if restartCount != 2 || !strings.Contains(statusErr, "could not be restarted") {
			t.Fatalf("restartCount=%d statusErr=%q, want the crash counted against the exhausted budget", restartCount, statusErr)
		}
	})

	t.Run("rotation requested before the exit is intentional", func(t *testing.T) {
		process := newExitedAgentProcess(t, "claude-code")
		host := newHost(t, process)
		if !host.RestartAgentProcessForCredentialRotation() {
			t.Fatal("setup: the rotation saw no running process")
		}
		host.monitorProcessExit(process, "claude-code", nil, nil)

		restartCount, statusErr := restartOutcome(host)
		if restartCount != 1 || strings.Contains(statusErr, "could not be restarted") {
			t.Fatalf("restartCount=%d statusErr=%q, want an uncounted in-place restart", restartCount, statusErr)
		}
		if !strings.Contains(statusErr, "container unavailable") {
			t.Fatalf("statusErr=%q, want the restart attempt to have run", statusErr)
		}
	})

	t.Run("a mark for an earlier process does not hide a later crash", func(t *testing.T) {
		earlier := newExitedAgentProcess(t, "claude-code")
		process := newExitedAgentProcess(t, "claude-code")
		host := newHost(t, process)
		host.mu.Lock()
		host.intentionalProcessStop = earlier
		host.mu.Unlock()
		host.monitorProcessExit(process, "claude-code", nil, nil)

		restartCount, statusErr := restartOutcome(host)
		if restartCount != 2 || !strings.Contains(statusErr, "could not be restarted") {
			t.Fatalf("restartCount=%d statusErr=%q, want the crash counted", restartCount, statusErr)
		}
	})
}
