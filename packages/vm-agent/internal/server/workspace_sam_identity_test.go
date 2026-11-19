package server

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

// The node in these tests booted for a conversation session. Every value
// carries a "boot" marker so a leak into another workspace is unmistakable.
func bootIdentity(cfg *config.Config) {
	cfg.WorkspaceID = "ws-boot"
	cfg.ProjectID = "proj-boot"
	cfg.ChatSessionID = "chat-boot"
	cfg.TaskID = "task-boot"
	cfg.TaskMode = config.TaskModeConversation
	cfg.Repository = "octo/boot"
	cfg.Branch = "sam/boot"
	cfg.ControlPlaneURL = "https://api.example.com"
}

func envMap(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, _ := strings.Cut(entry, "=")
		out[key] = value
	}
	return out
}

type agentStartRequest struct {
	workspaceID, sessionID, chatSessionID, projectID, taskID, taskMode string
	// startProjectID overrides the project sent on agent-session start only.
	startProjectID string
	// beforeStart runs between create and start, e.g. to attach a viewer.
	beforeStart func()
}

// startAgentSessionThroughHandlers drives the two calls the control plane makes
// to start an agent on a workspace: create the agent session, then start it.
// The start is a duplicate delivery, so the real handler builds the SessionHost
// and returns before launching an agent process.
func startAgentSessionThroughHandlers(t *testing.T, s *Server, req agentStartRequest) map[string]string {
	t.Helper()
	started := postAgentSessionStart(t, s, req)
	if started.Code != http.StatusOK || !strings.Contains(started.Body.String(), `"status":"duplicate"`) {
		t.Fatalf("start agent session = %d %s", started.Code, started.Body.String())
	}

	s.sessionHostMu.Lock()
	host := s.sessionHosts[req.workspaceID+":"+req.sessionID]
	s.sessionHostMu.Unlock()
	if host == nil {
		t.Fatal("start did not build a SessionHost")
	}
	t.Cleanup(host.Stop)
	env := envMap(host.SAMEnvFallback())
	// Liveness: the env was built, so an absent value below is a real absence.
	if env["SAM_API_URL"] != "https://api.example.com" {
		t.Fatalf("SessionHost SAM env was not built: %v", env)
	}
	return env
}

// postAgentSessionStart creates the agent session and posts its start, returning
// the start response.
func postAgentSessionStart(t *testing.T, s *Server, req agentStartRequest) *httptest.ResponseRecorder {
	t.Helper()
	created := postAgentSessionCreate(t, s, req.workspaceID, req.sessionID, req.chatSessionID, req.projectID)
	if created.Code != http.StatusCreated {
		t.Fatalf("create agent session = %d %s", created.Code, created.Body.String())
	}
	if req.beforeStart != nil {
		req.beforeStart()
	}

	hash := agentStartDeliveryFingerprint(1, "message-1", "prompt", "", acp.AcpInteractionRuntimeConfig{})
	if _, _, conflict, err := s.store.AcceptPromptDelivery(req.workspaceID, req.sessionID, "delivery-1", 1, hash); err != nil || conflict {
		t.Fatalf("seed prompt delivery: conflict=%v err=%v", conflict, err)
	}
	if _, claimed, err := s.store.ClaimPromptDelivery(req.workspaceID, req.sessionID, "delivery-1", s.executionRuntimeID); err != nil || !claimed {
		t.Fatalf("claim prompt delivery: claimed=%v err=%v", claimed, err)
	}
	return nodeManagementPOST(t, s, s.handleStartAgentSession, req.workspaceID, req.sessionID,
		"/workspaces/"+req.workspaceID+"/agent-sessions/"+req.sessionID+"/start", map[string]any{
			"protocolVersion": 1, "deliveryId": "delivery-1", "messageId": "message-1",
			"agentType": "claude-code", "initialPrompt": "prompt",
			"projectId": firstNonEmpty(req.startProjectID, req.projectID), "taskId": req.taskID, "taskMode": req.taskMode,
		})
}

