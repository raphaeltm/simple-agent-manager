package messagereport

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// tokenGatedControlPlane mirrors the real messages endpoint contract: it rejects
// an unknown token with 401 BEFORE reading the body (nothing is persisted), and
// otherwise persists each message id once, counting repeats as duplicates
// (project-data/messages.ts dedupes by id).
type tokenGatedControlPlane struct {
	t          *testing.T
	mu         sync.Mutex
	valid      map[string]bool
	persisted  map[string]int
	duplicates int
	tokens     []string
	batchLimit int
	onRequest  func(token string)
}

func newTokenGatedControlPlane(t *testing.T, valid ...string) (*tokenGatedControlPlane, *httptest.Server) {
	cp := &tokenGatedControlPlane{t: t, valid: map[string]bool{}, persisted: map[string]int{}}
	for _, token := range valid {
		cp.valid[token] = true
	}
	server := httptest.NewServer(http.HandlerFunc(cp.serve))
	t.Cleanup(server.Close)
	return cp, server
}

func (cp *tokenGatedControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	cp.mu.Lock()
	hook := cp.onRequest
	cp.mu.Unlock()
	if hook != nil {
		hook(token)
	}

	cp.mu.Lock()
	cp.tokens = append(cp.tokens, token)
	valid := cp.valid[token]
	cp.mu.Unlock()
	if !valid {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`))
		return
	}

	ids := requestMessageIDs(cp.t, r)
	if cp.batchLimit > 0 && len(ids) > cp.batchLimit {
		writePayloadTooLarge(w)
		return
	}
	cp.mu.Lock()
	persisted, duplicates := 0, 0
	for _, id := range ids {
		if cp.persisted[id] > 0 {
			duplicates++
			continue
		}
		cp.persisted[id] = 1
		persisted++
	}
	cp.duplicates += duplicates
	cp.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"persisted": persisted, "duplicates": duplicates})
}

func (cp *tokenGatedControlPlane) setValid(token string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.valid[token] = true
}

func (cp *tokenGatedControlPlane) requestTokens() []string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]string(nil), cp.tokens...)
}

func (cp *tokenGatedControlPlane) persistedIDs() map[string]int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	out := make(map[string]int, len(cp.persisted))
	for id, n := range cp.persisted {
		out[id] = n
	}
	return out
}

// newHeldTestReporter builds a reporter whose background loop never ticks during
// the test, so every flush below is one the test drives.
func newHeldTestReporter(t *testing.T, endpoint, token string, adjust func(*Config)) (*Reporter, func() int) {
	t.Helper()
	db := openTestDB(t)
	cfg := testConfig(endpoint, "ws-1")
	cfg.BatchMaxWait = time.Hour
	if adjust != nil {
		adjust(&cfg)
	}
	r, err := New(db, cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	t.Cleanup(r.Shutdown)
	r.SetToken(token)
	outbox := func() int {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox").Scan(&n); err != nil {
			t.Fatalf("count outbox: %v", err)
		}
		return n
	}
	return r, outbox
}

func enqueueAssistant(t *testing.T, r *Reporter, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := r.Enqueue(Message{MessageID: id, Role: "assistant", Content: "reply " + id}); err != nil {
			t.Fatalf("enqueue %s: %v", id, err)
		}
	}
}

func TestCredentialRejection_HoldsRowsAndStopsSending(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t)
	r, outbox := newHeldTestReporter(t, server.URL, "expired", nil)

	enqueueAssistant(t, r, "m0", "m1")
	r.flush()
	r.flush()
	r.flush()

	if got := cp.requestTokens(); len(got) != 1 {
		t.Fatalf("a rejected token must be sent once, then held; requests = %v", got)
	}
	if got := outbox(); got != 2 {
		t.Fatalf("rejected rows must stay queued, outbox = %d", got)
	}
	// Liveness: the reporter still accepts new messages while held.
	enqueueAssistant(t, r, "m2")
	if got := outbox(); got != 3 {
		t.Fatalf("enqueue while held: outbox = %d, want 3", got)
	}
}

func TestCredentialRejection_ResumesWithReplacementTokenWithoutDuplicates(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t, "renewed")
	r, outbox := newHeldTestReporter(t, server.URL, "expired", nil)

	enqueueAssistant(t, r, "m0", "m1")
	r.flush()
	if got := outbox(); got != 2 {
		t.Fatalf("outbox after 401 = %d, want 2", got)
	}

	r.SetToken("renewed")
	r.flush()

	if got := outbox(); got != 0 {
		t.Fatalf("outbox after resume = %d, want 0", got)
	}
	if got := cp.requestTokens(); strings.Join(got, ",") != "expired,renewed" {
		t.Fatalf("request tokens = %v", got)
	}
	persisted := cp.persistedIDs()
	if len(persisted) != 2 || persisted["m0"] != 1 || persisted["m1"] != 1 || cp.duplicates != 0 {
		t.Fatalf("each message must be persisted exactly once: %v (duplicates %d)", persisted, cp.duplicates)
	}
}

func TestCredentialRejection_SameTokenDoesNotResume(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t)
	r, outbox := newHeldTestReporter(t, server.URL, "expired", nil)

	enqueueAssistant(t, r, "m0")
	r.flush()
	r.SetToken("expired") // e.g. getOrCreateReporter re-syncing an unchanged runtime token
	r.flush()

	if got := cp.requestTokens(); len(got) != 1 {
		t.Fatalf("re-setting the rejected token must not resend; requests = %v", got)
	}
	if got := outbox(); got != 1 {
		t.Fatalf("outbox = %d, want 1", got)
	}
}

func TestCredentialRejection_StaleTokenAfterRotationRetriesImmediately(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t, "t2")
	r, outbox := newHeldTestReporter(t, server.URL, "t1", nil)

	inFlight := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	cp.mu.Lock()
	cp.onRequest = func(token string) {
		if token == "t1" {
			once.Do(func() { close(inFlight) })
			<-release
		}
	}
	cp.mu.Unlock()

	enqueueAssistant(t, r, "m0")
	done := make(chan struct{})
	go func() {
		r.flush()
		close(done)
	}()

	<-inFlight
	r.SetToken("t2") // renewal lands while the t1 request is in flight
	close(release)   // ...then the control plane answers t1 with 401
	<-done

	if got := cp.requestTokens(); strings.Join(got, ",") != "t1,t2" {
		t.Fatalf("a 401 for a replaced token must be resent with the current one; requests = %v", got)
	}
	if got := outbox(); got != 0 {
		t.Fatalf("outbox = %d, want 0", got)
	}
	r.mu.Lock()
	held := r.credentialWait.rejectedToken
	r.mu.Unlock()
	if held != "" {
		t.Fatalf("a stale 401 must not pause delivery on the current token, held on %q", held)
	}
}

func TestCredentialRejection_SurfacesLongPauseOnceWithoutDeleting(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t)
	var reports []AuthRenewalWaitExceeded
	r, outbox := newHeldTestReporter(t, server.URL, "expired", func(cfg *Config) {
		cfg.AuthRenewalWait = time.Hour
		cfg.OnAuthRenewalWaitExceeded = func(info AuthRenewalWaitExceeded) {
			reports = append(reports, info)
		}
	})
	clock := time.Date(2026, 10, 4, 8, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return clock }

	enqueueAssistant(t, r, "m0", "m1")
	r.flush() // 401: pause starts

	clock = clock.Add(30 * time.Minute)
	r.flush()
	if len(reports) != 0 {
		t.Fatalf("pause reported before the budget: %+v", reports)
	}

	clock = clock.Add(31 * time.Minute)
	r.flush()
	r.flush()
	if len(reports) != 1 {
		t.Fatalf("pause must be reported exactly once, got %d", len(reports))
	}
	if got := reports[0]; got.WorkspaceID != "ws-1" || got.SessionID != "sess-1" || got.HeldMessages != 2 || got.PausedFor < time.Hour {
		t.Fatalf("unexpected report: %+v", got)
	}
	if got := outbox(); got != 2 {
		t.Fatalf("an exhausted wait must keep the queued rows, outbox = %d", got)
	}

	// A replacement token still delivers the held rows.
	cp.setValid("renewed")
	r.SetToken("renewed")
	r.flush()
	if got := outbox(); got != 0 {
		t.Fatalf("outbox after late replacement = %d, want 0", got)
	}

	// A later, separate pause is reported on its own.
	r.SetToken("rejected-again")
	enqueueAssistant(t, r, "m2")
	r.flush()
	clock = clock.Add(2 * time.Hour)
	r.flush()
	if len(reports) != 2 {
		t.Fatalf("a new pause must be reported again, got %d reports", len(reports))
	}
}

func TestCredentialRejection_DuringSizeFallbackKeepsRowsAndResendsOnce(t *testing.T) {
	cp, server := newTokenGatedControlPlane(t, "valid")
	cp.batchLimit = 1
	r, outbox := newHeldTestReporter(t, server.URL, "valid", nil)

	enqueueAssistant(t, r, "m0", "m1")
	// Requests: the batch (400, too large) → m0 alone (200) → m1 alone. The token
	// stops being accepted just before m1, so m0 is persisted and m1 is not.
	sent := 0
	cp.mu.Lock()
	cp.onRequest = func(string) {
		cp.mu.Lock()
		defer cp.mu.Unlock()
		sent++
		if sent == 3 {
			delete(cp.valid, "valid")
		}
	}
	cp.mu.Unlock()

	r.flush()
	if got := outbox(); got != 2 {
		t.Fatalf("a 401 during the row-by-row fallback must keep the batch, outbox = %d", got)
	}

	cp.setValid("renewed")
	r.SetToken("renewed")
	r.flush()

	if got := outbox(); got != 0 {
		t.Fatalf("outbox after resume = %d, want 0", got)
	}
	persisted := cp.persistedIDs()
	if persisted["m0"] != 1 || persisted["m1"] != 1 || len(persisted) != 2 {
		t.Fatalf("each message must be persisted exactly once: %v", persisted)
	}
	if cp.duplicates != 1 {
		t.Fatalf("the resent m0 must be absorbed as a duplicate, duplicates = %d", cp.duplicates)
	}
}

func TestCredentialRejection_HeldOutboxStaysBounded(t *testing.T) {
	_, server := newTokenGatedControlPlane(t)
	r, outbox := newHeldTestReporter(t, server.URL, "expired", func(cfg *Config) {
		cfg.OutboxMaxSize = 2
	})

	enqueueAssistant(t, r, "m0")
	r.flush()
	enqueueAssistant(t, r, "m1")
	if err := r.Enqueue(Message{MessageID: "m2", Role: "assistant", Content: "over"}); err == nil {
		t.Fatal("enqueue beyond the outbox cap must fail explicitly while held")
	}
	if got := outbox(); got != 2 {
		t.Fatalf("outbox = %d, want 2", got)
	}
}
