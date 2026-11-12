package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Defaults. Every one is overridable from the environment (compose passes the box .env).
const (
	DefaultListenAddr = ":25"
	// Same as the Worker's agentEmail.maxInboundBytes default (DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES,
	// packages/shared/src/constants/agent-email.ts). The Worker re-checks its own (admin-editable)
	// limit, so this is the receiver's memory bound, not the policy.
	DefaultMaxMessageBytes = 5 * 1024 * 1024
	// 20 x 5 MiB messages in flight stays well inside the container's memory limit
	// (docker-compose.yml mem_limit), with room for the copies the checks make.
	DefaultMaxConnections      = 20
	DefaultMaxConnectionsPerIP = 3
	// New connections per client address per minute.
	DefaultConnectionsPerIPPerMinute = 30
	// Distinct client addresses tracked per minute; beyond it new addresses are refused (421)
	// until the window rolls, so a spoofed-source flood cannot grow memory without bound.
	DefaultMaxTrackedIPs   = 10000
	DefaultMessagesPerConn = 10
	DefaultReadTimeout     = 60 * time.Second
	DefaultWriteTimeout    = 60 * time.Second
	DefaultDNSTimeout      = 20 * time.Second
	// RFC 5321 4.5.3.2.6 gives a server 10 minutes after the end of DATA. A cold celld isolate can
	// hang a request for about 300 s (tasks/backlog/2026-11-11-selfhost-celld-cold-isolate-abort-hang.md),
	// so the gateway call gets most of that window; a timeout answers 451 and the sender retries.
	DefaultGatewayTimeout = 540 * time.Second
	DefaultMaxLineLength  = 2000
	// Absolute bound on one connection: above DATA, DNS and the gateway timeout together.
	DefaultMaxSessionDuration = 15 * time.Minute
)

// Agent address shape, mirroring apps/api/src/services/agent-email/address.ts and the shared
// constants (AGENT_EMAIL_LOCAL_PART, AGENT_EMAIL_ADDRESS_KEY_LENGTH, LOOPBACK_DETAIL). The Worker
// re-validates every address; this only refuses obvious strangers at RCPT time.
const (
	agentLocalPart       = "agent"
	agentAddressKeyChars = "0123456789abcdefghjkmnpqrstvwxyz"
	agentAddressKeyLen   = 16
	loopbackDetail       = "loopback"
)

type Config struct {
	ListenAddr          string
	Hostname            string
	Domain              string
	GatewayURL          *url.URL
	APIHost             string
	GatewaySecret       string
	MaxMessageBytes     int64
	MaxConnections      int
	MaxConnectionsPerIP int
	MaxSessionDuration  time.Duration
	ConnPerIPPerMin     int
	MaxTrackedIPs       int
	MessagesPerConn     int
	ReadTimeout         time.Duration
	WriteTimeout        time.Duration
	DNSTimeout          time.Duration
	GatewayTimeout      time.Duration
	TrustedNetworks     []*net.IPNet
	TLSCertFile         string
	TLSKeyFile          string
}

// minGatewaySecretLength matches the Worker's floor (node-reverse-tunnel-config.ts): a shorter
// secret makes every gateway route answer 404, so refusing it here gives a clear startup error.
const minGatewaySecretLength = 32

func envOr(get func(string) string, name, fallback string) string {
	if v := strings.TrimSpace(get(name)); v != "" {
		return v
	}
	return fallback
}

func positiveInt(get func(string) string, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return v, nil
}

