package server

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/secretexec"
)

func TestSecretExecRejectsBrowserAuthorization(t *testing.T) {
	s, _ := secretExecTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/mcp/secret-exec", strings.NewReader(`{}`))
	req.SetPathValue("workspaceId", "ws")
	rec := httptest.NewRecorder()
	s.handleMcpSecretExecStart(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rec.Code)
	}
}
func TestSecretExecDoesNotWakeMissingSession(t *testing.T) {
	s, key := secretExecTestServer(t)
	store, err := persistence.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s.store = store
	body, _ := json.Marshal(secretExecRequest{JobID: "sx-" + strings.Repeat("a", 64), Fingerprint: strings.Repeat("b", 64), SessionID: "missing", Argv: []string{"true"}})
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/mcp/secret-exec", bytes.NewReader(body))
	req.SetPathValue("workspaceId", "ws")
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws"))
	req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	s.handleMcpSecretExecStart(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "not active") {
		t.Fatalf("status %d bodyBytes=%d", rec.Code, rec.Body.Len())
	}
}
func TestSecretExecDurableStatusIsSessionScoped(t *testing.T) {
	s, key := secretExecTestServer(t)
	store, err := persistence.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s.store = store
	id := "sx-" + strings.Repeat("a", 64)
	result := secretExecSnapshot{JobID: id, Status: "completed", Result: secretexec.Result{Stdout: "[REDACTED]", Redacted: true}}
	raw, _ := json.Marshal(result)
	err = store.UpsertJob(persistence.JobRecord{ID: id, Kind: secretExecKind, ScopeID: secretExecScope("ws", "session"), Status: "completed", CompletedAt: "now", ResultJSON: string(raw)})
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range []string{"session", "other"} {
		req := httptest.NewRequest(http.MethodGet, "/workspaces/ws/mcp/secret-exec/"+id+"?agentSessionId="+session, nil)
		req.SetPathValue("workspaceId", "ws")
		req.SetPathValue("jobId", id)
		req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws"))
		req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
		req.Header.Set("X-SAM-Workspace-Id", "ws")
		rec := httptest.NewRecorder()
		s.handleMcpSecretExecStatus(rec, req)
		expected := 200
		if session == "other" {
			expected = 404
		}
		if rec.Code != expected {
			t.Fatalf("status %d bodyBytes=%d", rec.Code, rec.Body.Len())
		}
		if session == "session" && !strings.Contains(rec.Body.String(), "[REDACTED]") {
			t.Fatal("missing persisted result")
		}
	}
}
func TestSecretExecCancelReturnsRunningUntilCleanupFinishes(t *testing.T) {
	s, key := secretExecTestServer(t)
	store, err := persistence.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s.store = store
	id := "sx-" + strings.Repeat("a", 64)
	if err = store.UpsertJob(persistence.JobRecord{ID: id, Kind: secretExecKind, ScopeID: secretExecScope("ws", "session"), Status: "running"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.secretExecJobs = map[string]*secretExecState{id: {Snapshot: secretExecSnapshot{JobID: id, Status: "running"}, Cancel: cancel}}
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/mcp/secret-exec/"+id+"/cancel?agentSessionId=session", nil)
	req.SetPathValue("workspaceId", "ws")
	req.SetPathValue("jobId", id)
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws"))
	req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		s.handleMcpSecretExecCancel(rec, req)
		if rec.Code != 200 || ctx.Err() != context.Canceled || !strings.Contains(rec.Body.String(), "running") {
			t.Fatalf("status %d bodyBytes=%d", rec.Code, rec.Body.Len())
		}
	}
}
func TestSecretExecValidation(t *testing.T) {
	for _, req := range []secretExecRequest{
		{Argv: []string{"true"}, Command: new("true"), Shell: "sh"},
		{Command: new("true")},
		{Argv: []string{"true"}, Shell: "sh"},
		{Argv: []string{"true"}, Env: map[string]string{"INVALID-NAME": "x"}},
		{Argv: []string{"true"}, TimeoutMs: -1},
		{Argv: []string{"true"}, Env: map[string]string{"BASH_ENV": "synthetic"}},
		{Argv: []string{"true"}, SecretNames: []string{"ENV"}},
	} {
		req.JobID = "sx-" + strings.Repeat("a", 64)
		req.Fingerprint = strings.Repeat("b", 64)
		req.SessionID = "session"
		if validateSecretExecRequest(&req) == nil {
			t.Fatal("invalid request accepted")
		}
	}
}

func TestSecretExecAcceptedJobSurvivesRequestAndRetriesDoNotReplay(t *testing.T) {
	s, key := secretExecTestServer(t)
	store, err := persistence.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s.store = store
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "live"), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	s.secretExecContextResolver = func(context.Context, string, string) (string, string, string, error) { return "", "", dir, nil }
	id := "sx-" + strings.Repeat("d", 64)
	input := secretExecRequest{UserID: "synthetic-user", ProjectID: "synthetic-project", TaskID: "synthetic-task", JobID: id, SessionID: "session", Fingerprint: strings.Repeat("e", 64), Argv: []string{"sh", "-c", "sleep 0.1; test -f live && printf '%s' \"$SELECTED\"; printf x >> side-effect"}, SecretNames: []string{"SELECTED"}, ManagedEnv: []secretExecEnv{{Key: "SELECTED", Value: "synthetic-value", IsSecret: true}, {Key: "OTHER", Value: "__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__OTHER__", IsSecret: true}}, TimeoutMs: 1000}
	call := func(ctx context.Context, input secretExecRequest) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(input)
		req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/mcp/secret-exec", bytes.NewReader(raw)).WithContext(ctx)
		req.SetPathValue("workspaceId", "ws")
		req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, s.config.NodeID, "ws"))
		req.Header.Set("X-SAM-Node-Id", s.config.NodeID)
		req.Header.Set("X-SAM-Workspace-Id", "ws")
		rec := httptest.NewRecorder()
		s.handleMcpSecretExecStart(rec, req)
		return rec
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := call(ctx, input)
	cancel()
	if first.Code != 202 {
		t.Fatalf("start %d bodyBytes=%d", first.Code, first.Body.Len())
	}
	repeat := call(context.Background(), input)
	if repeat.Code != 200 {
		t.Fatalf("retry %d bodyBytes=%d", repeat.Code, repeat.Body.Len())
	}
	deadline := time.Now().Add(3 * time.Second)
	var job *persistence.JobRecord
	for time.Now().Before(deadline) {
		job, err = store.GetJob(id)
		if err != nil {
			t.Fatal(err)
		}
		if job.CompletedAt != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if job == nil || job.Status != "completed" || !strings.Contains(job.ResultJSON, "[REDACTED]") || strings.Contains(job.ResultJSON, "synthetic-value") {
		t.Fatal("persisted result did not meet status/redaction checks; output withheld")
	}
	var persisted secretExecSnapshot
	if err := json.Unmarshal([]byte(job.ResultJSON), &persisted); err != nil {
		t.Fatal("invalid persisted audit snapshot")
	}
	if persisted.Execution.ActorUserID != s.config.NodeID || persisted.Execution.WorkspaceID != "ws" || persisted.Execution.AgentSessionID != "session" || persisted.Execution.CommandMode != "argv" || persisted.Execution.StartedAt == "" || persisted.Execution.CompletedAt == "" || len(persisted.Execution.SecretNames) != 1 {
		t.Fatal("private audit metadata incomplete")
	}
	third := call(context.Background(), input)
	if third.Code != 200 {
		t.Fatalf("terminal retry %d bodyBytes=%d", third.Code, third.Body.Len())
	}
	sideEffect, err := os.ReadFile(filepath.Join(dir, "side-effect"))
	if err != nil || string(sideEffect) != "x" {
		t.Fatalf("job replayed: %q %v", sideEffect, err)
	}
	input.Fingerprint = strings.Repeat("f", 64)
	conflict := call(context.Background(), input)
	if conflict.Code != 409 {
		t.Fatalf("conflict %d bodyBytes=%d", conflict.Code, conflict.Body.Len())
	}
	if err := store.MarkActiveJobsInterrupted(); err != nil {
		t.Fatal(err)
	}
}

func secretExecTestServer(t *testing.T) (*Server, *rsa.PrivateKey) {
	t.Helper()
	s, key := mcpBuildTestServer(t)
	s.secretExecBaseEnv = []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir(), "LANG=C"}
	return s, key
}
