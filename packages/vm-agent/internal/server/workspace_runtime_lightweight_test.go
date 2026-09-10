package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

// Regression coverage for the cf-container config-injection defect: every
// production caller of upsertWorkspaceRuntime that does NOT supply
// workspaceRuntimeOpts used to reset runtime.Lightweight to the zero value,
// because the bool was assigned unconditionally while every sibling field was
// guarded by a non-empty check.
//
// The flag reaches devcontainer provisioning and recovery
// (workspace_provisioning.go), so a lightweight workspace would rebuild as a
// full devcontainer. It also used to gate cf-container runtime-asset injection
// in agent_ws.go; that gate is now IsStandaloneMode() alone, which is the
// property it was really asking about.
//
// The pre-existing TestUpsertWorkspaceRuntimeSetsLightweightFlag only exercised
// the create branch on two distinct workspace IDs, so it could not observe this.
func TestUpsertWorkspaceRuntimeNoOptsPreservesLightweight(t *testing.T) {
	t.Parallel()

	// The five production no-opts call sites reduce to two distinct argument
	// shapes. Rows are keyed by shape rather than by site so no two cases are
	// byte-identical, but every site is named so a future site losing coverage
	// is visible in the diff.
	cases := []struct {
		name          string
		callSites     []string
		status        string
		callbackToken string
	}{
		{
			name: "status refresh on websocket connect",
			callSites: []string{
				"agent_ws.go:72 handleAgentWS",
				"websocket.go:196 handleTerminalWS",
				"websocket.go:337 handleMultiTerminalWS",
			},
			status: "running",
		},
		{
			name: "callback-token persist on restore",
			callSites: []string{
				"session_snapshot.go:145 handleRestoreAgentSession",
				"session_restore_retry.go:101 initializeStandaloneRestoreSession",
			},
			callbackToken: "ws-callback-token",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			t.Logf("covers production call sites: %v", tc.callSites)

			s := &Server{
				config:          &config.Config{WorkspaceDir: "/workspace"},
				workspaces:      map[string]*WorkspaceRuntime{},
				workspaceEvents: map[string][]EventRecord{},
			}

			// handleCreateWorkspace shape: the control plane sends lightweight=true
			// for every Instant (cf-container) workspace.
			created := s.upsertWorkspaceRuntime("WS_LIGHT", "octo/repo", "main", "creating", "create-token",
				workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})
			if !created.Lightweight {
				t.Fatal("precondition: expected Lightweight=true after create")
			}

			after := s.upsertWorkspaceRuntime("WS_LIGHT", "", "", tc.status, tc.callbackToken)
			if !after.Lightweight {
				t.Error("no-opts upsert cleared Lightweight")
			}

			// Liveness: the value this caller DID supply must have been applied, and
			// ProjectID must survive. The update branch only overwrites ProjectID on a
			// non-empty opt, so its survival also proves the runtime was mutated in
			// place rather than recreated (a recreate would reset it to "").
			if tc.callbackToken != "" && after.CallbackToken != tc.callbackToken {
				t.Errorf("expected callback token %q to be applied, got %q", tc.callbackToken, after.CallbackToken)
			}
			if tc.status != "" && after.Status != tc.status {
				t.Errorf("expected status %q to be applied, got %q", tc.status, after.Status)
			}
			if after.ProjectID != "proj-1" {
				t.Errorf("expected ProjectID to survive, got %q", after.ProjectID)
			}
		})
	}
}

// Discriminating control: the field must still be writable to its zero value on
// purpose. Without this, "guard the assignment" could be satisfied by making
// Lightweight permanently unsettable once true.
func TestUpsertWorkspaceRuntimeExplicitOptClearsLightweight(t *testing.T) {
	t.Parallel()

	s := &Server{
		config:          &config.Config{WorkspaceDir: "/workspace"},
		workspaces:      map[string]*WorkspaceRuntime{},
		workspaceEvents: map[string][]EventRecord{},
	}

	s.upsertWorkspaceRuntime("WS_TOGGLE", "octo/repo", "main", "creating", "",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true)})

	cleared := s.upsertWorkspaceRuntime("WS_TOGGLE", "", "", "running", "",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(false)})
	if cleared.Lightweight {
		t.Fatal("explicit Lightweight=false override was ignored")
	}

	restored := s.upsertWorkspaceRuntime("WS_TOGGLE", "", "", "running", "",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true)})
	if !restored.Lightweight {
		t.Fatal("explicit Lightweight=true override was ignored")
	}
}

// Enters through the real production trigger: a browser dialling the agent
// WebSocket. handleAgentWS runs the no-opts upsert (line 72) and then builds the
// SessionHost (line ~386) within the same request, which is what made the
// original defect self-inflicted. Driving the handler rather than hand-feeding
// the upsert means a future refactor that moves or re-argues that call cannot
// leave this test passing against a shape production no longer uses.
func TestHandleAgentWSPreservesLightweightAndWiresRuntimeAssets(t *testing.T) {
	s, ts, cookieSessionID := newAgentWSTestServer(t)
	s.config.Role = config.RoleStandalone
	s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	s.sessionProfileOvr = map[string]profileOverrides{}
	s.sessionTaskCtx = map[string]taskCallbackContext{}

	// newAgentWSTestServer mints its auth cookie for workspace WS_TEST.
	const workspaceID = "WS_TEST"
	const sessionID = "sess-live-ws"

	s.upsertWorkspaceRuntime(workspaceID, "octo/repo", "main", "creating", "ws-token",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})

	conn := dialAgentWS(t, ts, cookieSessionID, workspaceID, sessionID)
	defer func() { _ = conn.Close() }()

	host := waitForSessionHost(t, s, workspaceID+":"+sessionID)

	// Discriminates the *bool fix: the real handler's upsert must not clear it.
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		t.Fatal("expected workspace runtime to exist after the WebSocket connect")
	}
	if !runtime.Lightweight {
		t.Error("real handleAgentWS trigger cleared Lightweight")
	}

	// Discriminates the gate fix: standalone sessions have no devcontainer to
	// read /etc/sam/project-env from, so a nil provider means the agent starts
	// with no project env vars at all.
	if !host.HasRuntimeAssetsProvider() {
		t.Error("standalone SessionHost has no runtime-assets provider: project env vars and runtime files will not reach the agent")
	}
}

