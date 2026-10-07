package server

// Safety properties of workspace callback token renewal and delivery that sit
// beside the core lifecycle in workspace_callback_token_renewal_test.go: tokens
// that are not this workspace's are never installed, a rate-limited renewal
// backs off instead of latching, a long delivery pause reaches the node's error
// channel, no token value is ever logged, and a SessionHost created while a
// token changes still ends up with the new token.

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/errorreport"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/publish"
)

func nodeScopedTestToken(t *testing.T, nodeID string, issuedAt time.Time) string {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"workspace": nodeID,
		"type":      "callback",
		"scope":     "node",
		"sub":       nodeID,
		"aud":       "workspace-callback",
		"iat":       issuedAt.Unix(),
		"exp":       issuedAt.Add(24 * time.Hour).Unix(),
	}).SignedString([]byte("test-signing-key"))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestWorkspaceTokenRenewal_RateLimitedRenewalBacksOffInsteadOfLatching(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	h.addWorkspace(renewalTestWorkspace, workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour))
	h.cp.respondWith(http.StatusTooManyRequests, `{"error":"RATE_LIMIT_EXCEEDED","message":"Too many requests. Please try again later."}`)

	h.pass(13 * time.Hour)
	h.pass(30 * time.Second)
	if got := len(h.cp.renewalRequests()); got != 1 {
		t.Fatalf("retried a rate-limited renewal before the backoff: %d requests", got)
	}

	renewed := workspaceTestToken(t, renewalTestWorkspace, h.clock, 24*time.Hour)
	h.cp.renewWith(renewed)
	h.pass(30 * time.Second)
	if h.token(renewalTestWorkspace) != renewed {
		t.Fatal("a rate-limited renewal latched the token instead of retrying after the backoff")
	}
}

func TestWorkspaceTokenRenewal_IgnoresARenewedTokenForAnotherWorkspace(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	current := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, current)
	foreign := workspaceTestToken(t, "ws-2", renewalEpoch.Add(13*time.Hour), 24*time.Hour)
	h.cp.respondWith(http.StatusOK, `{"renewed":true,"token":"`+foreign+`"}`)

	h.pass(13 * time.Hour)
	if h.token(renewalTestWorkspace) != current {
		t.Fatal("installed a renewed token that names another workspace")
	}

	// Treated as a transient control-plane fault: retried after the backoff, not latched.
	renewed := workspaceTestToken(t, renewalTestWorkspace, h.clock, 24*time.Hour)
	h.cp.renewWith(renewed)
	h.pass(time.Minute)
	if h.token(renewalTestWorkspace) != renewed {
		t.Fatal("renewal did not recover with this workspace's token")
	}
}

func TestWorkspaceTokenDelivery_IgnoresTokensThatAreNotThisWorkspaces(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	current := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, current)
	host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{CallbackToken: current}})
	t.Cleanup(host.Stop)
	h.s.sessionHosts[renewalTestWorkspace+":agent-1"] = host

	later := renewalEpoch.Add(time.Hour)
	for name, token := range map[string]string{
		"another workspace's token": workspaceTestToken(t, "ws-2", later, 24*time.Hour),
		"the node's own token":      nodeScopedTestToken(t, renewalTestNode, later),
	} {
		h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", token)
		if h.token(renewalTestWorkspace) != current || !host.UsesCallbackToken(current) {
			t.Fatalf("adopted %s as the workspace token", name)
		}
	}

	own := workspaceTestToken(t, renewalTestWorkspace, later, 24*time.Hour)
	h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", own)
	if h.token(renewalTestWorkspace) != own || !host.UsesCallbackToken(own) {
		t.Fatal("did not adopt this workspace's own newer token")
	}
}

