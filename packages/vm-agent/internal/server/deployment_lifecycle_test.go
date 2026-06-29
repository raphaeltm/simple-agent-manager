package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/deploy"
)

func TestHandleTeardownDeploymentEnvironment(t *testing.T) {
	dir := t.TempDir()
	disk, err := deploy.NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	if err := disk.WriteRelease(
		&deploy.ReleaseState{Seq: 4, EnvironmentID: "env-1", NodeID: "node-1", Status: deploy.StatusApplied},
		"services: {}\n",
		"env-1.apps.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n",
	); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}
	if err := disk.SetCurrent(4); err != nil {
		t.Fatalf("SetCurrent: %v", err)
	}

	activeDir := filepath.Join(dir, "active")
	sitesDir := filepath.Join(activeDir, "sites")
	if err := os.MkdirAll(sitesDir, 0755); err != nil {
		t.Fatalf("mkdir sites: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sitesDir, "env-1.caddy"), []byte("env-1"), 0644); err != nil {
		t.Fatalf("write env snippet: %v", err)
	}

	composeLog := filepath.Join(dir, "compose.log")
	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$COMPOSE_LOG\"\n"), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}
	t.Setenv("COMPOSE_LOG", composeLog)

	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	engine := deploy.NewEngine(disk, nil, deploy.EngineConfig{
		EnvironmentID:      "env-1",
		NodeID:             "node-1",
		ComposeCmd:         composeScript,
		ComposeProjectName: "sam-env-env-1",
		CaddyfilePath:      filepath.Join(activeDir, "Caddyfile"),
		CaddyReloadCmd:     reloadScript,
	})
	s := &Server{
		config: &config.Config{
			Role:          config.RoleDeployment,
			NodeID:        "node-1",
			DeployBaseDir: filepath.Join(dir, "deploy"),
		},
		jwtValidator:  validator,
		deployEngines: map[string]*deploy.Engine{"env-1": engine},
		deployRetiring: map[string]bool{
			"env-1": true,
		},
	}

	mux := http.NewServeMux()
	s.setupRoutes(mux)
	req := httptest.NewRequest(http.MethodPost, "/deployment/environments/env-1/teardown", nil)
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-1", ""))
	req.Header.Set("X-SAM-Node-Id", "node-1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(sitesDir, "env-1.caddy")); !os.IsNotExist(err) {
		t.Fatalf("expected active Caddy snippet removed, stat err=%v", err)
	}
	composeArgs, err := os.ReadFile(composeLog)
	if err != nil {
		t.Fatalf("read compose log: %v", err)
	}
	if !strings.Contains(string(composeArgs), "\ndown\n") {
		t.Fatalf("expected compose down, got:\n%s", composeArgs)
	}
	currentSeq, err := disk.CurrentSeq()
	if err != nil {
		t.Fatalf("CurrentSeq: %v", err)
	}
	if currentSeq != 0 {
		t.Fatalf("expected teardown to clear current release, got seq %d", currentSeq)
	}
	if _, ok := s.deployEngines["env-1"]; ok {
		t.Fatal("expected torn down deploy engine removed from server map")
	}
	if s.deployRetiring["env-1"] {
		t.Fatal("expected retiring marker cleared")
	}
}

func TestHandleTeardownDeploymentEnvironmentRejectsWorkspaceNode(t *testing.T) {
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s := &Server{
		config: &config.Config{
			Role:   config.RoleWorkspace,
			NodeID: "node-1",
		},
		jwtValidator: validator,
	}
	req := httptest.NewRequest(http.MethodPost, "/deployment/environments/env-1/teardown", nil)
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-1", ""))
	req.Header.Set("X-SAM-Node-Id", "node-1")
	rec := httptest.NewRecorder()

	s.handleTeardownDeploymentEnvironment(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleTeardownDeploymentEnvironmentRejectsUnknownEnvironment(t *testing.T) {
	dir := t.TempDir()
	validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
	s := &Server{
		config: &config.Config{
			Role:          config.RoleDeployment,
			NodeID:        "node-1",
			DeployBaseDir: filepath.Join(dir, "deploy"),
		},
		jwtValidator:  validator,
		deployEngines: map[string]*deploy.Engine{},
	}

	mux := http.NewServeMux()
	s.setupRoutes(mux)
	req := httptest.NewRequest(http.MethodPost, "/deployment/environments/env-unknown/teardown", nil)
	req.Header.Set("Authorization", "Bearer "+signWorkspaceCreateNodeToken(t, key, "node-1", ""))
	req.Header.Set("X-SAM-Node-Id", "node-1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}
