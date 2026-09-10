package server

import (
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
)

// Regression coverage for the cf-container config-injection defect: every
// production caller of upsertWorkspaceRuntime that does NOT supply
// workspaceRuntimeOpts used to reset runtime.Lightweight to the zero value,
// because the bool was assigned unconditionally while every sibling field was
// guarded by a non-empty check.
//
// The flag is load-bearing twice over:
//   - agent_ws.go gates cf-container runtime-asset injection on it, and clears
//     it earlier in the SAME request (handleAgentWS line 72 vs line 386);
//   - workspace_provisioning.go passes it to devcontainer recovery, so a
//     lightweight VM workspace would rebuild as a full devcontainer.
//
// The pre-existing TestUpsertWorkspaceRuntimeSetsLightweightFlag only exercised
// the create branch on two distinct workspace IDs, so it could not observe this.
func TestUpsertWorkspaceRuntimeNoOptsPreservesLightweight(t *testing.T) {
	t.Parallel()

	// Each case mirrors a real production call site that passes no opts.
	cases := []struct {
		name   string
		upsert func(s *Server, workspaceID string) *WorkspaceRuntime
	}{
		{
			name: "handleAgentWS browser connect",
			upsert: func(s *Server, id string) *WorkspaceRuntime {
				return s.upsertWorkspaceRuntime(id, "", "", "running", "")
			},
		},
		{
			name: "terminal websocket connect",
			upsert: func(s *Server, id string) *WorkspaceRuntime {
				return s.upsertWorkspaceRuntime(id, "", "", "running", "")
			},
		},
		{
			name: "snapshot restore persists workspace callback token",
			upsert: func(s *Server, id string) *WorkspaceRuntime {
				return s.upsertWorkspaceRuntime(id, "", "", "", "ws-callback-token")
			},
		},
		{
			name: "session restore retry replaces routing credentials",
			upsert: func(s *Server, id string) *WorkspaceRuntime {
				return s.upsertWorkspaceRuntime(id, "", "", "", "retry-callback-token")
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

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

			after := tc.upsert(s, "WS_LIGHT")
			if !after.Lightweight {
				t.Error("no-opts upsert cleared Lightweight")
			}

			// Unrelated fields the caller did supply must still be applied, so a
			// passing test cannot mean the upsert became a no-op.
			if tc.name == "snapshot restore persists workspace callback token" && after.CallbackToken != "ws-callback-token" {
				t.Errorf("expected callback token to be applied, got %q", after.CallbackToken)
			}
			if after.ProjectID != "proj-1" {
				t.Errorf("expected ProjectID to survive, got %q", after.ProjectID)
			}
		})
	}
}

// Discriminating control: the field must still be writable to false. Without
// this, "guard the assignment" could be satisfied by making Lightweight
// permanently unsettable once true.
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

// The claim that actually matters: after the browser's agent WebSocket has run
// its upsert, a SessionHost built for a standalone (cf-container) workspace must
// still be wired to fetch project/profile/skill runtime assets. A nil provider
// here is the production symptom — CF_TOKEN and every other project env var
// silently missing from the agent process.
func TestStandaloneSessionHostKeepsRuntimeAssetsAfterWebsocketUpsert(t *testing.T) {
	t.Parallel()

	s, _ := newServerWithoutReporter(t)
	s.config.Role = config.RoleStandalone
	s.config.ContainerMode = false
	s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	s.sessionProfileOvr = map[string]profileOverrides{}
	s.sessionTaskCtx = map[string]taskCallbackContext{}

	const workspaceID = "WS_STANDALONE"
	const sessionID = "sess-1"

	// createWorkspaceOnNode(..., lightweight: true) — instant-session.ts.
	s.upsertWorkspaceRuntime(workspaceID, "octo/repo", "main", "creating", "ws-token",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})

	// handleAgentWS line 72, before it reaches getOrCreateSessionHost at line 386.
	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	session, _, err := s.agentSessions.Create(workspaceID, sessionID, "", "")
	if err != nil {
		t.Fatalf("agentSessions.Create: %v", err)
	}

	host := s.getOrCreateSessionHost(workspaceID+":"+sessionID, workspaceID, sessionID, session, runtime, "")
	if host == nil {
		t.Fatal("expected a SessionHost")
	}
	if !host.HasRuntimeAssetsProvider() {
		t.Error("standalone SessionHost has no runtime-assets provider: project env vars and runtime files will not reach the agent")
	}
}

// Control for the test above: a non-standalone (VM) host must NOT get the
// provider — VM sessions read project env from /etc/sam/project-env inside the
// devcontainer instead. Without this, "always wire the provider" would pass.
func TestVmSessionHostHasNoRuntimeAssetsProvider(t *testing.T) {
	t.Parallel()

	s, _ := newServerWithoutReporter(t)
	s.config.Role = ""
	s.config.ContainerMode = false
	s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	s.sessionProfileOvr = map[string]profileOverrides{}
	s.sessionTaskCtx = map[string]taskCallbackContext{}

	const workspaceID = "WS_VM"
	const sessionID = "sess-vm"

	s.upsertWorkspaceRuntime(workspaceID, "octo/repo", "main", "creating", "ws-token",
		workspaceRuntimeOpts{Lightweight: lightweightOpt(true), ProjectID: "proj-1"})
	runtime := s.upsertWorkspaceRuntime(workspaceID, "", "", "running", "")

	session, _, err := s.agentSessions.Create(workspaceID, sessionID, "", "")
	if err != nil {
		t.Fatalf("agentSessions.Create: %v", err)
	}

	host := s.getOrCreateSessionHost(workspaceID+":"+sessionID, workspaceID, sessionID, session, runtime, "")
	if host == nil {
		t.Fatal("expected a SessionHost")
	}
	if host.HasRuntimeAssetsProvider() {
		t.Error("VM SessionHost should not use the standalone runtime-assets provider")
	}
}
