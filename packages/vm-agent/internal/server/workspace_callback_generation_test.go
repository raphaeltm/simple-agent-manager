package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
)

const generationTestWorkspace = "ws-restart"

// generationTestToken mints a workspace callback token with the production claim
// set plus the control plane's callback generation ("cgen"). cgen "" omits it.
func generationTestToken(t *testing.T, workspaceID, scope, cgen string, lifetime time.Duration) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"workspace": workspaceID, "type": "callback", "scope": scope, "sub": workspaceID,
		"aud": "workspace-callback", "iat": now.Unix(), "exp": now.Add(lifetime).Unix(),
	}
	if cgen != "" {
		claims["cgen"] = cgen
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("test-signing-key"))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

type rotationRequest struct {
	path, bearer, mcpToken string
}

// generationControlPlane plays the control plane for a restart: git token and
// runtime assets for provisioning, the messages endpoint (recording bearers), and
// POST /api/workspaces/:id/mcp-token/rotate answered by respond.
type generationControlPlane struct {
	mu        sync.Mutex
	rotations []rotationRequest
	messages  []string
	gitTokens []string
	respond   func(attempt int, old string) (int, string)
	attempts  map[string]int
	hold      chan struct{} // when set, rotation requests wait for it to close
	held      int           // rotation requests that reached the hold
	server    *httptest.Server
}

