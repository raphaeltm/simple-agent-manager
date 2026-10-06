package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/messagereport"
	"github.com/workspace/vm-agent/internal/persistence"
)

const (
	renewalTestNode      = "node-1"
	renewalTestNodeToken = "node-token"
	renewalTestWorkspace = "ws-1"
)

// workspaceTestToken mints a token with the production claim set. The agent never
// verifies signatures (the control plane does), so a test key is enough.
func workspaceTestToken(t *testing.T, workspaceID string, issuedAt time.Time, lifetime time.Duration) string {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"workspace": workspaceID,
		"type":      "callback",
		"scope":     "workspace",
		"sub":       workspaceID,
		"aud":       "workspace-callback",
		"iat":       issuedAt.Unix(),
		"exp":       issuedAt.Add(lifetime).Unix(),
	}).SignedString([]byte("test-signing-key"))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

type renewalRequest struct {
	workspaceID    string
	workspaceToken string
	nodeID         string
	nodeToken      string
}

// renewalControlPlane plays the control plane's side of the renewal contract
// (apps/api/src/routes/workspaces/callback-token-renewal.ts): the workspace token
// in Authorization, the node id and node token in the JSON body. It also serves
// the messages endpoint, accepting only tokens it has issued or been told about.
type renewalControlPlane struct {
	t                *testing.T
	mu               sync.Mutex
	requests         []renewalRequest
	respond          func(req renewalRequest) (int, string)
	accepted         map[string]bool
	messages         []string // bearer token of each accepted message batch
	rejectedMessages map[string]int
	hold             chan struct{}
	inFlight         chan struct{}
	holdOnce         sync.Once
	server           *httptest.Server
	nodeToken        string
}

func newRenewalControlPlane(t *testing.T) *renewalControlPlane {
	cp := &renewalControlPlane{t: t, accepted: map[string]bool{}, rejectedMessages: map[string]int{}, nodeToken: renewalTestNodeToken}
	cp.server = httptest.NewServer(http.HandlerFunc(cp.serve))
	t.Cleanup(cp.server.Close)
	return cp
}

