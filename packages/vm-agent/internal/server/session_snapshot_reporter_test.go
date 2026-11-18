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
	s.config.WorkspaceID = ws // the workspace this container launched for
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

// On a shared node the config describes the boot session. Restoring a different
// workspace must not bind its reporter, or persist its runtime, to that project;
// a workspace with its own project still primes (owner-path control).
func TestPrimeRestoredMessageReporter_OtherWorkspaceDoesNotBorrowBootProject(t *testing.T) {
	s, _ := newServerWithoutReporter(t)
	s.config.WorkspaceID = "ws-boot"
	s.config.ProjectID = "proj-boot"

	borrower := s.upsertWorkspaceRuntime("ws-prime-3", "org/repo", "main", "running", "ws-tok")
	s.primeRestoredMessageReporter(borrower, "chat-sess-3")
	if _, ok := s.messageReporters["ws-prime-3"]; ok {
		t.Error("reporter primed with the boot session's project")
	}
	if rt, _ := s.getWorkspaceRuntime("ws-prime-3"); rt.ProjectID != "" {
		t.Errorf("runtime.ProjectID = %q, want empty (boot project persisted onto another workspace)", rt.ProjectID)
	}

	owner := s.upsertWorkspaceRuntime("ws-prime-4", "org/repo", "main", "running", "ws-tok",
		workspaceRuntimeOpts{ProjectID: "proj-own"})
	s.primeRestoredMessageReporter(owner, "chat-sess-4")
	if _, ok := s.messageReporters["ws-prime-4"]; !ok {
		t.Fatal("workspace with its own project was not primed")
	}
	if rt, _ := s.getWorkspaceRuntime("ws-prime-4"); rt.ProjectID != "proj-own" {
		t.Errorf("runtime.ProjectID = %q, want proj-own", rt.ProjectID)
	}
}