func newGenerationControlPlane(t *testing.T) *generationControlPlane {
	t.Helper()
	cp := &generationControlPlane{attempts: map[string]int{}}
	cp.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch {
		case strings.HasSuffix(r.URL.Path, "/mcp-token/rotate"):
			var body struct {
				McpToken string `json:"mcpToken"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.mu.Lock()
			hold := cp.hold
			if hold != nil {
				cp.held++
			}
			cp.mu.Unlock()
			if hold != nil {
				<-hold
			}
			cp.mu.Lock()
			cp.rotations = append(cp.rotations, rotationRequest{path: r.URL.Path, bearer: bearer, mcpToken: body.McpToken})
			cp.attempts[body.McpToken]++
			status, payload := cp.respond(cp.attempts[body.McpToken], body.McpToken)
			cp.mu.Unlock()
			writeRenewalJSON(w, status, payload)
		case strings.HasSuffix(r.URL.Path, "/messages"):
			cp.mu.Lock()
			cp.messages = append(cp.messages, bearer)
			cp.mu.Unlock()
			writeRenewalJSON(w, http.StatusOK, `{"persisted":1,"duplicates":0}`)
		case strings.HasSuffix(r.URL.Path, "/git-token"):
			cp.mu.Lock()
			cp.gitTokens = append(cp.gitTokens, bearer)
			cp.mu.Unlock()
			_, _ = w.Write([]byte(`{"token":"git-token"}`))
		case strings.HasSuffix(r.URL.Path, "/runtime-assets"):
			_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(cp.server.Close)
	return cp
}

// heldRotations reports how many rotation requests reached the hold.
func (cp *generationControlPlane) heldRotations() int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.held
}

func (cp *generationControlPlane) rotationRequests() []rotationRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]rotationRequest(nil), cp.rotations...)
}

// newGenerationServer builds the restart harness with a fake control plane, a
// current token of generation A persisted to SQLite, and fast rotation retries.
func newGenerationServer(t *testing.T, status, currentToken string) (*Server, string, func(error), *generationControlPlane) {
	t.Helper()
	s, nodeToken, finish := newRestartGenerationTestServer(t, status)
	cp := newGenerationControlPlane(t)
	s.config.ControlPlaneURL = cp.server.URL
	s.config.McpTokenRotationTimeout = 2 * time.Second
	s.config.McpTokenRotationMaxAttempts = 3
	s.config.McpTokenRotationRetryDelay = time.Millisecond
	s.config.McpTokenRotationBudget = 10 * time.Second
	s.sessionMcpServers = map[string][]acp.McpServerEntry{}
	s.messageReporters = map[string]*messagereport.Reporter{}
	if err := s.store.SetCallbackTokenEncryptionSecret("node-secret"); err != nil {
		t.Fatal(err)
	}
	s.workspaceMu.Lock()
	runtime := s.workspaces[generationTestWorkspace]
	runtime.CallbackToken = currentToken
	err := s.writeWorkspaceMetadata(runtime)
	s.workspaceMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return s, nodeToken, finish, cp
}

func persistedCallbackToken(t *testing.T, s *Server) string {
	t.Helper()
	meta, err := s.store.GetWorkspaceMetadata(generationTestWorkspace)
	if err != nil || meta == nil {
		t.Fatalf("read workspace metadata: %v %v", meta, err)
	}
	return meta.CallbackToken
}

func restartBody(t *testing.T, fenced bool, callbackToken string) string {
	t.Helper()
	body := map[string]interface{}{}
	if fenced {
		body["evictionGeneration"] = restartTestGeneration
		body["expectedEvictionGeneration"] = ""
	}
	if callbackToken != "" {
		body["callbackToken"] = callbackToken
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// stubPrepare replaces the bootstrap boundary for one test and reports each call.
func stubPrepare(t *testing.T, onCall func()) {
	t.Helper()
	original := prepareWorkspaceForRuntime
	prepareWorkspaceForRuntime = func(context.Context, *config.Config, bootstrap.ProvisionState, *bootlog.Reporter) (bool, error) {
		onCall()
		return false, errors.New("bootstrap boundary")
	}
	t.Cleanup(func() { prepareWorkspaceForRuntime = original })
}

func TestWorkspaceRestartInstallsDeliveredCallbackTokenAuthoritatively(t *testing.T) {
	for _, fenced := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "fenced"}[fenced], func(t *testing.T) {
			// The current token expires LATER than the delivered one; the "later
			// expiry wins" rule for other deliveries must not keep it.
			current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", 48*time.Hour)
			delivered := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
			s, nodeToken, finish, cp := newGenerationServer(t, "stopped", current)
			stubPrepare(t, func() {})

			hosts := map[string]*acp.SessionHost{}
			for _, key := range []string{generationTestWorkspace + ":s1", generationTestWorkspace + ":s2", "ws-other:s1"} {
				host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{CallbackToken: current}})
				t.Cleanup(host.Stop)
				hosts[key] = host
				s.sessionHosts[key] = host
			}
			_, db := openTestSQLiteDB(t)
			reporter, err := messagereport.New(db, messagereport.Config{
				BatchMaxWait: 10 * time.Millisecond, Endpoint: cp.server.URL,
				WorkspaceID: generationTestWorkspace, ProjectID: "proj-1", SessionID: "chat-1",
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(reporter.Shutdown)
			reporter.SetToken(current)
			s.messageReporters[generationTestWorkspace] = reporter

			rec := postWorkspaceReprovision(t, s, nodeToken, "restart", restartBody(t, fenced, delivered))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
			}
			if got := s.workspaceCallbackToken(generationTestWorkspace); got != delivered {
				t.Fatal("in-memory token is not the delivered token")
			}
			if persistedCallbackToken(t, s) != delivered {
				t.Fatal("SQLite still holds the revoked token: an agent restart would resume with it")
			}
			if !hosts[generationTestWorkspace+":s1"].UsesCallbackToken(delivered) ||
				!hosts[generationTestWorkspace+":s2"].UsesCallbackToken(delivered) {
				t.Fatal("a SessionHost of the restarted workspace kept the revoked token")
			}
			if !hosts["ws-other:s1"].UsesCallbackToken(current) {
				t.Fatal("another workspace's SessionHost received this workspace's token")
			}
			if err := reporter.Enqueue(messagereport.Message{MessageID: "m-1", Role: "assistant", Content: "reply"}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool {
				cp.mu.Lock()
				defer cp.mu.Unlock()
				return len(cp.messages) > 0
			}, "message reporter never flushed")
			cp.mu.Lock()
			messageBearer := cp.messages[0]
			cp.mu.Unlock()
			if messageBearer != delivered {
				t.Fatal("message reporter still authenticates with the revoked token")
			}

			finish(nil)
			waitForRestartProvisionFailure(t, s)
			cp.mu.Lock()
			gitTokens := append([]string(nil), cp.gitTokens...)
			cp.mu.Unlock()
			if len(gitTokens) == 0 || gitTokens[0] != delivered {
				t.Fatal("provisioning did not authenticate with the delivered token")
			}
			if len(cp.rotationRequests()) != 0 {
				t.Fatal("rotation ran for a workspace with no sam-mcp sessions")
			}
		})
	}
}

func TestWorkspaceRestartRejectsForeignCallbackTokenWithoutStateChange(t *testing.T) {
	for _, tt := range []struct{ name, token string }{
		{"other workspace", generationTestToken(t, "ws-other", "workspace", "gen-b", time.Hour)},
		{"node scope", generationTestToken(t, generationTestWorkspace, "node", "gen-b", time.Hour)},
		{"undecodable", "not-a-jwt"},
		{"blank", "   "},
	} {
		t.Run(tt.name, func(t *testing.T) {
			current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
			s, nodeToken, finish, cp := newGenerationServer(t, "evicted", current)
			defer finish(errors.New("test complete"))
			before := s.snapshotWorkspaceRuntime(s.workspaces[generationTestWorkspace])

			rec := postWorkspaceReprovision(t, s, nodeToken, "restart", restartBody(t, true, tt.token))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("got %d: %s; want 400", rec.Code, rec.Body.String())
			}
			after := s.snapshotWorkspaceRuntime(s.workspaces[generationTestWorkspace])
			if after.Status != before.Status || after.ProvisioningActive || after.EvictionGeneration != before.EvictionGeneration || after.CallbackToken != current {
				t.Fatalf("rejected restart changed runtime: status=%q active=%v generation=%q tokenChanged=%v",
					after.Status, after.ProvisioningActive, after.EvictionGeneration, after.CallbackToken != current)
			}
			meta, err := s.store.GetWorkspaceMetadata(generationTestWorkspace)
			if err != nil || meta == nil || meta.EvictionGeneration != "" || meta.CallbackToken != current {
				t.Fatalf("rejected restart changed persisted state: generation=%q err=%v", meta.EvictionGeneration, err)
			}
			if len(cp.rotationRequests()) != 0 {
				t.Fatal("rejected restart rotated MCP tokens")
			}
		})
	}
}

// Absent field: exactly the pre-rotation behaviour (rule 73).
func TestWorkspaceRestartWithoutCallbackTokenKeepsCurrentToken(t *testing.T) {
	for _, fenced := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "fenced"}[fenced], func(t *testing.T) {
			current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
			s, nodeToken, finish, cp := newGenerationServer(t, "stopped", current)
			s.sessionMcpServers[generationTestWorkspace+":s1"] = []acp.McpServerEntry{
				{URL: "https://api.example.com/mcp", Token: "old-mcp", Name: acp.SamMcpServerName},
			}
			cp.respond = func(int, string) (int, string) { return http.StatusOK, `{"token":"new-mcp"}` }
			prepared := make(chan struct{}, 1)
			stubPrepare(t, func() { prepared <- struct{}{} })

			rec := postWorkspaceReprovision(t, s, nodeToken, "restart", restartBody(t, fenced, ""))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
			}
			// Liveness: the restart did take effect.
			runtime := s.snapshotWorkspaceRuntime(s.workspaces[generationTestWorkspace])
			if runtime.Status != "creating" || !runtime.ProvisioningActive {
				t.Fatalf("restart did not claim the workspace: %#v", runtime)
			}
			if runtime.CallbackToken != current || persistedCallbackToken(t, s) != current {
				t.Fatal("restart without a delivered token changed the callback token")
			}
			finish(nil)
			<-prepared
			waitForRestartProvisionFailure(t, s)
			if len(cp.rotationRequests()) != 0 {
				t.Fatal("restart without a delivered token rotated MCP tokens")
			}
		})
	}
}

func TestWorkspaceRestartStillRejectsUnknownFields(t *testing.T) {
	current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
	delivered := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
	s, nodeToken, finish, _ := newGenerationServer(t, "stopped", current)
	defer finish(errors.New("test complete"))
	rec := postWorkspaceReprovision(t, s, nodeToken, "restart", `{"callbackToken":"`+delivered+`","unexpected":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d: %s; want 400", rec.Code, rec.Body.String())
	}
	if s.workspaceCallbackToken(generationTestWorkspace) != current {
		t.Fatal("a rejected request installed its token")
	}
}

// Drives the full rotation through the real rebuild handler: memory and
// SQLite-only sessions, retries, a refusal, an untouched third-party entry and
// another workspace, the 202 returning before rotation finishes, and rotation
// finishing before provisioning. Live SessionHosts are covered in
// workspace_callback_generation_hosts_test.go.
func TestWorkspaceRebuildRotatesSamMcpTokensBeforeProvisioning(t *testing.T) {
	current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
	delivered := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
	s, nodeToken, finish, cp := newGenerationServer(t, "running", current)
	defer finish(errors.New("test complete"))

	sam := func(token string) acp.McpServerEntry {
		return acp.McpServerEntry{URL: "https://api.example.com/mcp", Token: token, Name: acp.SamMcpServerName}
	}
	composio := acp.McpServerEntry{URL: "https://backend.composio.dev/mcp", Token: "user-token", Name: "composio"}
	for key, entries := range map[string][]acp.McpServerEntry{
		generationTestWorkspace + ":sess-a":         {sam("old-a"), composio},
		generationTestWorkspace + ":sess-forbidden": {sam("old-forbidden")},
		generationTestWorkspace + ":sess-flaky":     {sam("old-flaky")},
		"ws-other:sess-x":                           {sam("old-other")},
	} {
		workspaceID, sessionID, _ := strings.Cut(key, ":")
		s.registerSessionMcpServers(workspaceID, sessionID, entries)
	}
	// A session that survived an agent restart exists only in SQLite.
	if err := s.store.UpsertSessionMcpServers(generationTestWorkspace, "sess-sqlite",
		toPersistedMcpServers([]acp.McpServerEntry{sam("old-sqlite")})); err != nil {
		t.Fatal(err)
	}
	cp.respond = func(attempt int, old string) (int, string) {
		switch {
		case old == "old-forbidden":
			return http.StatusForbidden, `{"error":"FORBIDDEN"}`
		case old == "old-flaky" && attempt == 1:
			return http.StatusServiceUnavailable, `{"error":"UNAVAILABLE"}`
		default:
			return http.StatusOK, `{"token":"` + strings.Replace(old, "old-", "new-", 1) + `"}`
		}
	}
	cp.hold = make(chan struct{})
	var rotationsAtPrepare []rotationRequest
	prepared := make(chan struct{}, 1)
	stubPrepare(t, func() {
		rotationsAtPrepare = cp.rotationRequests()
		prepared <- struct{}{}
	})

	responded := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		responded <- postWorkspaceReprovision(t, s, nodeToken, "rebuild", restartBody(t, false, delivered))
	}()
	select {
	case rec := <-responded:
		if rec.Code != http.StatusAccepted {
			t.Fatalf("rebuild: %d %s", rec.Code, rec.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the 202 waited for MCP token rotation")
	}
	close(cp.hold)
	finish(nil)
	select {
	case <-prepared:
	case <-time.After(5 * time.Second):
		t.Fatal("provisioning never reached the bootstrap boundary")
	}
	waitForRestartProvisionFailure(t, s)

	// 4 sessions of this workspace plus one retry; never the other workspace.
	if len(rotationsAtPrepare) != 5 {
		t.Fatalf("provisioning started after %d rotation requests, want all 5 done first", len(rotationsAtPrepare))
	}
	for _, req := range cp.rotationRequests() {
		if req.path != "/api/workspaces/"+generationTestWorkspace+"/mcp-token/rotate" {
			t.Fatalf("rotation path = %q", req.path)
		}
		if req.bearer != delivered {
			t.Fatal("rotation did not authenticate with the newly installed callback token")
		}
		if req.mcpToken == "old-other" || req.mcpToken == "user-token" {
			t.Fatalf("rotation sent a token it must not: %q", req.mcpToken)
		}
	}
	cp.mu.Lock()
	flakyAttempts := cp.attempts["old-flaky"]
	cp.mu.Unlock()
	if flakyAttempts != 2 {
		t.Fatalf("flaky rotation attempts = %d, want a retry after the 503", flakyAttempts)
	}

	persisted, err := s.store.ListWorkspaceSessionMcpServers(generationTestWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	s.sessionHostMu.Lock()
	memory := map[string][]acp.McpServerEntry{}
	for key, entries := range s.sessionMcpServers {
		memory[key] = entries
	}
	s.sessionHostMu.Unlock()
	for session, want := range map[string]string{"sess-a": "new-a", "sess-flaky": "new-flaky", "sess-sqlite": "new-sqlite", "sess-forbidden": "old-forbidden"} {
		if got := persisted[session][0].Token; got != want {
			t.Errorf("persisted %s sam-mcp token = %q, want %q", session, got, want)
		}
		if got := memory[generationTestWorkspace+":"+session][0].Token; got != want {
			t.Errorf("in-memory %s sam-mcp token = %q, want %q", session, got, want)
		}
	}
	if got := persisted["sess-a"][1]; got.Name != "composio" || got.Token != "user-token" {
		t.Errorf("third-party entry changed: %#v", got)
	}
	if got := memory["ws-other:sess-x"][0].Token; got != "old-other" {
		t.Errorf("another workspace's token changed to %q", got)
	}
}

// Rotation must not depend on the restart request context: it runs after the 202.
func TestWorkspaceRestartRotationSurvivesRequestContextCancellation(t *testing.T) {
	current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
	delivered := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
	s, nodeToken, finish, cp := newGenerationServer(t, "stopped", current)
	defer finish(errors.New("test complete"))
	if err := s.store.UpsertSessionMcpServers(generationTestWorkspace, "sess-1", []persistence.McpServer{
		{URL: "https://api.example.com/mcp", Token: "old-1", Name: acp.SamMcpServerName},
	}); err != nil {
		t.Fatal(err)
	}
	cp.respond = func(int, string) (int, string) { return http.StatusOK, `{"token":"new-1"}` }
	cp.hold = make(chan struct{})
	stubPrepare(t, func() {})

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/workspaces/"+generationTestWorkspace+"/restart",
		strings.NewReader(restartBody(t, false, delivered))).WithContext(ctx)
	req.SetPathValue("workspaceId", generationTestWorkspace)
	req.Header.Set("Authorization", "Bearer "+nodeToken)
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", generationTestWorkspace)
	rec := httptest.NewRecorder()
	s.handleRestartWorkspace(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
	}
	cancel() // the handler has returned, as http.Server would cancel it
	close(cp.hold)
	waitFor(t, func() bool {
		servers, err := s.store.GetSessionMcpServers(generationTestWorkspace, "sess-1")
		return err == nil && len(servers) == 1 && servers[0].Token == "new-1"
	}, "rotation did not complete after the request context was cancelled")
	finish(nil)
	waitForRestartProvisionFailure(t, s)
}

func TestClassifySamMcpTokenRotation(t *testing.T) {
	for _, tt := range []struct {
		status int
		token  string
		err    error
		want   mcpTokenRotationOutcome
	}{
		{http.StatusOK, "new", nil, mcpTokenRotated},
		{http.StatusOK, "", nil, mcpTokenRotationTransientFailure},
		{http.StatusOK, "", errors.New("bad json"), mcpTokenRotationTransientFailure},
		{http.StatusUnauthorized, "", nil, mcpTokenRotationRefused},
		{http.StatusForbidden, "", nil, mcpTokenRotationRefused},
		{http.StatusNotFound, "", nil, mcpTokenRotationRefused},
		{http.StatusGone, "", nil, mcpTokenRotationRefused},
		{http.StatusTooManyRequests, "", nil, mcpTokenRotationTransientFailure},
		{http.StatusBadGateway, "", nil, mcpTokenRotationTransientFailure},
	} {
		if got := classifySamMcpTokenRotation(tt.status, tt.token, tt.err); got != tt.want {
			t.Errorf("status %d token %q: got %v, want %v", tt.status, tt.token, got, tt.want)
		}
	}
}

// Transient failures stop at the attempt limit (rule 54.13).
func TestSamMcpTokenRotationStopsAfterMaxAttempts(t *testing.T) {
	current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
	s, _, finish, cp := newGenerationServer(t, "stopped", current)
	defer finish(errors.New("test complete"))
	s.sessionMcpServers[generationTestWorkspace+":s1"] = []acp.McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "old-1", Name: acp.SamMcpServerName},
	}
	cp.respond = func(int, string) (int, string) { return http.StatusBadGateway, `{}` }
	s.rotateWorkspaceSamMcpTokens(generationTestWorkspace, current)
	if got := len(cp.rotationRequests()); got != s.config.McpTokenRotationMaxAttempts {
		t.Fatalf("rotation requests = %d, want %d", got, s.config.McpTokenRotationMaxAttempts)
	}
	if got := s.sessionMcpServers[generationTestWorkspace+":s1"][0].Token; got != "old-1" {
		t.Fatalf("failed rotation replaced the token with %q", got)
	}
}

func TestAgentCapabilitiesAdvertiseCallbackTokenRotation(t *testing.T) {
	s := &Server{config: &config.Config{}}
	if s.agentCapabilities()["callbackTokenRotation"] != true {
		t.Fatalf("callbackTokenRotation = %#v", s.agentCapabilities()["callbackTokenRotation"])
	}
}