func (cp *renewalControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/callback-token/renew"):
		var body struct {
			NodeID    string `json:"nodeId"`
			NodeToken string `json:"nodeToken"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		workspaceID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/workspaces/"), "/callback-token/renew")
		req := renewalRequest{workspaceID: workspaceID, workspaceToken: token, nodeID: body.NodeID, nodeToken: body.NodeToken}
		cp.mu.Lock()
		cp.requests = append(cp.requests, req)
		hold, inFlight, respond := cp.hold, cp.inFlight, cp.respond
		cp.mu.Unlock()
		if hold != nil {
			cp.holdOnce.Do(func() { close(inFlight) })
			<-hold
		}
		if body.NodeID != renewalTestNode || body.NodeToken != cp.nodeToken {
			writeRenewalJSON(w, http.StatusUnauthorized, `{"error":"NODE_CALLBACK_UNAUTHORIZED","message":"Invalid or expired node callback token"}`)
			return
		}
		status, payload := respond(req)
		writeRenewalJSON(w, status, payload)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/messages"):
		cp.mu.Lock()
		ok := cp.accepted[token]
		if ok {
			cp.messages = append(cp.messages, token)
		} else {
			cp.rejectedMessages[token]++
		}
		cp.mu.Unlock()
		if !ok {
			writeRenewalJSON(w, http.StatusUnauthorized, `{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`)
			return
		}
		writeRenewalJSON(w, http.StatusOK, `{"persisted":1,"duplicates":0}`)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func writeRenewalJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// renewWith makes the next renewal of token's own workspace return token. Like the
// real route, a renewal is only ever issued for the workspace the request names;
// other workspaces get "not due".
func (cp *renewalControlPlane) renewWith(token string) {
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(token, claims); err != nil {
		cp.t.Fatal(err)
	}
	workspaceID, _ := claims["workspace"].(string)
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.accepted[token] = true
	cp.respond = func(req renewalRequest) (int, string) {
		if req.workspaceID != workspaceID {
			return http.StatusOK, `{"renewed":false}`
		}
		return http.StatusOK, `{"renewed":true,"token":"` + token + `","expiresAt":"2026-10-06T00:00:00.000Z"}`
	}
}

func (cp *renewalControlPlane) respondWith(status int, body string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.respond = func(renewalRequest) (int, string) { return status, body }
}

// heldOnToken reports whether the messages endpoint has rejected token at least
// once (the reporter then holds its rows until the token changes).
func heldOnToken(cp *renewalControlPlane, token string) bool {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.rejectedMessages[token] > 0
}

func (cp *renewalControlPlane) renewalRequests() []renewalRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]renewalRequest(nil), cp.requests...)
}

type renewalHarness struct {
	t     *testing.T
	s     *Server
	cp    *renewalControlPlane
	clock time.Time
}

func newRenewalHarness(t *testing.T, start time.Time) *renewalHarness {
	t.Helper()
	cp := newRenewalControlPlane(t)
	h := &renewalHarness{t: t, cp: cp, clock: start}
	h.s = &Server{
		config: &config.Config{
			NodeID:                                    renewalTestNode,
			ControlPlaneURL:                           cp.server.URL,
			CallbackToken:                             renewalTestNodeToken,
			HTTPCallbackTimeout:                       5 * time.Second,
			WorkspaceCallbackTokenRefreshRatio:        config.DefaultWorkspaceCallbackTokenRefreshRatio,
			WorkspaceCallbackTokenRenewalTimeout:      5 * time.Second,
			WorkspaceCallbackTokenRenewalRetryInitial: time.Minute,
			WorkspaceCallbackTokenRenewalRetryMax:     30 * time.Minute,
		},
		callbackToken:    renewalTestNodeToken,
		errorReporter:    newTestErrorReporter(),
		messageReporters: map[string]*messagereport.Reporter{},
		sessionHosts:     map[string]*acp.SessionHost{},
		workspaces:       map[string]*WorkspaceRuntime{},
		done:             make(chan struct{}),
	}
	h.s.tokenRenewal.now = func() time.Time { return h.clock }
	return h
}

func (h *renewalHarness) addWorkspace(id, token string) *WorkspaceRuntime {
	runtime := &WorkspaceRuntime{ID: id, CallbackToken: token, WorkspaceDir: "/workspace/" + id, Status: "running"}
	h.s.workspaces[id] = runtime
	return runtime
}

func (h *renewalHarness) token(id string) string {
	h.s.workspaceMu.RLock()
	defer h.s.workspaceMu.RUnlock()
	return h.s.workspaces[id].CallbackToken
}

// pass advances the clock and runs one post-heartbeat renewal pass.
func (h *renewalHarness) pass(advance time.Duration) {
	h.clock = h.clock.Add(advance)
	h.s.renewDueWorkspaceCallbackTokensOnce()
}

var renewalEpoch = time.Date(2026, 10, 2, 20, 20, 0, 0, time.UTC)

func TestWorkspaceTokenRenewal_RenewsAtTheRefreshPointAndKeepsAWorkspaceAlivePast24h(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, first)

	h.pass(11 * time.Hour) // 11h of 24h: not due
	if got := len(h.cp.renewalRequests()); got != 0 {
		t.Fatalf("renewed before the refresh point: %d requests", got)
	}

	second := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(12*time.Hour), 24*time.Hour)
	h.cp.renewWith(second)
	h.pass(time.Hour) // 12h: due
	if h.token(renewalTestWorkspace) != second {
		t.Fatal("the renewed token was not installed")
	}

	h.pass(11 * time.Hour) // 23h: the renewed token is only 11h old
	if got := len(h.cp.renewalRequests()); got != 1 {
		t.Fatalf("renewed a fresh token: %d requests", got)
	}

	third := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(24*time.Hour), 24*time.Hour)
	h.cp.renewWith(third)
	h.pass(time.Hour) // 24h: the original token has expired; the renewed one is due
	h.pass(time.Hour) // 25h
	if h.token(renewalTestWorkspace) != third {
		t.Fatal("the workspace does not hold a live token past its first 24h")
	}

	requests := h.cp.renewalRequests()
	if len(requests) != 2 || requests[0].workspaceToken != first || requests[1].workspaceToken != second {
		t.Fatalf("renewals presented %v, want the first then the second token", requests)
	}
	for _, req := range requests {
		if req.workspaceID != renewalTestWorkspace || req.nodeID != renewalTestNode || req.nodeToken != renewalTestNodeToken {
			t.Fatalf("renewal did not carry the workspace and node proofs: %+v", req)
		}
	}
	if h.s.getCallbackToken() != renewalTestNodeToken {
		t.Fatal("workspace renewal must not touch the node token")
	}
}

func TestWorkspaceTokenRenewal_RefusalLatchesUntilANewTokenArrives(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"expired workspace token", http.StatusUnauthorized, `{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`},
		{"not hosted on this node", http.StatusForbidden, `{"error":"FORBIDDEN","message":"Workspace is not hosted on this node"}`},
		{"workspace deleted", http.StatusGone, `{"error":"GONE","message":"Workspace is deleted; callback resource is gone"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newRenewalHarness(t, renewalEpoch)
			first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
			h.addWorkspace(renewalTestWorkspace, first)
			h.cp.respondWith(tc.status, tc.body)

			h.pass(13 * time.Hour)
			h.pass(time.Hour)
			h.pass(48 * time.Hour)
			if got := len(h.cp.renewalRequests()); got != 1 {
				t.Fatalf("a refused token was presented %d times, want once", got)
			}
			if h.token(renewalTestWorkspace) != first {
				t.Fatal("a refusal must not change the workspace token")
			}

			// A control-plane delivery (e.g. hibernate) brings a new token: renewal
			// resumes for it, from its own refresh point.
			delivered := workspaceTestToken(t, renewalTestWorkspace, h.clock, 24*time.Hour)
			h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", delivered)
			h.cp.renewWith(workspaceTestToken(t, renewalTestWorkspace, h.clock.Add(12*time.Hour), 24*time.Hour))
			h.pass(time.Hour)
			if got := len(h.cp.renewalRequests()); got != 1 {
				t.Fatalf("a fresh delivered token was renewed early: %d requests", got)
			}
			h.pass(11 * time.Hour)
			requests := h.cp.renewalRequests()
			if len(requests) != 2 || requests[1].workspaceToken != delivered {
				t.Fatalf("renewal did not resume with the delivered token: %v", requests)
			}
		})
	}
}

func TestWorkspaceTokenRenewal_TransientFailuresBackOffAndNodeCredentialFailuresRetry(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	h.addWorkspace(renewalTestWorkspace, workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour))
	h.cp.respondWith(http.StatusServiceUnavailable, `{"error":"SERVICE_UNAVAILABLE"}`)

	h.pass(13 * time.Hour) // attempt 1 fails → wait 1m
	h.pass(30 * time.Second)
	h.pass(30 * time.Second) // attempt 2 fails → wait 2m
	h.pass(time.Minute)
	h.pass(time.Minute) // attempt 3 fails → wait 4m
	if got := len(h.cp.renewalRequests()); got != 3 {
		t.Fatalf("transient failures: %d attempts, want 3 on a 1m/2m backoff", got)
	}
	h.pass(10 * time.Hour) // the backoff is capped at RetryMax
	if got := len(h.cp.renewalRequests()); got != 4 {
		t.Fatalf("attempts after a long wait = %d, want 4", got)
	}

	// A refused NODE credential is the node token's problem (the heartbeat
	// refreshes it), so it is retried rather than latched.
	h.cp.mu.Lock()
	h.cp.nodeToken = "a-node-token-the-agent-does-not-have-yet"
	h.cp.mu.Unlock()
	h.pass(31 * time.Minute)
	h.cp.mu.Lock()
	h.cp.nodeToken = renewalTestNodeToken
	h.cp.mu.Unlock()
	renewed := workspaceTestToken(t, renewalTestWorkspace, h.clock, 24*time.Hour)
	h.cp.renewWith(renewed)
	h.pass(31 * time.Minute)
	if h.token(renewalTestWorkspace) != renewed {
		t.Fatal("renewal did not recover after the node credential was accepted again")
	}
}

