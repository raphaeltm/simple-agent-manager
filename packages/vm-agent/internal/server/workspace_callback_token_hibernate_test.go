package server

// These tests drive the hibernate handler exactly as the control plane does after
// apps/api/src/services/node-agent-session-snapshots.ts started delivering a fresh
// workspace token with every VM hibernate request. They only use the handler, the
// node-management JWT helpers and a stub control plane, so the same file also runs
// against older VM-agent sources (the agents still on running nodes) unchanged.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

const (
	hibernateExpiredToken = "workspace-token-issued-at-create-and-now-expired"
	hibernateFreshToken   = "workspace-token-delivered-with-hibernate"
)

// snapshotCallbackRecorder is a control plane that accepts only the fresh token
// and records which token every snapshot callback presented.
type snapshotCallbackRecorder struct {
	mu     sync.Mutex
	tokens map[string][]string // callback suffix → bearer tokens
	done   chan struct{}
	once   sync.Once
}

func (rec *snapshotCallbackRecorder) serve(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	suffix := r.URL.Path
	if i := strings.Index(suffix, "/session-snapshot/"); i >= 0 {
		suffix = suffix[i:]
	}
	rec.mu.Lock()
	rec.tokens[suffix] = append(rec.tokens[suffix], token)
	rec.mu.Unlock()
	finish := func() { rec.once.Do(func() { close(rec.done) }) }

	if token != hibernateFreshToken {
		// A refused prepare ends the capture before a generation exists, so no
		// failure callback follows; a refused failure report ends it too.
		if strings.HasSuffix(suffix, "/prepare") || strings.HasSuffix(suffix, "/failure") {
			finish()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"UNAUTHORIZED","message":"Invalid or expired callback token"}`))
		return
	}
	switch {
	case strings.HasSuffix(suffix, "/session-snapshot/prepare"):
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"generation":"01GENERATION","config":{"totalBudgetBytes":67108864,"entryThresholdBytes":1048576,"transferIdleTimeoutMs":30000,"jsonBodyMaxBytes":262144},"upload":{"home":"/upload/home","wip":"/upload/wip"}}`))
	case strings.HasSuffix(suffix, "/session-snapshot/complete"):
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"available"}`))
		finish()
	case strings.HasSuffix(suffix, "/session-snapshot/failure"):
		finish()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (rec *snapshotCallbackRecorder) seen() map[string][]string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	out := make(map[string][]string, len(rec.tokens))
	for suffix, tokens := range rec.tokens {
		out[suffix] = append([]string(nil), tokens...)
	}
	return out
}

func hibernateRunGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// hibernateTestRepo is a clone of a bare remote with one pushed commit and
// uncommitted local work, the smallest workspace a capture can snapshot.
func hibernateTestRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	hibernateRunGit(t, root, "init", "--bare", "--initial-branch=main", remote)
	repo := filepath.Join(root, "repo")
	hibernateRunGit(t, root, "clone", remote, repo)
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hibernateRunGit(t, repo, "add", "README.md")
	hibernateRunGit(t, repo, "commit", "-m", "init")
	hibernateRunGit(t, repo, "push", "origin", "HEAD:main")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\nlocal work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return repo
}

// hibernateWithBody calls the real hibernate handler the way the control plane
// does (node-management JWT, background capture) and waits for the capture to
// report completion or failure.
func hibernateWithBody(t *testing.T, body string) map[string][]string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte("[user]\n\tname = t\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	rec := &snapshotCallbackRecorder{tokens: map[string][]string{}, done: make(chan struct{})}
	controlPlane := httptest.NewServer(http.HandlerFunc(rec.serve))
	defer controlPlane.Close()

	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s := &Server{
		config: &config.Config{
			Role:                                 config.RoleStandalone,
			NodeID:                               "node-1",
			ControlPlaneURL:                      controlPlane.URL,
			SessionSnapshotOperationTimeout:      time.Minute,
			SessionSnapshotProgressReportTimeout: 5 * time.Second,
		},
		jwtValidator: validator,
		workspaces: map[string]*WorkspaceRuntime{
			"ws-1": {ID: "ws-1", CallbackToken: hibernateExpiredToken, WorkspaceDir: hibernateTestRepo(t), Status: "running"},
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws-1/agent-sessions/agent-1/hibernate", bytes.NewBufferString(body))
	req.SetPathValue("workspaceId", "ws-1")
	req.SetPathValue("sessionId", "agent-1")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-1", "ws-1"))
	req.Header.Set("X-SAM-Node-Id", "node-1")
	req.Header.Set("X-SAM-Workspace-Id", "ws-1")
	recorder := httptest.NewRecorder()
	s.handleHibernateAgentSession(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("hibernate status = %d, want 202: %s", recorder.Code, recorder.Body.String())
	}
	select {
	case <-rec.done:
	case <-time.After(45 * time.Second):
		t.Fatalf("capture never reported completion or failure; callbacks seen: %v", rec.seen())
	}
	return rec.seen()
}

func TestHibernateDeliveredTokenAuthenticatesEverySnapshotCallback(t *testing.T) {
	seen := hibernateWithBody(t, `{"chatSessionId":"chat-1","runtime":"vm","agentType":"openai-codex","background":true,"workspaceCallbackToken":"`+hibernateFreshToken+`"}`)

	for _, callback := range []string{"/session-snapshot/prepare", "/session-snapshot/progress", "/session-snapshot/complete"} {
		if len(seen[callback]) == 0 {
			t.Fatalf("capture never reached %s; callbacks seen: %v", callback, seen)
		}
	}
	for callback, tokens := range seen {
		for _, token := range tokens {
			if token != hibernateFreshToken {
				t.Fatalf("%s authenticated with %q, want the token delivered with the hibernate request", callback, token)
			}
		}
	}
}

// Control: without the delivered token the capture uses the expired runtime
// token and fails at prepare, which is the production 401 loop. Proves the test
// above can observe the failure it guards against.
func TestHibernateWithoutDeliveredTokenFailsWithTheExpiredRuntimeToken(t *testing.T) {
	seen := hibernateWithBody(t, `{"chatSessionId":"chat-1","runtime":"vm","agentType":"openai-codex","background":true}`)

	prepare := seen["/session-snapshot/prepare"]
	if len(prepare) == 0 || prepare[0] != hibernateExpiredToken {
		t.Fatalf("prepare tokens = %v, want the expired runtime token", prepare)
	}
	if len(seen["/session-snapshot/complete"]) != 0 {
		t.Fatalf("capture completed without a valid token: %v", seen)
	}
}
