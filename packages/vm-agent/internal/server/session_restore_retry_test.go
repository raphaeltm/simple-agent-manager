package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
)

func newRestoreRetryTestServer(t *testing.T) (*Server, *sessionSnapshotHandlerInput) {
	t.Helper()
	s, _ := newMcpTestServer(t)
	s.workspaces["ws"] = &WorkspaceRuntime{ID: "ws", ProjectID: "project", Status: "running", CallbackToken: "original"}
	if _, _, err := s.agentSessions.CreateRouted("ws", "session", "Original", "", "project", "chat"); err != nil {
		t.Fatal(err)
	}
	return s, &sessionSnapshotHandlerInput{
		workspaceID: "ws", sessionID: "session", chatSessionID: "chat", agentType: "claude-code",
		runtime: s.workspaces["ws"], callbackToken: "fresh", workspaceCallbackToken: "fresh",
	}
}

func TestSessionRestoreConcurrentRetriesDoNotOverwriteLaterEdits(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	file := filepath.Join(t.TempDir(), "user-work")
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	restore := func(context.Context) map[string]interface{} {
		calls.Add(1)
		tabs, err := s.store.ListTabs("ws")
		if err != nil || len(tabs) != 1 || tabs[0].ID != "session" {
			t.Errorf("filesystem effects began without durable fence: %v, %v", tabs, err)
		}
		if err := os.WriteFile(file, []byte("restored"), 0600); err != nil {
			t.Error(err)
		}
		close(started)
		<-release
		return map[string]interface{}{"status": "restored"}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		if _, err := s.runSessionRestore(context.Background(), input, restore); err != nil {
			t.Error(err)
		}
	})
	<-started
	for range 16 {
		wg.Go(func() {
			result, err := s.runSessionRestore(context.Background(), input, restore)
			if err != nil || result["status"] != "restored" {
				t.Errorf("retry returned %v, %v", result, err)
			}
		})
	}
	close(release)
	wg.Wait()
	if err := os.WriteFile(file, []byte("new user edits"), 0600); err != nil {
		t.Fatal(err)
	}
	retry := *input
	retry.workspaceCallbackToken = "competing-token"
	if _, err := s.runSessionRestore(context.Background(), &retry, restore); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(file)
	if err != nil || string(got) != "new user edits" || calls.Load() != 1 {
		t.Fatalf("retry overwrote work: %q calls=%d err=%v", got, calls.Load(), err)
	}
	if s.callbackTokenForWorkspace("ws") != "fresh" {
		t.Fatal("retry changed reserved routing token")
	}
}

func TestSessionRestoreWaitCanCancelWithoutReplaying(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		_, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
			close(started)
			<-release
			return map[string]interface{}{"status": "degraded"}
		})
		if err != nil {
			t.Error(err)
		}
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.runSessionRestore(ctx, input, func(context.Context) map[string]interface{} {
		t.Error("canceled retry executed restore")
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("cancellation lost: %v", err)
	}
	close(release)
	<-finished
	result, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
		t.Error("degraded restore was replayed")
		return nil
	})
	if err != nil || result["status"] != "degraded" {
		t.Fatalf("degraded retry = %v, %v", result, err)
	}
}

func TestSessionRestoreRejectsRoutingAndAgentMismatch(t *testing.T) {
	for _, mismatch := range []string{"chat", "project", "agent", "reloaded", "stopped"} {
		t.Run(mismatch, func(t *testing.T) {
			s, input := newRestoreRetryTestServer(t)
			if mismatch == "agent" {
				if _, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} { return nil }); err != nil {
					t.Fatal(err)
				}
				input.agentType = "codex"
			} else if mismatch == "chat" {
				input.chatSessionID = "other"
			} else if mismatch == "project" {
				s.workspaces["ws"].ProjectID = "other"
			} else if mismatch == "stopped" {
				if _, err := s.agentSessions.Stop("ws", "session"); err != nil {
					t.Fatal(err)
				}
			} else {
				s.agentSessions = agentsessions.NewManager()
				if _, _, err := s.agentSessions.Create("ws", "session", "Original", ""); err != nil {
					t.Fatal(err)
				}
			}
			before := s.callbackTokenForWorkspace("ws")
			input.workspaceCallbackToken = "must-not-apply"
			_, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
				t.Error("conflicting restore reached effects")
				return nil
			})
			if err == nil || s.callbackTokenForWorkspace("ws") != before {
				t.Fatalf("conflicting restore was accepted: %v", err)
			}
		})
	}
}