// The reporter getOrCreateReporter builds must raise the long-pause alert through
// the node's error reporter, which authenticates with the node token and so still
// gets through while the workspace token is refused.
func TestGetOrCreateReporter_RaisesALongMessagePauseThroughTheNodeErrorReporter(t *testing.T) {
	t.Setenv("MSG_AUTH_RENEWAL_WAIT", "1ms")
	t.Setenv("MSG_BATCH_MAX_WAIT", "10ms")
	const rejected = "workspace-token-the-control-plane-refuses"

	var mu sync.Mutex
	var errorBodies []string
	messageAttempts := 0
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/nodes/node-1/errors":
			mu.Lock()
			errorBodies = append(errorBodies, string(body))
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/workspaces/ws-1/messages":
			mu.Lock()
			messageAttempts++
			mu.Unlock()
			writeRenewalJSON(w, http.StatusUnauthorized, `{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(controlPlane.Close)

	dir := t.TempDir()
	errorReporter := errorreport.New(controlPlane.URL, "node-1", "node-token", errorreport.Config{
		DBPath:        filepath.Join(dir, "error-reports.db"),
		FlushInterval: 10 * time.Millisecond,
	})
	errorReporter.Start()
	t.Cleanup(errorReporter.Shutdown)

	s := &Server{
		config: &config.Config{
			NodeID:            "node-1",
			ControlPlaneURL:   controlPlane.URL,
			PersistenceDBPath: filepath.Join(dir, "state.db"),
		},
		errorReporter:    errorReporter,
		messageReporters: map[string]*messagereport.Reporter{},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", CallbackToken: rejected, Status: "running"},
		},
	}
	reporter := s.getOrCreateReporter("ws-1", "proj-1", "chat-1")
	if reporter == nil {
		t.Fatal("getOrCreateReporter returned nil")
	}
	t.Cleanup(reporter.Shutdown)
	if err := reporter.Enqueue(messagereport.Message{MessageID: "m-1", Role: "assistant", Content: "reply"}); err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, body := range errorBodies {
			if strings.Contains(body, "messagereport.credential_wait") {
				return true
			}
		}
		return false
	}, "the node error reporter never received the message-persistence pause")

	mu.Lock()
	defer mu.Unlock()
	if messageAttempts == 0 {
		t.Fatal("the reporter never tried to deliver, so the pause was not caused by a refusal")
	}
	for _, body := range errorBodies {
		if strings.Contains(body, rejected) {
			t.Fatal("the error report carried the workspace token")
		}
	}
}

type lockedLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Every renewal outcome and every refusal path logs workspace IDs, statuses and
// error codes, never a token.
func TestWorkspaceTokenRenewal_NeverLogsATokenValue(t *testing.T) {
	logs := &lockedLogBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	const nodeToken = "node-token-that-must-never-be-logged"
	h := newRenewalHarness(t, renewalEpoch)
	h.s.callbackToken = nodeToken
	h.s.config.CallbackToken = nodeToken
	h.cp.nodeToken = nodeToken
	first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, first)
	tokens := []string{nodeToken, first}

	h.cp.respondWith(http.StatusServiceUnavailable, `{"error":"SERVICE_UNAVAILABLE"}`)
	h.pass(13 * time.Hour) // transient failure
	foreign := workspaceTestToken(t, "ws-2", h.clock, 24*time.Hour)
	tokens = append(tokens, foreign)
	h.cp.respondWith(http.StatusOK, `{"renewed":true,"token":"`+foreign+`"}`)
	h.pass(time.Hour) // a renewed token for another workspace
	renewed := workspaceTestToken(t, renewalTestWorkspace, h.clock, 24*time.Hour)
	tokens = append(tokens, renewed)
	h.cp.renewWith(renewed)
	h.pass(time.Hour)                                                     // success
	h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", foreign) // refused delivery
	h.cp.respondWith(http.StatusUnauthorized, `{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`)
	h.pass(13 * time.Hour) // refusal

	_, db := openTestSQLiteDB(t)
	reporter, err := messagereport.New(db, messagereport.Config{
		BatchMaxWait: 10 * time.Millisecond, Endpoint: h.cp.server.URL,
		WorkspaceID: renewalTestWorkspace, ProjectID: "proj-1", SessionID: "chat-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reporter.Shutdown)
	reporter.SetToken(renewed) // the fake control plane only accepts tokens it renewed
	h.cp.mu.Lock()
	delete(h.cp.accepted, renewed)
	h.cp.mu.Unlock()
	if err := reporter.Enqueue(messagereport.Message{MessageID: "m-1", Role: "assistant", Content: "reply"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return heldOnToken(h.cp, renewed) }, "the reporter never hit a 401")
	// The fake server records the rejection before the reporter processes its
	// response. Wait for that processing before inspecting the captured logs.
	waitFor(t, func() bool {
		return strings.Contains(logs.String(), "holding messages until it is replaced")
	}, "the reporter never logged its credential hold")

	output := logs.String()
	for _, want := range []string{
		"Workspace callback token renewal failed",
		"Workspace callback token renewed",
		"Ignoring delivered callback token that is not this workspace's token",
		"Control plane refused workspace callback token renewal",
		"holding messages until it is replaced",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("expected log %q was not captured, so the absence check below proves nothing:\n%s", want, output)
		}
	}
	for _, token := range tokens {
		signature := token[strings.LastIndex(token, ".")+1:]
		if strings.Contains(output, token) || strings.Contains(output, signature) {
			t.Fatalf("a token value was logged:\n%s", output)
		}
	}
}

// A SessionHost created while a renewal installs a new token must end up with the
// new token whichever runs first: creation reads the token and registers the host
// under one sessionHostMu hold, and propagation updates hosts under the same lock.
func TestWorkspaceTokenRenewal_HostCreatedDuringATokenChangeGetsTheNewToken(t *testing.T) {
	for round := 0; round < 200; round++ {
		h := newRenewalHarness(t, renewalEpoch)
		h.s.config.ACPMessageBufferSize = 8
		h.s.config.ACPViewerSendBuffer = 2
		h.s.agentSessions = agentsessions.NewManager()
		h.s.sessionMcpServers = map[string][]acp.McpServerEntry{}
		h.s.sessionProfileOvr = map[string]profileOverrides{}
		h.s.sessionTaskCtx = map[string]taskCallbackContext{}
		old := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
		h.addWorkspace(renewalTestWorkspace, old)
		renewed := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(time.Duration(round+1)*time.Minute), 24*time.Hour)

		var host *acp.SessionHost
		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			host = h.s.getOrCreateSessionHost(renewalTestWorkspace+":agent-1", renewalTestWorkspace, "agent-1",
				agentsessions.Session{ID: "agent-1", WorkspaceID: renewalTestWorkspace}, nil, "")
		}()
		go func() {
			defer wg.Done()
			<-start
			h.s.replaceRenewedWorkspaceCallbackToken(renewalTestWorkspace, old, renewed)
		}()
		close(start)
		wg.Wait()

		if host == nil {
			t.Fatal("no SessionHost was created")
		}
		if !host.UsesCallbackToken(renewed) {
			host.Stop()
			t.Fatalf("round %d: a SessionHost created during the token change kept the old token", round)
		}
		host.Stop()
	}
}

// A publish job runs for up to DeployBuildPublishTimeout. Its callbacks must use a
// workspace token renewed while it runs, not the one captured when it started.
func TestPublishJob_CallbacksUseATokenRenewedWhileTheJobRuns(t *testing.T) {
	s, key := mcpBuildTestServer(t)
	tmp := t.TempDir()
	t.Setenv("SAM_DOCKER_CLI_PATH", fakeDockerCLI(t, tmp, "", true))
	store, err := persistence.Open(filepath.Join(tmp, "vm-agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	s.store = store

	var mu sync.Mutex
	var eventAuth []string
	callbacks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/deployment-publish-jobs/job-renew/events") {
			mu.Lock()
			eventAuth = append(eventAuth, r.Header.Get("Authorization"))
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(callbacks.Close)
	s.config.ControlPlaneURL = callbacks.URL
	s.workspaces["ws-001"] = &WorkspaceRuntime{
		ID: "ws-001", Status: "running", WorkspaceDir: "/workspace/WS_001", ProjectID: "proj-1",
		CallbackToken: "token-when-the-job-started",
	}

	started := make(chan struct{})
	release := make(chan struct{})
	s.buildPublishRunner = func(context.Context, *preparedBuildPublish, publish.EventSink) (*publish.ReleaseResult, error) {
		close(started)
		<-release
		return &publish.ReleaseResult{ReleaseID: "rel-1", Version: 1, Status: "created"}, nil
	}
	rec := mcpBuildJobStartPOST(t, s, key, "ws-001", "job-renew", McpBuildAndPublishRequest{
		PublishJobID: "job-renew", Environment: "staging", EnvironmentID: "env-1",
	}, context.Background())
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	<-started
	if !s.replaceRenewedWorkspaceCallbackToken("ws-001", "token-when-the-job-started", "token-renewed-during-the-job") {
		t.Fatal("renewal was not installed")
	}
	close(release)

	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(eventAuth) > 0 && eventAuth[len(eventAuth)-1] == "Bearer token-renewed-during-the-job"
	}, "the publish job's later callbacks did not use the renewed token")
	mu.Lock()
	defer mu.Unlock()
	if eventAuth[0] != "Bearer token-when-the-job-started" {
		t.Fatalf("first publish callback used %q, want the token the job started with", eventAuth[0])
	}
}

func TestDecodeCallbackTokenClaims(t *testing.T) {
	encode := func(payload string) string {
		return "eyJhbGciOiJIUzI1NiJ9." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".c2ln"
	}
	issued := time.Date(2026, 10, 4, 8, 0, 0, 0, time.UTC)

	claims, ok := decodeCallbackTokenClaims(workspaceTestToken(t, renewalTestWorkspace, issued, 24*time.Hour))
	if !ok || claims.Workspace != renewalTestWorkspace || claims.Subject != renewalTestWorkspace ||
		claims.Scope != "workspace" || int64(claims.IssuedAt) != issued.Unix() || int64(claims.ExpiresAt) != issued.Add(24*time.Hour).Unix() {
		t.Fatalf("decoded %+v ok=%v from a production-shaped token", claims, ok)
	}
	// JWT numeric dates may be fractional; padded base64 must decode too.
	padded := "e30." + base64.URLEncoding.EncodeToString([]byte(`{"workspace":"ws-1","iat":1791108000.5,"exp":1791194400.5}`)) + ".c2ln"
	if claims, ok := decodeCallbackTokenClaims(padded); !ok || claims.Workspace != "ws-1" || int64(claims.ExpiresAt) != 1791194400 {
		t.Fatalf("padded/fractional token decoded as %+v ok=%v", claims, ok)
	}

	for name, token := range map[string]string{
		"opaque string":      "not-a-jwt",
		"two segments":       "a.b",
		"payload not b64":    "a.!!!.c",
		"payload not json":   encode("not json"),
		"payload not claims": encode(`["array"]`),
	} {
		if _, ok := decodeCallbackTokenClaims(token); ok {
			t.Fatalf("%s decoded", name)
		}
		if callbackTokenNamesOtherWorkspace(token, renewalTestWorkspace) {
			t.Fatalf("%s was refused; an unreadable token is left for the control plane to reject", name)
		}
		if _, _, ok := callbackTokenLifetime(token); ok {
			t.Fatalf("%s produced a lifetime", name)
		}
	}
}
