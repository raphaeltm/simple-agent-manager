package config

import (
	"strings"
	"testing"
)

func setTunnelBaseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-123")
}

// Legacy direct-IP nodes and Instant containers set neither variable and must
// get no tunnel listener.
func TestTunnelConfigDisabledByDefault(t *testing.T) {
	setTunnelBaseEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Tunnel.Enabled {
		t.Fatal("tunnel listener enabled without VM_AGENT_TUNNEL_ENABLED")
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestTunnelConfigEnabledUsesDefaultLoopbackPort(t *testing.T) {
	setTunnelBaseEnv(t)
	t.Setenv("VM_AGENT_TUNNEL_ENABLED", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Tunnel.Enabled || cfg.Tunnel.Port != DefaultTunnelPort {
		t.Fatalf("Tunnel = %+v, want enabled on %d", cfg.Tunnel, DefaultTunnelPort)
	}
	if got := cfg.Tunnel.Addr(); got != "127.0.0.1:8444" {
		t.Fatalf("Addr() = %q, want 127.0.0.1:8444", got)
	}
}

func TestTunnelConfigPortOverride(t *testing.T) {
	setTunnelBaseEnv(t)
	t.Setenv("VM_AGENT_TUNNEL_ENABLED", "1")
	t.Setenv("VM_AGENT_TUNNEL_PORT", "9555")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Tunnel.Port != 9555 {
		t.Fatalf("Tunnel.Port = %d, want 9555", cfg.Tunnel.Port)
	}
}

// Malformed values fail startup instead of silently disabling the listener or
// moving it away from the port the connector forwards to.
func TestTunnelConfigRejectsInvalidValues(t *testing.T) {
	for _, tc := range []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{"malformed enabled flag", map[string]string{"VM_AGENT_TUNNEL_ENABLED": "yes please"}, "VM_AGENT_TUNNEL_ENABLED"},
		{"malformed port", map[string]string{"VM_AGENT_TUNNEL_ENABLED": "true", "VM_AGENT_TUNNEL_PORT": "84x4"}, "VM_AGENT_TUNNEL_PORT"},
		{"port out of range", map[string]string{"VM_AGENT_TUNNEL_ENABLED": "true", "VM_AGENT_TUNNEL_PORT": "70000"}, "1-65535"},
		{"port equals agent port", map[string]string{"VM_AGENT_TUNNEL_ENABLED": "true", "VM_AGENT_PORT": "8444"}, "must differ from VM_AGENT_PORT"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setTunnelBaseEnv(t)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Load error = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

// A disabled tunnel ignores its port, so an operator-set port on a legacy node
// cannot fail startup.
func TestTunnelConfigDisabledIgnoresPortCollision(t *testing.T) {
	setTunnelBaseEnv(t)
	t.Setenv("VM_AGENT_TUNNEL_ENABLED", "false")
	t.Setenv("VM_AGENT_PORT", "8444")

	if _, err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestValidateRejectsTunnelPortCollision(t *testing.T) {
	cfg := &Config{
		Port:            8080,
		ControlPlaneURL: "https://api.example.com",
		Tunnel:          TunnelConfig{Enabled: true, Port: 8080},
	}
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must differ from VM_AGENT_PORT") {
		t.Fatalf("Validate error = %v, want tunnel/agent port collision", err)
	}
}