// waitForSessionHost polls until handleAgentWS has registered the host. The
// handler blocks in gateway.Run once connected, so the host appears
// asynchronously with respect to the dial returning.
func waitForSessionHost(t *testing.T, s *Server, hostKey string) *acp.SessionHost {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.sessionHostMu.Lock()
		host, ok := s.sessionHosts[hostKey]
		s.sessionHostMu.Unlock()
		if ok && host != nil {
			return host
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("SessionHost %q was never registered", hostKey)
	return nil
}

// sessionHostForRole builds a SessionHost the way the production entry points do
// — create the workspace as the control plane does, run the no-opts upsert a
// WebSocket connect would run, then ask for the host with the runtime that
// upsert returned.
func sessionHostForRole(t *testing.T, role string, workspaceID, sessionID string, restore bool) *acp.SessionHost {
	t.Helper()

	s, _ := newServerWithoutReporter(t)
	s.config.Role = role
	s.config.ContainerMode = false
	s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	s.sessionProfileOvr = map[string]profileOverrides{}
	s.sessionTaskCtx = map[string]taskCallbackContext{}

	s.upsertWorkspaceRuntime(workspaceID, "octo/repo", "main", "creating", "ws-token",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})
	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	session, _, err := s.agentSessions.Create(workspaceID, sessionID, "", "")
	if err != nil {
		t.Fatalf("agentSessions.Create: %v", err)
	}

	hostKey := workspaceID + ":" + sessionID
	var host *acp.SessionHost
	if restore {
		host = s.getOrCreateSessionHostForRestore(hostKey, workspaceID, sessionID, session, runtime, "", true)
	} else {
		host = s.getOrCreateSessionHost(hostKey, workspaceID, sessionID, session, runtime, "")
	}
	if host == nil {
		t.Fatal("expected a SessionHost")
	}
	return host
}

// The provider must be wired for standalone and withheld for VM. The VM control
// is what stops "always wire it" from passing: VM sessions read project env from
// /etc/sam/project-env inside the devcontainer instead.
func TestSessionHostRuntimeAssetsProviderByRuntime(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		role         string
		wantProvider bool
	}{
		{name: "standalone cf-container", role: config.RoleStandalone, wantProvider: true},
		{name: "vm devcontainer", role: "", wantProvider: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			host := sessionHostForRole(t, tc.role, "WS_ROLE", "sess-role", false)
			if got := host.HasRuntimeAssetsProvider(); got != tc.wantProvider {
				t.Errorf("HasRuntimeAssetsProvider() = %v, want %v", got, tc.wantProvider)
			}
		})
	}
}

// Sleep/wake is the second production symptom. The restore path has its own
// SessionHost constructor, so proving the flag survives the restore upsert is
// not enough — the downstream consumer has to be checked on that path too.
func TestRestoreSessionHostKeepsRuntimeAssetsProvider(t *testing.T) {
	t.Parallel()

	host := sessionHostForRole(t, config.RoleStandalone, "WS_RESTORE", "sess-restore", true)
	if !host.HasRuntimeAssetsProvider() {
		t.Error("restored standalone SessionHost has no runtime-assets provider")
	}
}

// The second consequence of the same root cause: recoverWorkspaceRuntime
// forwards runtime.Lightweight into ProvisionState, so a cleared flag makes a
// lightweight workspace rebuild as a full devcontainer. Asserting only that
// runtime.Lightweight survives would be the "flag test alone" that
// .claude/rules/73 warns is insufficient.
func TestRecoverWorkspaceRuntimeForwardsLightweightAfterWebsocketUpsert(t *testing.T) {
	originalPrepare := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = originalPrepare }()

	var capturedState bootstrap.ProvisionState
	var called bool
	prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, state bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
		capturedState = state
		called = true
		return false, nil
	}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/workspaces/WS_RECOVER/runtime-assets" {
			_, _ = w.Write([]byte(`{"workspaceId":"WS_RECOVER","envVars":[],"files":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ContainerMode:   true,
			WorkspaceDir:    "/workspace",
			CallbackToken:   "node-callback-token",
			ControlPlaneURL: controlPlane.URL,
		},
		workspaces:      map[string]*WorkspaceRuntime{},
		workspaceEvents: map[string][]EventRecord{},
	}

	s.upsertWorkspaceRuntime("WS_RECOVER", "octo/repo", "main", "creating", "workspace-callback-token",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})
	// websocket.go:224 and agent_ws.go:364 both call recoverWorkspaceRuntime with
	// the runtime returned by the no-opts upsert earlier in the same handler.
	runtime := s.upsertWorkspaceRuntime("WS_RECOVER", "", "", "running", "")

	if err := s.recoverWorkspaceRuntime(context.Background(), runtime); err != nil {
		t.Fatalf("recoverWorkspaceRuntime() error = %v", err)
	}
	if !called {
		t.Fatal("expected prepareWorkspaceForRuntime to be called")
	}
	if !capturedState.Lightweight {
		t.Error("recovery would rebuild a lightweight workspace as a full devcontainer")
	}
}