func TestWorkspaceTokenRenewal_NotDueWaitsRetryMax(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	h.addWorkspace(renewalTestWorkspace, workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour))
	h.cp.respondWith(http.StatusOK, `{"renewed":false}`) // e.g. the agent clock runs ahead

	h.pass(13 * time.Hour)
	h.pass(29 * time.Minute)
	if got := len(h.cp.renewalRequests()); got != 1 {
		t.Fatalf("asked again before RetryMax: %d requests", got)
	}
	h.pass(time.Minute)
	if got := len(h.cp.renewalRequests()); got != 2 {
		t.Fatalf("did not ask again after RetryMax: %d requests", got)
	}
}

func TestWorkspaceTokenRenewal_ExpiredTokenIsOfferedOnceSoTheControlPlaneDecides(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	h.addWorkspace(renewalTestWorkspace, workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour))
	h.cp.respondWith(http.StatusUnauthorized, `{"error":"UNAUTHORIZED"}`)

	h.pass(30 * time.Hour) // the agent believes the token expired 6h ago
	h.pass(time.Hour)
	if got := len(h.cp.renewalRequests()); got != 1 {
		t.Fatalf("an apparently expired token was offered %d times, want exactly once", got)
	}
}

func TestWorkspaceTokenRenewal_DiscardsARenewalWhenADeliveryWinsTheRace(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, first)
	host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{CallbackToken: first}})
	t.Cleanup(host.Stop)
	h.s.sessionHosts[renewalTestWorkspace+":agent-1"] = host

	renewed := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(13*time.Hour), 24*time.Hour)
	h.cp.renewWith(renewed)
	h.cp.mu.Lock()
	h.cp.hold, h.cp.inFlight = make(chan struct{}), make(chan struct{})
	hold, inFlight := h.cp.hold, h.cp.inFlight
	h.cp.mu.Unlock()

	h.clock = h.clock.Add(13 * time.Hour)
	done := make(chan struct{})
	go func() {
		h.s.renewDueWorkspaceCallbackTokensOnce()
		close(done)
	}()
	<-inFlight
	// The control plane delivers a token over hibernate while the renewal is in flight.
	delivered := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(13*time.Hour+time.Second), 24*time.Hour)
	h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", delivered)
	close(hold)
	<-done

	if h.token(renewalTestWorkspace) != delivered {
		t.Fatal("a late renewal response overwrote a token delivered during the request")
	}
	if !host.UsesCallbackToken(delivered) {
		t.Fatal("the SessionHost did not receive the delivered token")
	}
}