// postAgentSessionCreate is the control plane's create-agent-session call.
func postAgentSessionCreate(t *testing.T, s *Server, workspaceID, sessionID, chatSessionID, projectID string) *httptest.ResponseRecorder {
	t.Helper()
	return nodeManagementPOST(t, s, s.handleCreateAgentSession, workspaceID, sessionID,
		"/workspaces/"+workspaceID+"/agent-sessions", map[string]any{
			"sessionId": sessionID, "chatSessionId": chatSessionID, "projectId": projectID,
		})
}

// nodeManagementPOST sends a control-plane request with a node token scoped to
// workspaceID, installing the JWT validator on first use.
func nodeManagementPOST(t *testing.T, s *Server, handler http.HandlerFunc, workspaceID, sessionID, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	if s.jwtValidator == nil {
		validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
		s.jwtValidator = validator
		s.executionRuntimeID = "runtime-1"
		nodeTestKeys[s] = key
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	r.SetPathValue("workspaceId", workspaceID)
	r.SetPathValue("sessionId", sessionID)
	r.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, nodeTestKeys[s], "node-test", workspaceID))
	r.Header.Set("X-SAM-Node-Id", "node-test")
	r.Header.Set("X-SAM-Workspace-Id", workspaceID)
	rec := httptest.NewRecorder()
	handler(rec, r)
	return rec
}

var nodeTestKeys = map[*Server]*rsa.PrivateKey{}

func TestSharedNodeSessionGetsItsOwnSAMIdentity(t *testing.T) {
	cases := []struct {
		name string
		boot func(*config.Config)
		req  agentStartRequest
	}{
		{
			// Production, 2026-11-06: a task session on a node booted for a
			// conversation saw SAM_TASK_MODE=conversation and the boot task ID.
			name: "task session on a node booted for a conversation",
			boot: bootIdentity,
			req: agentStartRequest{workspaceID: "ws-second", sessionID: "sess-second", chatSessionID: "chat-second",
				projectID: "proj-second", taskID: "task-second", taskMode: config.TaskModeTask},
		},
		{
			name: "conversation session on a node booted for a task",
			boot: func(cfg *config.Config) {
				bootIdentity(cfg)
				cfg.TaskMode = config.TaskModeTask
			},
			req: agentStartRequest{workspaceID: "ws-second", sessionID: "sess-second", chatSessionID: "chat-second",
				projectID: "proj-second", taskID: "task-second", taskMode: config.TaskModeConversation},
		},
		{
			// Instant containers set WORKSPACE_ID but not TASK_MODE, which defaults to task.
			name: "Instant conversation in its own standalone workspace",
			boot: func(cfg *config.Config) {
				cfg.Role = config.RoleStandalone
				cfg.WorkspaceID = "ws-instant"
				cfg.ProjectID = "proj-instant"
				cfg.ChatSessionID = "chat-instant"
				cfg.TaskMode = config.TaskModeTask
				cfg.ControlPlaneURL = "https://api.example.com"
			},
			req: agentStartRequest{workspaceID: "ws-instant", sessionID: "sess-instant", chatSessionID: "chat-instant",
				projectID: "proj-instant", taskID: "task-instant", taskMode: config.TaskModeConversation},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newMcpTestServer(t)
			tc.boot(s.config)
			// The control plane's create-workspace request carries project and task IDs.
			s.upsertWorkspaceRuntime(tc.req.workspaceID, "octo/second", "sam/second", "running", "ws-token",
				workspaceRuntimeOpts{ProjectID: tc.req.projectID, TaskID: tc.req.taskID})

			env := startAgentSessionThroughHandlers(t, s, tc.req)

			want := map[string]string{
				"SAM_WORKSPACE_ID":    tc.req.workspaceID,
				"SAM_TASK_MODE":       tc.req.taskMode,
				"SAM_TASK_ID":         tc.req.taskID,
				"SAM_CHAT_SESSION_ID": tc.req.chatSessionID,
				"SAM_PROJECT_ID":      tc.req.projectID,
				"SAM_BRANCH":          "sam/second",
				"SAM_REPOSITORY":      "octo/second",
			}
			for key, value := range want {
				if env[key] != value {
					t.Errorf("%s = %q, want %q", key, env[key], value)
				}
			}
			for key, value := range env {
				if strings.Contains(value, "boot") {
					t.Errorf("%s = %q leaked the boot session's identity", key, value)
				}
			}
		})
	}
}