func TestSessionRestorePersistenceFailurePreventsEffects(t *testing.T) {
	for _, mode := range []string{"missing", "closed"} {
		t.Run(mode, func(t *testing.T) {
			s, input := newRestoreRetryTestServer(t)
			if mode == "missing" {
				s.store = nil
			} else if err := s.store.Close(); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				_, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
					t.Error("restore ran without persistence")
					return nil
				})
				if err == nil || s.callbackTokenForWorkspace("ws") != "original" {
					t.Fatalf("persistence failure allowed effects: %v", err)
				}
			}
		})
	}
}

func TestSessionRestoreRefusesAlreadyUsedWorkspace(t *testing.T) {
	for _, usedBy := range []string{"host", "harness", "prompt", "sibling", "start-intent", "persisted-old-session"} {
		t.Run(usedBy, func(t *testing.T) {
			s, input := newRestoreRetryTestServer(t)
			session, _ := s.agentSessions.Get("ws", "session")
			switch usedBy {
			case "host":
				host := s.getOrCreateSessionHost("ws:session", "ws", "session", session, input.runtime, "")
				if host == nil {
					t.Fatal("initial host creation failed")
				}
				t.Cleanup(host.Stop)
			case "harness":
				if err := s.agentSessions.UpdateAcpSessionID("ws", "session", "already-running", "claude-code"); err != nil {
					t.Fatal(err)
				}
			case "prompt":
				if err := s.agentSessions.UpdateLastPrompt("ws", "session", "user work"); err != nil {
					t.Fatal(err)
				}
			case "sibling":
				if _, _, err := s.agentSessions.CreateRouted("ws", "sibling", "Sibling", "", "project", "other-chat"); err != nil {
					t.Fatal(err)
				}
			case "start-intent":
				s.sessionProfileOvr["ws:session"] = profileOverrides{}
			case "persisted-old-session":
				// Restart followed by creating a new routing ID must not hide
				// preexisting workspace work retained under the old tab ID.
				if err := s.store.InsertTab(persistence.Tab{ID: "old-session", WorkspaceID: "ws", Type: "chat"}); err != nil {
					t.Fatal(err)
				}
			}
			_, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
				t.Error("restore reached filesystem effects on a used workspace")
				return nil
			})
			if err == nil || s.callbackTokenForWorkspace("ws") != "original" {
				t.Fatalf("used workspace accepted restore: %v", err)
			}
		})
	}
}

func TestSessionRestoreReservationBlocksOrdinaryHostsAndSurvivesHostCleanup(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	session, _ := s.agentSessions.Get("ws", "session")
	_, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
		if host := s.getOrCreateSessionHost("ws:session", "ws", "session", session, input.runtime, ""); host != nil {
			t.Error("ordinary start was admitted while restore owned the files")
		}
		if host := s.getOrCreateSessionHost("ws:sibling", "ws", "sibling", session, input.runtime, ""); host != nil {
			t.Error("sibling start was admitted while restore owned the files")
		}
		// The restore owner alone can hydrate a host under its reservation.
		host := s.getOrCreateSessionHostForRestore("ws:session", "ws", "session", session, input.runtime, "", true)
		if host == nil {
			t.Error("restore owner could not create its host")
		}
		s.stopSessionHostsForWorkspace("ws")
		if s.sessionRestores["ws:session"] == nil {
			t.Error("host teardown evicted an in-flight restore fence")
		}
		if host := s.getOrCreateSessionHost("ws:session", "ws", "session", session, input.runtime, ""); host != nil {
			t.Error("host cleanup allowed a new start during restore")
		}
		return map[string]interface{}{"status": "restored"}
	})
	if err != nil {
		t.Fatal(err)
	}
	host := s.getOrCreateSessionHost("ws:session", "ws", "session", session, input.runtime, "")
	if host == nil {
		t.Fatal("ordinary start remained blocked after restore completed")
	}
	t.Cleanup(host.Stop)
	// Later activity must not stop a completed retry from returning cached proof.
	result, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} {
		t.Error("completed restore replayed after host started")
		return nil
	})
	if err != nil || result["status"] != "restored" {
		t.Fatalf("cached retry after start = %v, %v", result, err)
	}
}