func TestWorkspaceTokenDelivery_NeverAdoptsATokenThatExpiresEarlier(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	current := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(12*time.Hour), 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, current)
	host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{CallbackToken: current}})
	t.Cleanup(host.Stop)
	h.s.sessionHosts[renewalTestWorkspace+":agent-1"] = host

	older := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour) // a reordered, older delivery
	h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", older)
	if h.token(renewalTestWorkspace) != current || !host.UsesCallbackToken(current) {
		t.Fatal("an older delivered token replaced a newer one")
	}

	newer := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(20*time.Hour), 24*time.Hour)
	h.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", newer)
	if h.token(renewalTestWorkspace) != newer || !host.UsesCallbackToken(newer) {
		t.Fatal("a newer delivered token was not adopted and propagated")
	}
}

// Renewal must reach every consumer that copied the old token, and a parked
// message reporter must deliver what it held.
func TestWorkspaceTokenRenewal_ReachesParkedReporterAndEverySessionHostOfTheWorkspace(t *testing.T) {
	h := newRenewalHarness(t, renewalEpoch)
	first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	h.addWorkspace(renewalTestWorkspace, first)
	other := workspaceTestToken(t, "ws-2", renewalEpoch, 24*time.Hour)
	h.addWorkspace("ws-2", other)

	hosts := map[string]*acp.SessionHost{}
	for _, key := range []string{renewalTestWorkspace + ":agent-1", renewalTestWorkspace + ":agent-2", "ws-2:agent-1"} {
		token := first
		if strings.HasPrefix(key, "ws-2:") {
			token = other
		}
		host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{CallbackToken: token}})
		t.Cleanup(host.Stop)
		hosts[key] = host
		h.s.sessionHosts[key] = host
	}

	_, db := openTestSQLiteDB(t)
	reporter, err := messagereport.New(db, messagereport.Config{
		BatchMaxWait: 20 * time.Millisecond, Endpoint: h.cp.server.URL,
		WorkspaceID: renewalTestWorkspace, ProjectID: "proj-1", SessionID: "chat-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reporter.Shutdown)
	reporter.SetToken(first)
	h.s.messageReporters[renewalTestWorkspace] = reporter
	if err := reporter.Enqueue(messagereport.Message{MessageID: "m-1", Role: "assistant", Content: "reply"}); err != nil {
		t.Fatal(err)
	}
	// The control plane rejects the old token: the reporter holds the message.
	waitFor(t, func() bool { return countOutbox(t, db) == 1 && heldOnToken(h.cp, first) }, "message held after 401")

	renewed := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(12*time.Hour), 24*time.Hour)
	h.cp.renewWith(renewed)
	h.pass(12 * time.Hour)

	waitFor(t, func() bool { return countOutbox(t, db) == 0 }, "held message delivered after renewal")
	h.cp.mu.Lock()
	delivered := append([]string(nil), h.cp.messages...)
	h.cp.mu.Unlock()
	if len(delivered) != 1 || delivered[0] != renewed {
		t.Fatalf("held message delivered with %v, want once with the renewed token", delivered)
	}
	if !hosts[renewalTestWorkspace+":agent-1"].UsesCallbackToken(renewed) ||
		!hosts[renewalTestWorkspace+":agent-2"].UsesCallbackToken(renewed) {
		t.Fatal("a SessionHost of the renewed workspace kept the old token")
	}
	if !hosts["ws-2:agent-1"].UsesCallbackToken(other) {
		t.Fatal("another workspace's SessionHost received this workspace's token")
	}
}

