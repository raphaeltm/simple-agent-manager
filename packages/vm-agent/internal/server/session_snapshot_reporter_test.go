package server

import "testing"

// TestUpsertWorkspaceRuntime_PersistsWorkspaceCallbackToken covers the fix that
// lets a freshly-woken container authenticate its message + snapshot callbacks:
// the restore handler persists the workspace-scoped token from the request body
// via upsertWorkspaceRuntime, and it must then be returned by both
// callbackTokenForWorkspace (with node fallback) and workspaceCallbackToken
// (no fallback — used by the message reporter).
func TestUpsertWorkspaceRuntime_PersistsWorkspaceCallbackToken(t *testing.T) {
	s, _ := newServerWithoutReporter(t)
	s.config.CallbackToken = "node-scoped-token"
	ws := "ws-token-persist-1"

	// A fresh wake container starts with no workspace-scoped token; the snapshot
	// handler falls back to the node-scoped CALLBACK_TOKEN, and the no-fallback
	// workspaceCallbackToken is empty (which is why message replies would drop).
	s.upsertWorkspaceRuntime(ws, "org/repo", "main", "running", "")
	if got := s.callbackTokenForWorkspace(ws); got != "node-scoped-token" {
		t.Fatalf("callbackTokenForWorkspace before restore: expected node fallback, got %q", got)
	}
	if got := s.workspaceCallbackToken(ws); got != "" {
		t.Fatalf("workspaceCallbackToken before restore: expected empty, got %q", got)
	}

	// The restore handler persists the workspace-scoped token from the body.
	s.upsertWorkspaceRuntime(ws, "", "", "", "workspace-scoped-token")

	if got := s.callbackTokenForWorkspace(ws); got != "workspace-scoped-token" {
		t.Fatalf("callbackTokenForWorkspace after restore: expected workspace token, got %q", got)
	}
	if got := s.workspaceCallbackToken(ws); got != "workspace-scoped-token" {
		t.Fatalf("workspaceCallbackToken after restore: expected workspace token, got %q", got)
	}
}

// TestPrimeRestoredMessageReporter_CreatesReporter covers the fix that makes a
// restored agent's replies actually persist: the restore path must create/bind
// the per-workspace message reporter (the normal create-agent-session path does
// this; restore previously skipped it and replies were silently dropped).
func TestPrimeRestoredMessageReporter_CreatesReporter(t *testing.T) {
	s, _ := newServerWithoutReporter(t)
	s.config.ProjectID = "proj-restore-1" // set from PROJECT_ID env at launch
	ws := "ws-prime-1"
	rt := s.upsertWorkspaceRuntime(ws, "org/repo", "main", "running", "ws-tok")

	if len(s.messageReporters) != 0 {
		t.Fatalf("expected no reporter before priming, got %d", len(s.messageReporters))
	}

	s.primeRestoredMessageReporter(rt, "chat-sess-1")

	if _, ok := s.messageReporters[ws]; !ok {
		t.Fatal("expected message reporter to be primed after restore")
	}
	if rt.ProjectID != "proj-restore-1" {
		t.Fatalf("expected runtime.ProjectID to be set from config fallback, got %q", rt.ProjectID)
	}
}

// TestPrimeRestoredMessageReporter_NoOpWithoutProject verifies the guard: with
// no project context available (neither runtime nor config), the reporter is
// not created (and a warning is logged) rather than panicking.
func TestPrimeRestoredMessageReporter_NoOpWithoutProject(t *testing.T) {
	s, _ := newServerWithoutReporter(t) // config.ProjectID is empty
	ws := "ws-prime-2"
	rt := s.upsertWorkspaceRuntime(ws, "org/repo", "main", "running", "ws-tok")

	s.primeRestoredMessageReporter(rt, "chat-sess-2")

	if _, ok := s.messageReporters[ws]; ok {
		t.Fatal("expected no reporter when project context is unavailable")
	}
}
