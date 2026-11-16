package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/workspace/vm-agent/internal/publish"
)

func TestSystemInfoExecutionSnapshotIsAuthenticatedAndUncached(t *testing.T) {
	fx := newDiagnosticAuthFixture(t)
	defer fx.stop()
	fx.server.sysInfoCollector = stubCollector(1, 20, 30)
	dir := t.TempDir()
	binary := filepath.Join(dir, "docker")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("SAM_DOCKER_CLI_PATH", binary)
	read := func(token string) (*httptest.ResponseRecorder, publish.ExecutionSnapshot) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/system-info", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		fx.server.handleSystemInfo(rec, req)
		var body struct {
			PublishExecution publish.ExecutionSnapshot `json:"publishExecution"`
		}
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("diagnostics can be cached")
			}
		}
		return rec, body.PublishExecution
	}
	for _, token := range []string{"", fx.workspaceMgmtA} {
		rec, _ := read(token)
		if rec.Code == http.StatusOK {
			t.Fatal("execution counters exposed without node authorization")
		}
	}
	rec, before := read(fx.nodeToken)
	if rec.Code != http.StatusOK || before.ProcessIncarnation == "" {
		t.Fatalf("snapshot unavailable: %d", rec.Code)
	}
	// A failed actual Save must be visible even while system metrics are cached.
	if err := publish.NewHostDocker().Save(context.Background(), "fixture", "unused"); err == nil {
		t.Fatal("expected failed save")
	}
	rec, after := read(fx.nodeToken)
	if rec.Code != http.StatusOK || after.ProcessIncarnation != before.ProcessIncarnation || after.DockerSaveAttempts != before.DockerSaveAttempts+1 {
		t.Fatalf("stale snapshot: %+v -> %+v", before, after)
	}
}