func TestWorkspaceTokenRenewal_PersistsTheRenewedTokenForRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	openStore := func() *persistence.Store {
		store, err := persistence.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.SetCallbackTokenEncryptionSecret(renewalTestNodeToken); err != nil {
			t.Fatal(err)
		}
		return store
	}

	h := newRenewalHarness(t, renewalEpoch)
	h.s.store = openStore()
	first := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch, 24*time.Hour)
	runtime := h.addWorkspace(renewalTestWorkspace, first)
	runtime.Repository = "octo/repo"
	h.s.persistWorkspaceMetadata(runtime)

	renewed := workspaceTestToken(t, renewalTestWorkspace, renewalEpoch.Add(12*time.Hour), 24*time.Hour)
	h.cp.renewWith(renewed)
	h.pass(12 * time.Hour)
	if err := h.s.store.Close(); err != nil {
		t.Fatal(err)
	}

	// A restarted agent hydrates the workspace from SQLite.
	restarted := newRenewalHarness(t, h.clock)
	restarted.s.store = openStore()
	t.Cleanup(func() { _ = restarted.s.store.Close() })
	restarted.s.upsertWorkspaceRuntime(renewalTestWorkspace, "", "", "", "")
	if restarted.token(renewalTestWorkspace) != renewed {
		t.Fatal("a restart resumed with the pre-renewal token")
	}
}

func countOutbox(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&count); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return count
}