func configureFreshStandaloneRestore(s *Server) {
	s.config.Role = config.RoleStandalone
	s.config.WorkspaceID = "ws"
	s.config.ProjectID = "project"
	s.config.ChatSessionID = "chat"
	s.agentSessions = agentsessions.NewManager()
}

func TestStandaloneRestorePersistsFenceAcrossRestart(t *testing.T) {
	s, input := newRestoreRetryTestServer(t)
	configureFreshStandaloneRestore(s)
	if err := s.initializeStandaloneRestoreSession("ws", "session", "chat", "cf-container"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.runSessionRestore(context.Background(), input, func(context.Context) map[string]interface{} { return map[string]interface{}{"status": "restored"} }); err != nil {
		t.Fatal(err)
	}
	// A new process retains SQLite, but no in-memory routing or attempt proof.
	s.agentSessions = agentsessions.NewManager()
	s.sessionRestores = nil
	if err := s.initializeStandaloneRestoreSession("ws", "session", "chat", "cf-container"); err == nil {
		t.Fatal("restart adopted persisted tab and could overwrite live files")
	}
	if err := s.initializeStandaloneRestoreSession("ws", "different", "chat", "cf-container"); err == nil {
		t.Fatal("new routing ID bypassed persisted workspace fence")
	}
}

func TestStandaloneRestoreRequiresFreshConfiguredIdentity(t *testing.T) {
	for _, mismatch := range []string{"workspace", "chat", "project", "runtime", "role", "other-session", "other-tab", "persistence"} {
		t.Run(mismatch, func(t *testing.T) {
			s, _ := newRestoreRetryTestServer(t)
			configureFreshStandaloneRestore(s)
			workspace, chat, runtime := "ws", "chat", "cf-container"
			switch mismatch {
			case "workspace":
				workspace = "other"
			case "chat":
				chat = "other"
			case "project":
				s.workspaces["ws"].ProjectID = "other"
			case "runtime":
				runtime = "vm"
			case "role":
				s.config.Role = ""
			case "other-session":
				if _, _, err := s.agentSessions.Create("ws", "other", "Other", ""); err != nil {
					t.Fatal(err)
				}
			case "other-tab":
				if err := s.store.InsertTab(persistence.Tab{ID: "other", WorkspaceID: "ws", Type: "chat"}); err != nil {
					t.Fatal(err)
				}
			case "persistence":
				s.store = nil
			}
			if err := s.initializeStandaloneRestoreSession(workspace, "session", chat, runtime); err == nil {
				t.Fatal("unconfigured or non-fresh standalone restore accepted")
			}
		})
	}
}

// newStandaloneRestoreHandlerServer prepares a fresh standalone workspace whose
// snapshot restore calls back to the given control plane, and returns a request
// builder for the real authenticated restore handler.
func newStandaloneRestoreHandlerServer(t *testing.T, controlPlane http.HandlerFunc) (*Server, func(context.Context) *http.Request) {
	t.Helper()
	s, _ := newRestoreRetryTestServer(t)
	configureFreshStandaloneRestore(s)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	token := signWorkspaceCreateNodeToken(t, key, "node-test", "ws")
	cp := httptest.NewServer(controlPlane)
	t.Cleanup(func() {
		// A restore still blocked in the fake control plane would otherwise
		// hold Close open forever; dropping the connections releases it.
		cp.CloseClientConnections()
		cp.Close()
	})
	s.config.ControlPlaneURL = cp.URL
	return s, func(ctx context.Context) *http.Request {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/workspaces/ws/agent-sessions/session/restore", strings.NewReader(`{"chatSessionId":"chat","runtime":"cf-container","agentType":"claude-code","workspaceCallbackToken":"fresh"}`))
		req.SetPathValue("workspaceId", "ws")
		req.SetPathValue("sessionId", "session")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-SAM-Workspace-Id", "ws")
		return req
	}
}

// Exercise the real authenticated handler, control-plane fetch, durable fence,
// and fallback response, including the CF wake path without a create request.
func TestStandaloneRestoreHandlerRetriesFetchSnapshotOnce(t *testing.T) {
	var fetches atomic.Int32
	s, restoreRequest := newStandaloneRestoreHandlerServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fresh" {
			t.Error("restore callback used wrong token")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			fetches.Add(1)
			_, _ = w.Write([]byte(`{"available":false,"reason":"No saved snapshot"}`))
		} else {
			_, _ = w.Write([]byte(`{}`))
		}
	})
	for range 3 {
		rec := httptest.NewRecorder()
		s.handleRestoreAgentSession(rec, restoreRequest(context.Background()))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "transcript-replay") {
			t.Fatalf("restore response = %d %s", rec.Code, rec.Body.String())
		}
	}
	if fetches.Load() != 1 {
		t.Fatalf("snapshot fetches = %d, want 1", fetches.Load())
	}
}

