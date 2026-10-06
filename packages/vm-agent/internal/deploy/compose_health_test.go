package deploy

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServiceHealthy(t *testing.T) {
	cases := []struct {
		name string
		svc  ServiceState
		want bool
	}{
		{"running no healthcheck", ServiceState{Status: "running", Health: ""}, true},
		{"running healthy", ServiceState{Status: "running", Health: "healthy"}, true},
		{"running none", ServiceState{Status: "running", Health: "none"}, true},
		{"running unhealthy", ServiceState{Status: "running", Health: "unhealthy"}, false},
		{"running starting", ServiceState{Status: "running", Health: "starting"}, false},
		{"exited healthy", ServiceState{Status: "exited", Health: "healthy"}, false},
		{"restarting", ServiceState{Status: "restarting", Health: ""}, false},
	}
	for _, tc := range cases {
		if got := serviceHealthy(tc.svc); got != tc.want {
			t.Fatalf("%s: serviceHealthy=%v want %v", tc.name, got, tc.want)
		}
	}
}

func TestRoutedServicesHealthy_AllRequiredHealthy(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		{Service: "api", Status: "running", Health: "none"},
		{Service: "db", Status: "running", Health: "unhealthy"}, // not required, ignored
	}
	if !routedServicesHealthy(services, required) {
		t.Fatalf("expected all required services healthy")
	}
}

func TestRoutedServicesHealthy_OneRequiredUnhealthy(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		{Service: "api", Status: "running", Health: "starting"}, // not yet healthy
	}
	if routedServicesHealthy(services, required) {
		t.Fatalf("expected false while a required service is still starting")
	}
}

func TestRoutedServicesHealthy_MissingRequiredService(t *testing.T) {
	required := map[string]bool{"web": true, "api": true}
	services := []ServiceState{
		{Service: "web", Status: "running", Health: "healthy"},
		// api container not present at all
	}
	if routedServicesHealthy(services, required) {
		t.Fatalf("expected false when a required service has no container")
	}
}

func TestRoutedServicesHealthy_NoRequiredServices(t *testing.T) {
	// With no routed services, health gating is a no-op (vacuously true).
	if !routedServicesHealthy(nil, map[string]bool{}) {
		t.Fatalf("expected true when no services are required")
	}
}

func TestWaitForHealth_TimeoutWarnsWithRequiredServiceDiagnostics(t *testing.T) {
	const secret = "supersecretvalue123"

	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	composeScript := filepath.Join(dir, "compose.sh")
	if err := os.WriteFile(composeScript, []byte(`#!/bin/sh
case "$*" in
  *" ps --format json"*)
    echo '{"Name":"web-1","Service":"web","State":"running","Health":"healthy"}'
    echo '{"Name":"`+secret+`-api-1","Service":"api","State":"running","Health":"starting"}'
    echo '{"Name":"worker-1","Service":"worker","State":"running","Health":"starting"}'
    ;;
esac
exit 0
`), 0755); err != nil {
		t.Fatalf("write compose script: %v", err)
	}

	engine := NewEngine(disk, nil, EngineConfig{
		ComposeCmd:         composeScript,
		HealthTimeout:      30 * time.Millisecond,
		HealthPollInterval: 5 * time.Millisecond,
	})

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	err = engine.waitForHealth(context.Background(), 1, []RouteTarget{
		{Service: "web"},
		{Service: "api"},
		{Service: "frontend"},
	}, map[string]string{"SAM_SECRET_TOKEN": secret})
	if err == nil {
		t.Fatal("expected health timeout")
	}
	if !strings.Contains(err.Error(), "unhealthy routed services: api (state=running health=starting), frontend (state=missing health=missing)") {
		t.Fatalf("timeout error did not name unhealthy routed services: %v", err)
	}

	output := logs.String()
	for _, want := range []string{
		"deploy.health: timed out waiting for routed services",
		"requiredServices=\"[api frontend web]\"",
		"unhealthyServices=\"[api (state=running health=starting) frontend (state=missing health=missing)]\"",
		"Service:api",
		"State:missing",
		"deploy.health: final docker compose ps output",
		"[REDACTED]-api-1",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("expected log output to contain %q, got:\n%s", want, output)
		}
	}
	if strings.Contains(output, secret) {
		t.Fatalf("raw compose ps warning leaked interpolation secret: %s", output)
	}
	if strings.Contains(err.Error(), "worker") || strings.Contains(output, "unhealthyServices=\"[api (state=running health=starting) frontend (state=missing health=missing) worker") {
		t.Fatalf("non-routed worker should not be named as a gate blocker, got:\n%s", output)
	}
}