// The session-start body is control-plane input: it names the task and its mode
// for the workspace's own project, and an unknown mode never reaches the agent.
func TestSessionStartTaskContextFeedsTheSessionEnv(t *testing.T) {
	cases := []struct {
		name string
		req  agentStartRequest
		want map[string]string
	}{
		{
			name: "start names the workspace's own project (control)",
			req: agentStartRequest{workspaceID: "ws-second", sessionID: "sess-b", chatSessionID: "chat-second",
				projectID: "proj-second", taskID: "task-second", taskMode: config.TaskModeConversation},
			want: map[string]string{"SAM_PROJECT_ID": "proj-second", "SAM_TASK_ID": "task-second", "SAM_TASK_MODE": config.TaskModeConversation},
		},
		{
			name: "unknown task mode",
			req: agentStartRequest{workspaceID: "ws-second", sessionID: "sess-c", chatSessionID: "chat-second",
				projectID: "proj-second", taskID: "task-second", taskMode: "bogus"},
			want: map[string]string{"SAM_PROJECT_ID": "proj-second", "SAM_TASK_ID": "task-second", "SAM_TASK_MODE": ""},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newMcpTestServer(t)
			bootIdentity(s.config)
			s.upsertWorkspaceRuntime("ws-second", "octo/second", "sam/second", "running", "ws-token",
				workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

			env := startAgentSessionThroughHandlers(t, s, tc.req)

			for key, value := range tc.want {
				if env[key] != value {
					t.Errorf("%s = %q, want %q", key, env[key], value)
				}
			}
		})
	}
}

// A start naming another project would re-bind the workspace (runtime project,
// resource attribution, session task context and env). It is refused with 400,
// not a retryable 409, before any state changes.
func TestSessionStartForAnotherProjectIsRejected(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	s.upsertWorkspaceRuntime("ws-second", "octo/second", "sam/second", "running", "ws-token",
		workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

	rec := postAgentSessionStart(t, s, agentStartRequest{workspaceID: "ws-second", sessionID: "sess-a",
		chatSessionID: "chat-second", projectID: "proj-second", startProjectID: "proj-foreign",
		taskID: "task-foreign", taskMode: config.TaskModeTask})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("start = %d %s, want 400", rec.Code, rec.Body.String())
	}
	rt, _ := s.getWorkspaceRuntime("ws-second")
	if rt.ProjectID != "proj-second" || rt.TaskID != "task-second" {
		t.Errorf("runtime re-bound to %s/%s", rt.ProjectID, rt.TaskID)
	}
	s.sessionHostMu.Lock()
	_, hasCtx := s.sessionTaskCtx["ws-second:sess-a"]
	_, hasHost := s.sessionHosts["ws-second:sess-a"]
	s.sessionHostMu.Unlock()
	if hasCtx || hasHost {
		t.Errorf("rejected start left state behind: taskCtx=%v host=%v", hasCtx, hasHost)
	}
}

// Defence in depth for callers that bypass the start handler's check.
func TestWorkspaceSAMIdentityIgnoresTaskContextForAnotherProject(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	runtime := &WorkspaceRuntime{ID: "ws-second", ProjectID: "proj-second", TaskID: "task-second"}

	got := s.workspaceSAMIdentity("ws-second", runtime, &taskCallbackContext{
		ProjectID: "proj-foreign", TaskID: "task-foreign", TaskMode: config.TaskModeTask,
	})
	want := samIdentity{ProjectID: "proj-second", TaskID: "task-second"}
	if got != want {
		t.Fatalf("identity = %+v, want %+v", got, want)
	}
}