// The staging incident behind this test: a wake's restore installed the agent
// inside the restore request, the Cloudflare proxy answered 524 at 100 s, the
// cancelled request killed the install, and the attempt was cached "degraded"
// for a complete snapshot. The request going away must not reach the restore.
func TestRestoreHandlerKeepsRestoringAfterItsRequestIsCancelled(t *testing.T) {
	fetchStarted, releaseFetch := make(chan struct{}), make(chan struct{})
	var fetches atomic.Int32
	var fetchCancelled atomic.Bool
	s, restoreRequest := newStandaloneRestoreHandlerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if fetches.Add(1) == 1 {
			close(fetchStarted)
		}
		select {
		case <-releaseFetch:
		case <-r.Context().Done():
			fetchCancelled.Store(true)
			return
		}
		_, _ = w.Write([]byte(`{"available":false,"reason":"No saved snapshot"}`))
	})

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	handlerReturned := make(chan struct{})
	go func() {
		defer close(handlerReturned)
		s.handleRestoreAgentSession(httptest.NewRecorder(), restoreRequest(requestCtx))
	}()
	<-fetchStarted
	cancelRequest()
	select {
	case <-handlerReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("handler kept waiting on the restore after its request was cancelled")
	}

	close(releaseFetch)
	rec := httptest.NewRecorder()
	s.handleRestoreAgentSession(rec, restoreRequest(context.Background()))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "transcript-replay") {
		t.Fatalf("retry after cancelled request = %d %s, want the completed restore", rec.Code, rec.Body.String())
	}
	if fetchCancelled.Load() {
		t.Fatal("cancelling the request cancelled the restore's own control-plane fetch")
	}
	if fetches.Load() != 1 {
		t.Fatalf("snapshot fetches = %d, want 1: the retry must join the running restore", fetches.Load())
	}
}

// Outliving its request must not make a restore immortal: the attempt ends at
// the snapshot operation deadline and its waiters get a result.
func TestRestoreAttemptEndsAtTheSnapshotOperationDeadline(t *testing.T) {
	fetchCancelled := make(chan struct{})
	s, restoreRequest := newStandaloneRestoreHandlerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		<-r.Context().Done()
		close(fetchCancelled)
	})
	s.config.SessionSnapshotOperationTimeout = 50 * time.Millisecond

	responses := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		s.handleRestoreAgentSession(rec, restoreRequest(context.Background()))
		responses <- rec
	}()
	select {
	case rec := <-responses:
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), context.DeadlineExceeded.Error()) {
			t.Fatalf("restore past its deadline = %d %s, want an explicit deadline failure", rec.Code, rec.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the restore attempt outlived the snapshot operation deadline")
	}
	select {
	case <-fetchCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the restore's fetch outlived the snapshot operation deadline")
	}
}