func positiveDuration(get func(string) string, name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(get(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration such as 30s", name)
	}
	return v, nil
}

// ParseTrustedNetworks reads a comma-separated CIDR list. Mail from these networks skips
// SPF/DKIM/DMARC: it is for injecting test mail on the box's own loopback, never for the internet.
func ParseTrustedNetworks(raw string) ([]*net.IPNet, error) {
	var nets []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("SAM_MX_TRUSTED_NETWORKS: %q is not a CIDR", part)
		}
		ones, _ := n.Mask.Size()
		if !n.IP.IsLoopback() || ones < 8 {
			// A trusted network bypasses sender authentication; only the box itself qualifies.
			return nil, fmt.Errorf("SAM_MX_TRUSTED_NETWORKS: %q is not a loopback network", part)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

func LoadConfig(get func(string) string) (*Config, error) {
	samDomain := strings.ToLower(strings.TrimSpace(get("SAM_DOMAIN")))
	if samDomain == "" {
		return nil, fmt.Errorf("SAM_DOMAIN is required")
	}
	cfg := &Config{
		ListenAddr:    envOr(get, "SAM_MX_LISTEN", DefaultListenAddr),
		Hostname:      envOr(get, "SAM_MX_HOSTNAME", "mx."+samDomain),
		Domain:        "agents." + samDomain,
		APIHost:       "api." + samDomain,
		GatewaySecret: strings.TrimSpace(get("REVERSE_TUNNEL_GATEWAY_SECRET")),
		TLSCertFile:   strings.TrimSpace(get("SAM_MX_TLS_CERT")),
		TLSKeyFile:    strings.TrimSpace(get("SAM_MX_TLS_KEY")),
	}
	if len(cfg.GatewaySecret) < minGatewaySecretLength {
		return nil, fmt.Errorf("REVERSE_TUNNEL_GATEWAY_SECRET must be set (at least %d characters)", minGatewaySecretLength)
	}
	celldPort, err := positiveInt(get, "CELLD_PORT", 8080)
	if err != nil {
		return nil, err
	}
	gw := envOr(get, "SAM_MX_GATEWAY_URL", fmt.Sprintf("http://127.0.0.1:%d/api/self-host/gateway/inbound-email", celldPort))
	cfg.GatewayURL, err = url.Parse(gw)
	if err != nil || cfg.GatewayURL.Scheme != "http" || cfg.GatewayURL.Hostname() == "" {
		return nil, fmt.Errorf("SAM_MX_GATEWAY_URL must be an http:// URL")
	}
	if ip := net.ParseIP(cfg.GatewayURL.Hostname()); ip == nil || !ip.IsLoopback() {
		// The gateway secret travels in clear HTTP: loopback only.
		return nil, fmt.Errorf("SAM_MX_GATEWAY_URL must name a loopback address")
	}
	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return nil, fmt.Errorf("set both SAM_MX_TLS_CERT and SAM_MX_TLS_KEY, or neither")
	}
	maxBytes, err := positiveInt(get, "SAM_MX_MAX_MESSAGE_BYTES", DefaultMaxMessageBytes)
	if err != nil {
		return nil, err
	}
	cfg.MaxMessageBytes = int64(maxBytes)
	if cfg.MaxConnections, err = positiveInt(get, "SAM_MX_MAX_CONNECTIONS", DefaultMaxConnections); err != nil {
		return nil, err
	}
	if cfg.MaxConnectionsPerIP, err = positiveInt(get, "SAM_MX_MAX_CONNECTIONS_PER_IP", DefaultMaxConnectionsPerIP); err != nil {
		return nil, err
	}
	if cfg.MaxSessionDuration, err = positiveDuration(get, "SAM_MX_MAX_SESSION", DefaultMaxSessionDuration); err != nil {
		return nil, err
	}
	if cfg.ConnPerIPPerMin, err = positiveInt(get, "SAM_MX_CONNECTIONS_PER_IP_PER_MINUTE", DefaultConnectionsPerIPPerMinute); err != nil {
		return nil, err
	}
	if cfg.MaxTrackedIPs, err = positiveInt(get, "SAM_MX_MAX_TRACKED_IPS", DefaultMaxTrackedIPs); err != nil {
		return nil, err
	}
	if cfg.MessagesPerConn, err = positiveInt(get, "SAM_MX_MESSAGES_PER_CONNECTION", DefaultMessagesPerConn); err != nil {
		return nil, err
	}
	if cfg.ReadTimeout, err = positiveDuration(get, "SAM_MX_READ_TIMEOUT", DefaultReadTimeout); err != nil {
		return nil, err
	}
	if cfg.WriteTimeout, err = positiveDuration(get, "SAM_MX_WRITE_TIMEOUT", DefaultWriteTimeout); err != nil {
		return nil, err
	}
	if cfg.DNSTimeout, err = positiveDuration(get, "SAM_MX_DNS_TIMEOUT", DefaultDNSTimeout); err != nil {
		return nil, err
	}
	if cfg.GatewayTimeout, err = positiveDuration(get, "SAM_MX_GATEWAY_TIMEOUT", DefaultGatewayTimeout); err != nil {
		return nil, err
	}
	if cfg.TrustedNetworks, err = ParseTrustedNetworks(get("SAM_MX_TRUSTED_NETWORKS")); err != nil {
		return nil, err
	}
	return cfg, nil
}

// LoadConfigFromEnv reads the process environment.
func LoadConfigFromEnv() (*Config, error) { return LoadConfig(os.Getenv) }

// IsAgentRecipient reports whether addr has the shape of an agent address on this install.
func (c *Config) IsAgentRecipient(addr string) bool {
	addr = strings.ToLower(strings.TrimSpace(addr))
	at := strings.LastIndex(addr, "@")
	if at <= 0 || addr[at+1:] != c.Domain {
		return false
	}
	local := addr[:at]
	prefix := agentLocalPart + "+"
	if !strings.HasPrefix(local, prefix) {
		return false
	}
	detail := local[len(prefix):]
	if detail == loopbackDetail {
		return true
	}
	if len(detail) != agentAddressKeyLen {
		return false
	}
	for _, r := range detail {
		if !strings.ContainsRune(agentAddressKeyChars, r) {
			return false
		}
	}
	return true
}

func (c *Config) IsTrusted(ip net.IP) bool {
	for _, n := range c.TrustedNetworks {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