// A viewer's WebSocket can build the SessionHost before the control plane's
// start arrives with the session's task context. The start must still reach the
// agent's env.
func TestSessionStartRefreshesAHostAViewerBuiltFirst(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	s.config.AllowedOrigins = []string{"*"}
	s.config.WSReadBufferSize, s.config.WSWriteBufferSize = 4096, 4096
	s.sessionManager = auth.NewSessionManager("session", false, time.Hour)
	viewer, err := s.sessionManager.CreateSession(&auth.Claims{Workspace: "ws-second"})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(http.HandlerFunc(s.handleAgentWS))
	t.Cleanup(ts.Close)
	s.upsertWorkspaceRuntime("ws-second", "octo/second", "sam/second", "running", "ws-token",
		workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

	env := startAgentSessionThroughHandlers(t, s, agentStartRequest{
		workspaceID: "ws-second", sessionID: "sess-viewer", chatSessionID: "chat-second",
		projectID: "proj-second", taskID: "task-second", taskMode: config.TaskModeTask,
		beforeStart: func() {
			conn := dialAgentWS(t, ts, viewer.ID, "ws-second", "sess-viewer")
			t.Cleanup(func() { _ = conn.Close() })
			host := waitForSessionHost(t, s, "ws-second:sess-viewer")
			if mode := envMap(host.SAMEnvFallback())["SAM_TASK_MODE"]; mode != "" {
				t.Fatalf("viewer-built host already has SAM_TASK_MODE=%q; the test cannot observe the refresh", mode)
			}
		},
	})

	if env["SAM_TASK_MODE"] != config.TaskModeTask || env["SAM_TASK_ID"] != "task-second" {
		t.Fatalf("start did not refresh the viewer-built host: %v", env)
	}
}

// The runtime records only the workspace's latest agent session's chat; each
// agent session's env names the chat it was created for.
func TestEachAgentSessionInAWorkspaceGetsItsOwnChat(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	s.upsertWorkspaceRuntime("ws-second", "octo/second", "sam/second", "running", "ws-token",
		workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

	env := startAgentSessionThroughHandlers(t, s, agentStartRequest{
		workspaceID: "ws-second", sessionID: "sess-one", chatSessionID: "chat-one",
		projectID: "proj-second", taskID: "task-second", taskMode: config.TaskModeConversation,
		beforeStart: func() {
			if rec := postAgentSessionCreate(t, s, "ws-second", "sess-two", "chat-two", "proj-second"); rec.Code != http.StatusCreated {
				t.Fatalf("create second agent session = %d %s", rec.Code, rec.Body.String())
			}
			if rt, _ := s.getWorkspaceRuntime("ws-second"); rt.ChatSessionID != "chat-two" {
				t.Fatalf("runtime chat = %q; the test needs the runtime to name the other session", rt.ChatSessionID)
			}
		},
	})

	if env["SAM_CHAT_SESSION_ID"] != "chat-one" {
		t.Fatalf("SAM_CHAT_SESSION_ID = %q, want chat-one", env["SAM_CHAT_SESSION_ID"])
	}
}

// Creating an agent session writes its project onto the workspace runtime; a
// foreign project is refused before that happens.
func TestAgentSessionCreateForAnotherProjectIsRejected(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	s.upsertWorkspaceRuntime("ws-second", "octo/second", "sam/second", "running", "ws-token",
		workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

	rec := postAgentSessionCreate(t, s, "ws-second", "sess-a", "chat-foreign", "proj-foreign")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create = %d %s, want 400", rec.Code, rec.Body.String())
	}
	rt, _ := s.getWorkspaceRuntime("ws-second")
	if rt.ProjectID != "proj-second" || rt.ChatSessionID != "" {
		t.Errorf("runtime re-bound to project %q chat %q", rt.ProjectID, rt.ChatSessionID)
	}
	if _, exists := s.agentSessions.Get("ws-second", "sess-a"); exists {
		t.Error("rejected create still recorded the agent session")
	}

	if owner := postAgentSessionCreate(t, s, "ws-second", "sess-b", "chat-second", "proj-second"); owner.Code != http.StatusCreated {
		t.Fatalf("owner create = %d %s, want 201", owner.Code, owner.Body.String())
	}
}

func TestBootWorkspaceSAMIdentity(t *testing.T) {
	s, _ := newMcpTestServer(t)
	bootIdentity(s.config)
	runtime := &WorkspaceRuntime{ID: "ws-boot"}

	t.Run("falls back to the boot session when no session context exists", func(t *testing.T) {
		got := s.workspaceSAMIdentity("ws-boot", runtime, nil)
		want := samIdentity{ProjectID: "proj-boot", ChatSessionID: "chat-boot", TaskID: "task-boot", TaskMode: config.TaskModeConversation}
		if got != want {
			t.Fatalf("identity = %+v, want %+v", got, want)
		}
	})

	t.Run("session context wins over the boot session", func(t *testing.T) {
		got := s.workspaceSAMIdentity("ws-boot", runtime, &taskCallbackContext{
			ProjectID: "proj-boot", TaskID: "task-boot", TaskMode: config.TaskModeTask,
		})
		if got.TaskMode != config.TaskModeTask {
			t.Fatalf("TaskMode = %q, want task", got.TaskMode)
		}
	})

	t.Run("boot mode never describes a task it did not name", func(t *testing.T) {
		got := s.workspaceSAMIdentity("ws-boot", &WorkspaceRuntime{ID: "ws-boot", TaskID: "task-other"}, nil)
		if got.TaskID != "task-other" || got.TaskMode != "" {
			t.Fatalf("identity = %+v, want task-other with no mode", got)
		}
	})
}

func TestProvisioningConfigCarriesTheWorkspaceIdentity(t *testing.T) {
	cases := []struct {
		name    string
		recover bool
	}{{name: "provision"}, {name: "recover", recover: true}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			originalPrepare := prepareWorkspaceForRuntime
			t.Cleanup(func() { prepareWorkspaceForRuntime = originalPrepare })
			var captured *config.Config
			prepareWorkspaceForRuntime = func(_ context.Context, cfg *config.Config, _ bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
				copy := *cfg
				captured = &copy
				return false, errors.New("stop at the bootstrap boundary")
			}
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
			}))
			t.Cleanup(controlPlane.Close)

			s := &Server{
				config:          &config.Config{ContainerMode: true, WorkspaceDir: "/workspace", CallbackToken: "node-callback-token"},
				workspaces:      map[string]*WorkspaceRuntime{},
				workspaceEvents: map[string][]EventRecord{},
			}
			bootIdentity(s.config)
			s.config.ControlPlaneURL = controlPlane.URL
			// Repository-less, so provisioning does not fetch a git token first.
			runtime := s.upsertWorkspaceRuntime("ws-second", "", "sam/second", "creating", "workspace-callback-token",
				workspaceRuntimeOpts{ProjectID: "proj-second", TaskID: "task-second"})

			if tc.recover {
				_ = s.recoverWorkspaceRuntime(context.Background(), runtime)
			} else {
				_, _ = s.provisionWorkspaceRuntime(context.Background(), runtime)
			}
			if captured == nil {
				t.Fatal("bootstrap was never reached")
			}
			// Bootstrap writes these into /etc/sam/env and /etc/profile.d/sam-env.sh.
			if captured.WorkspaceID != "ws-second" || captured.Branch != "sam/second" {
				t.Fatalf("config not re-pointed at the workspace: %s %s", captured.WorkspaceID, captured.Branch)
			}
			got := samIdentity{captured.ProjectID, captured.ChatSessionID, captured.TaskID, captured.TaskMode}
			want := samIdentity{ProjectID: "proj-second", TaskID: "task-second"}
			if got != want {
				t.Fatalf("identity = %+v, want %+v (no boot values)", got, want)
			}
		})
	}
}
