package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

func TestPrepareWorkspaceEmitsCacheTimingOutcome(t *testing.T) {
	for _, terminal := range []string{"completed", "failed"} {
		t.Run(terminal, func(t *testing.T) {
			bin := t.TempDir()
			if err := os.WriteFile(filepath.Join(bin, "devcontainer"), []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, ".devcontainer.json"), []byte(`{"image":"test-image"}`), 0600); err != nil {
				t.Fatal(err)
			}
			cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"running"}`))
			}))
			defer cp.Close()
			cfg := &config.Config{WorkspaceID: "ws-cache-timing", ControlPlaneURL: cp.URL, CallbackToken: "callback", WorkspaceDir: dir, DevcontainerCacheEnabled: true}
			if terminal == "failed" {
				cfg.DevcontainerCacheRef = "cache.example/image:latest"
			} // Missing cache password is non-fatal.
			reporter := bootlog.New("", cfg.WorkspaceID)
			var statuses []string
			reporter.SetPhaseObserver(func(phase, status string) {
				if phase == "devcontainer_cache" {
					statuses = append(statuses, status)
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := PrepareWorkspace(ctx, cfg, ProvisionState{}, reporter); err != nil {
				t.Fatal(err)
			}
			if len(statuses) != 2 || statuses[0] != "started" || statuses[1] != terminal {
				t.Fatalf("cache timing must finish on %s: %v", terminal, statuses)
			}
		})
	}
}
