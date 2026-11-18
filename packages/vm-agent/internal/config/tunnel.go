package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DefaultTunnelPort is the loopback port that a node's Cloudflare Tunnel
// connector forwards to (ingress service http://127.0.0.1:8444).
const DefaultTunnelPort = 8444

// TunnelHost is the only address the tunnel listener binds. It is deliberately
// not configurable: the listener is reachable only by the local connector, and
// binding it anywhere else would let a network peer skip the connector.
const TunnelHost = "127.0.0.1"

// TunnelConfig controls the dedicated ingress listener used by a node whose
// control-plane traffic arrives through a Cloudflare Tunnel connector.
//
// The zero value means "disabled", which is what legacy direct-IP nodes and
// Instant (cf-container) runtimes get when the variables are absent. The tunnel
// listener always serves plain HTTP (cloudflared terminates TLS at the edge);
// TLS_CERT_PATH/TLS_KEY_PATH apply only to the main listener, and tunnel nodes
// are provisioned without them.
type TunnelConfig struct {
	// Enabled starts the loopback tunnel listener (env: VM_AGENT_TUNNEL_ENABLED).
	Enabled bool
	// Port is the loopback port of the tunnel listener (env: VM_AGENT_TUNNEL_PORT).
	Port int
}

// Addr returns the listen address of the tunnel listener.
func (t TunnelConfig) Addr() string {
	return fmt.Sprintf("%s:%d", TunnelHost, t.Port)
}

// loadTunnelConfig parses the tunnel listener settings. Parsing is strict: a
// malformed value fails startup instead of falling back to a default, because a
// silently disabled listener leaves a tunnel node unreachable and a silently
// changed port leaves the connector pointing at nothing.
func loadTunnelConfig(agentPort int) (TunnelConfig, error) {
	cfg := TunnelConfig{Port: DefaultTunnelPort}

	if raw := strings.TrimSpace(os.Getenv("VM_AGENT_TUNNEL_ENABLED")); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		if err != nil {
			return TunnelConfig{}, fmt.Errorf("VM_AGENT_TUNNEL_ENABLED must be a boolean, got %q", raw)
		}
		cfg.Enabled = enabled
	}

	if raw := strings.TrimSpace(os.Getenv("VM_AGENT_TUNNEL_PORT")); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil {
			return TunnelConfig{}, fmt.Errorf("VM_AGENT_TUNNEL_PORT must be an integer, got %q", raw)
		}
		cfg.Port = port
	}

	if err := cfg.validate(agentPort); err != nil {
		return TunnelConfig{}, err
	}
	return cfg, nil
}

func (t TunnelConfig) validate(agentPort int) error {
	if !t.Enabled {
		return nil
	}
	if t.Port < 1 || t.Port > 65535 {
		return fmt.Errorf("VM_AGENT_TUNNEL_PORT must be 1-65535, got %d", t.Port)
	}
	if t.Port == agentPort {
		return fmt.Errorf("VM_AGENT_TUNNEL_PORT must differ from VM_AGENT_PORT (%d): the main listener serves the bearerless Docker Git helper and must never receive tunnel traffic", agentPort)
	}
	return nil
}
