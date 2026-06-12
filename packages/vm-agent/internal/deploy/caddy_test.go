package deploy

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type parsedCaddyRoute struct {
	Hostname string
	Upstream string
}

func parseGeneratedCaddyfile(input string) []parsedCaddyRoute {
	lines := strings.Split(input, "\n")
	routes := make([]parsedCaddyRoute, 0)
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "#") || !strings.HasSuffix(line, "{") {
			continue
		}
		hostname := strings.TrimSpace(strings.TrimSuffix(line, "{"))
		route := parsedCaddyRoute{Hostname: hostname}
		for i++; i < len(lines); i++ {
			inner := strings.TrimSpace(lines[i])
			if inner == "}" {
				break
			}
			if strings.HasPrefix(inner, "reverse_proxy ") {
				route.Upstream = strings.TrimSpace(strings.TrimPrefix(inner, "reverse_proxy "))
			}
		}
		routes = append(routes, route)
	}
	return routes
}

func TestGenerateCaddyfile_RoundTripsMultiRouteConfig(t *testing.T) {
	routes := []RouteTarget{
		{Hostname: "r2-api-env123.apps.example.com", Service: "api", ContainerPort: 8080, HostPort: 35001},
		{Hostname: "r1-web-env123.apps.example.com", Service: "web", ContainerPort: 3000, HostPort: 35000},
	}

	caddyfile, err := GenerateCaddyfile(routes)
	if err != nil {
		t.Fatalf("GenerateCaddyfile: %v", err)
	}
	parsed := parseGeneratedCaddyfile(caddyfile)

	if len(parsed) != 2 {
		t.Fatalf("expected 2 parsed routes, got %d: %#v\n%s", len(parsed), parsed, caddyfile)
	}
	if parsed[0].Hostname != "r1-web-env123.apps.example.com" {
		t.Fatalf("routes should be sorted by hostname, got first host %q", parsed[0].Hostname)
	}
	if parsed[0].Upstream != "127.0.0.1:35000" {
		t.Fatalf("unexpected first upstream %q", parsed[0].Upstream)
	}
	if parsed[1].Hostname != "r2-api-env123.apps.example.com" {
		t.Fatalf("unexpected second host %q", parsed[1].Hostname)
	}
	if parsed[1].Upstream != "127.0.0.1:35001" {
		t.Fatalf("unexpected second upstream %q", parsed[1].Upstream)
	}

	roundTrip := make([]RouteTarget, 0, len(parsed))
	for _, route := range parsed {
		_, portText, ok := strings.Cut(route.Upstream, ":")
		if !ok {
			t.Fatalf("upstream missing port: %q", route.Upstream)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			t.Fatalf("parse upstream port: %v", err)
		}
		roundTrip = append(roundTrip, RouteTarget{Hostname: route.Hostname, HostPort: port})
	}

	if len(roundTrip) != len(routes) {
		t.Fatalf("roundtrip route count mismatch")
	}
}

func TestReloadCaddy_AtomicallyWritesActiveConfigAndInvokesReload(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{Seq: 1, EnvironmentID: "env", NodeID: "node", Status: StatusApplying}
	caddyfile, err := GenerateCaddyfile([]RouteTarget{{Hostname: "app.apps.example.com", ContainerPort: 3000, HostPort: 35000}})
	if err != nil {
		t.Fatalf("GenerateCaddyfile: %v", err)
	}
	if err := disk.WriteRelease(state, "compose", caddyfile); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "reload.sh")
	if err := os.WriteFile(reloadScript, []byte("#!/bin/sh\necho reloaded > \"$1\"\n"), 0755); err != nil {
		t.Fatalf("write reload script: %v", err)
	}
	engine := NewEngine(disk, nil, EngineConfig{
		CaddyfilePath:  filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd: reloadScript + " " + reloadLog,
	})
	if err := engine.reloadCaddy(t.Context(), disk.CaddyfilePath(1)); err != nil {
		t.Fatalf("reloadCaddy: %v", err)
	}

	active, err := os.ReadFile(engine.cfg.CaddyfilePath)
	if err != nil {
		t.Fatalf("read active Caddyfile: %v", err)
	}
	if string(active) != caddyfile {
		t.Fatalf("active Caddyfile mismatch: %q", string(active))
	}
	logBytes, err := os.ReadFile(reloadLog)
	if err != nil {
		t.Fatalf("reload command did not run: %v", err)
	}
	if strings.TrimSpace(string(logBytes)) != "reloaded" {
		t.Fatalf("unexpected reload log %q", string(logBytes))
	}
}

func TestReloadCaddy_ReturnsReloadFailure(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{Seq: 1, EnvironmentID: "env", NodeID: "node", Status: StatusApplying}
	if err := disk.WriteRelease(state, "compose", "app.apps.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	engine := NewEngine(disk, nil, EngineConfig{
		CaddyfilePath:  filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd: "false",
	})

	err = engine.reloadCaddy(t.Context(), disk.CaddyfilePath(1))
	if err == nil {
		t.Fatal("expected reload failure")
	}
	if !strings.Contains(err.Error(), "false") {
		t.Fatalf("expected command in error, got %v", err)
	}
}

func TestReloadCaddy_WaitsForReloadCommandToExist(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}
	state := &ReleaseState{Seq: 1, EnvironmentID: "env", NodeID: "node", Status: StatusApplying}
	if err := disk.WriteRelease(state, "compose", "app.apps.example.com {\n\treverse_proxy 127.0.0.1:35000\n}\n"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	reloadLog := filepath.Join(dir, "reload.log")
	reloadScript := filepath.Join(dir, "delayed-caddy")
	engine := NewEngine(disk, nil, EngineConfig{
		CaddyfilePath:      filepath.Join(dir, "active", "Caddyfile"),
		CaddyReloadCmd:     reloadScript + " " + reloadLog,
		CaddyReadyTimeout:  2 * time.Second,
		CaddyReadyInterval: 10 * time.Millisecond,
	})

	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = os.WriteFile(reloadScript, []byte("#!/bin/sh\necho delayed > \"$1\"\n"), 0755)
	}()

	if err := engine.reloadCaddy(t.Context(), disk.CaddyfilePath(1)); err != nil {
		t.Fatalf("reloadCaddy: %v", err)
	}
	logBytes, err := os.ReadFile(reloadLog)
	if err != nil {
		t.Fatalf("reload command did not run: %v", err)
	}
	if strings.TrimSpace(string(logBytes)) != "delayed" {
		t.Fatalf("unexpected reload log %q", string(logBytes))
	}
}

func TestGenerateCaddyfile_RejectsUnsafeRouteTargets(t *testing.T) {
	tests := []struct {
		name  string
		route RouteTarget
	}{
		{
			name: "hostname with caddyfile injection",
			route: RouteTarget{
				Hostname:      "app.example.com {\nrespond hacked\n}",
				Service:       "web",
				ContainerPort: 3000,
				HostPort:      35000,
			},
		},
		{
			name: "invalid host port",
			route: RouteTarget{
				Hostname:      "app.example.com",
				Service:       "web",
				ContainerPort: 3000,
				HostPort:      70000,
			},
		},
		{
			name: "invalid container port",
			route: RouteTarget{
				Hostname:      "app.example.com",
				Service:       "web",
				ContainerPort: 0,
				HostPort:      35000,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := GenerateCaddyfile([]RouteTarget{tc.route}); err == nil {
				t.Fatal("expected invalid route target to be rejected")
			}
		})
	}
}
