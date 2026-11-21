package main

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/miekg/dns"
)

// Defaults. Every one is overridable from the environment (compose passes the box .env).
const (
	// "auto": every non-loopback address of the host, each bound separately. A wildcard
	// 0.0.0.0:53 would collide with systemd-resolved's 127.0.0.53:53 stub on most distributions.
	DefaultListen       = "auto"
	DefaultListenPort   = 53
	DefaultUpdateListen = "127.0.0.1:8053"
	// One hour: app-route names now depend on the box being up, so resolvers should keep answers
	// across a short outage. A route that moves to another node is re-pointed within this TTL.
	DefaultTTL = 3600
	// SOA minimum: how long resolvers cache "no such name".
	DefaultNegativeTTL = 300
	// ACME challenge TXT records are served with a short TTL; Let's Encrypt queries authoritatively.
	DefaultChallengeTTL = 60
	// A challenge record nobody deleted (Caddy crashed mid-order) disappears after this.
	DefaultChallengeMaxAge = time.Hour
	// Bounds the challenge store, so a holder of the TSIG key cannot grow memory without limit.
	DefaultMaxChallengeNames  = 50
	DefaultMaxChallengeValues = 10
	DefaultTSIGKeyName        = "sam-acme."
	DefaultTSIGFudge          = 300
	// Sync: one cheap serial read every interval; a full paged read only when the serial changed.
	DefaultSyncInterval = 5 * time.Second
	DefaultSyncPageSize = 500
	// A full sync is bounded by time, not by page count (rule 81): at the protocol ceiling of 1000
	// records a page, 60 s covers far more records than a box will ever hold.
	DefaultSyncDeadline   = 60 * time.Second
	DefaultGatewayTimeout = 10 * time.Second
	// Response rate limit per client prefix (/24 IPv4, /56 IPv6), in responses per second.
	DefaultRateLimit = 20
	DefaultRateBurst = 40
	// Prefixes tracked at once; past it, new prefixes are limited as one shared bucket.
	DefaultRateTrackedPrefixes = 50000
	// Every Nth limited UDP response is sent truncated (TC) so a real resolver retries over TCP.
	DefaultRateSlip = 2
	// Largest UDP answer: the DNS flag day 2020 value; larger answers are truncated.
	DefaultMaxUDPSize          = 1232
	DefaultTCPMaxConnections   = 256
	DefaultTCPMaxConnectionsIP = 8
	DefaultTCPIdleTimeout      = 5 * time.Second
	DefaultTCPMaxQueries       = 100
	DefaultShutdownGrace       = 3 * time.Second
)

// minGatewaySecretLength matches the Worker's floor (reverse-tunnel/config.ts).
const minGatewaySecretLength = 32

// minTSIGSecretBytes: HMAC-SHA256 keys shorter than the hash are refused (RFC 8945 section 6).
const minTSIGSecretBytes = 32

type Config struct {
	Zone            string // FQDN, lowercase, trailing dot
	PublicIPv4      net.IP
	PublicIPv6      net.IP // optional
	Listen          []string
	UpdateListen    string
	TTL             uint32
	NegativeTTL     uint32
	ChallengeTTL    uint32
	ChallengeMaxAge time.Duration
	MaxChallengeNames,
	MaxChallengeValues int
	TSIGKeyName       string // FQDN
	TSIGSecret        string // base64, as miekg/dns expects
	GatewayURL        *url.URL
	APIHost           string
	GatewaySecret     string
	SyncInterval      time.Duration
	SyncPageSize      int
	SyncDeadline      time.Duration
	GatewayTimeout    time.Duration
	CacheFile         string // optional
	RateLimit         int
	RateBurst         int
	RateTracked       int
	RateSlip          int
	MaxUDPSize        int
	TCPMaxConnections int
	TCPMaxPerIP       int
	TCPIdleTimeout    time.Duration
	TCPMaxQueries     int
	ShutdownGrace     time.Duration
}

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

// LoadConfig reads the configuration through get (os.Getenv in production) and refuses anything
// that would weaken the trust boundary: an update listener off loopback, a short TSIG key.
func LoadConfig(get func(string) string) (*Config, error) {
	cfg := &Config{}
	domain := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(get("SAM_DOMAIN")), "."))
	if domain == "" || strings.Contains(domain, "/") {
		return nil, fmt.Errorf("SAM_DOMAIN is required")
	}
	if _, ok := dns.IsDomainName(domain); !ok {
		return nil, fmt.Errorf("SAM_DOMAIN %q is not a domain name", domain)
	}
	cfg.Zone = dns.Fqdn(domain)

	cfg.PublicIPv4 = net.ParseIP(strings.TrimSpace(get("SAM_DNS_PUBLIC_IPV4"))).To4()
	if cfg.PublicIPv4 == nil {
		return nil, fmt.Errorf("SAM_DNS_PUBLIC_IPV4 must be the box's public IPv4 address (the glue record)")
	}
	if raw := strings.TrimSpace(get("SAM_DNS_PUBLIC_IPV6")); raw != "" {
		ip := net.ParseIP(raw)
		if ip == nil || ip.To4() != nil {
			return nil, fmt.Errorf("SAM_DNS_PUBLIC_IPV6 must be an IPv6 address")
		}
		cfg.PublicIPv6 = ip
	}

	listen, err := parseListen(envOr(get, "SAM_DNS_LISTEN", DefaultListen))
	if err != nil {
		return nil, err
	}
	cfg.Listen = listen

	cfg.UpdateListen = envOr(get, "SAM_DNS_UPDATE_LISTEN", DefaultUpdateListen)
	host, port, err := net.SplitHostPort(cfg.UpdateListen)
	if err != nil || port == "" {
		return nil, fmt.Errorf("SAM_DNS_UPDATE_LISTEN must be host:port")
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		// The update channel is only for Caddy on this box (threat model: never the public 53).
		return nil, fmt.Errorf("SAM_DNS_UPDATE_LISTEN must be a loopback address, got %q", host)
	}

	secret, err := base64.StdEncoding.DecodeString(strings.TrimSpace(get("SAM_DNS_TSIG_SECRET")))
	if err != nil || len(secret) < minTSIGSecretBytes {
		return nil, fmt.Errorf("SAM_DNS_TSIG_SECRET must be base64 of at least %d bytes (written by pnpm selfhost:deploy)", minTSIGSecretBytes)
	}
	cfg.TSIGSecret = base64.StdEncoding.EncodeToString(secret)
	cfg.TSIGKeyName = dns.CanonicalName(envOr(get, "SAM_DNS_TSIG_KEY_NAME", DefaultTSIGKeyName))

	cfg.GatewaySecret = strings.TrimSpace(get("REVERSE_TUNNEL_GATEWAY_SECRET"))
	if len(cfg.GatewaySecret) < minGatewaySecretLength {
		return nil, fmt.Errorf("REVERSE_TUNNEL_GATEWAY_SECRET is missing or shorter than %d characters", minGatewaySecretLength)
	}
	celldPort, err := positiveInt(get, "CELLD_PORT", 8080)
	if err != nil || celldPort > 65535 {
		return nil, fmt.Errorf("CELLD_PORT must be a port number")
	}
	cfg.GatewayURL = &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(celldPort)), Path: "/api/self-host/gateway/dns-records"}
	cfg.APIHost = "api." + domain

	ints := []struct {
		name     string
		fallback int
		target   *int
	}{
		{"SAM_DNS_MAX_CHALLENGE_NAMES", DefaultMaxChallengeNames, &cfg.MaxChallengeNames},
		{"SAM_DNS_MAX_CHALLENGE_VALUES", DefaultMaxChallengeValues, &cfg.MaxChallengeValues},
		{"SAM_DNS_SYNC_PAGE_SIZE", DefaultSyncPageSize, &cfg.SyncPageSize},
		{"SAM_DNS_RATE_LIMIT", DefaultRateLimit, &cfg.RateLimit},
		{"SAM_DNS_RATE_BURST", DefaultRateBurst, &cfg.RateBurst},
		{"SAM_DNS_RATE_TRACKED_PREFIXES", DefaultRateTrackedPrefixes, &cfg.RateTracked},
		{"SAM_DNS_RATE_SLIP", DefaultRateSlip, &cfg.RateSlip},
		{"SAM_DNS_MAX_UDP_SIZE", DefaultMaxUDPSize, &cfg.MaxUDPSize},
		{"SAM_DNS_TCP_MAX_CONNECTIONS", DefaultTCPMaxConnections, &cfg.TCPMaxConnections},
		{"SAM_DNS_TCP_MAX_CONNECTIONS_PER_IP", DefaultTCPMaxConnectionsIP, &cfg.TCPMaxPerIP},
		{"SAM_DNS_TCP_MAX_QUERIES", DefaultTCPMaxQueries, &cfg.TCPMaxQueries},
	}
	for _, spec := range ints {
		v, err := positiveInt(get, spec.name, spec.fallback)
		if err != nil {
			return nil, err
		}
		*spec.target = v
	}
	if cfg.SyncPageSize > 1000 {
		return nil, fmt.Errorf("SAM_DNS_SYNC_PAGE_SIZE must be at most 1000 (the gateway's page ceiling)")
	}
	if cfg.MaxUDPSize < dns.MinMsgSize || cfg.MaxUDPSize > 4096 {
		return nil, fmt.Errorf("SAM_DNS_MAX_UDP_SIZE must be between %d and 4096", dns.MinMsgSize)
	}

	ttls := []struct {
		name     string
		fallback int
		target   *uint32
	}{
		{"SAM_DNS_TTL", DefaultTTL, &cfg.TTL},
		{"SAM_DNS_NEGATIVE_TTL", DefaultNegativeTTL, &cfg.NegativeTTL},
		{"SAM_DNS_CHALLENGE_TTL", DefaultChallengeTTL, &cfg.ChallengeTTL},
	}
	for _, spec := range ttls {
		v, err := positiveInt(get, spec.name, spec.fallback)
		if err != nil || v > 7*24*3600 {
			return nil, fmt.Errorf("%s must be 1-604800 seconds", spec.name)
		}
		*spec.target = uint32(v)
	}

	durations := []struct {
		name     string
		fallback time.Duration
		target   *time.Duration
	}{
		{"SAM_DNS_CHALLENGE_MAX_AGE", DefaultChallengeMaxAge, &cfg.ChallengeMaxAge},
		{"SAM_DNS_SYNC_INTERVAL", DefaultSyncInterval, &cfg.SyncInterval},
		{"SAM_DNS_SYNC_DEADLINE", DefaultSyncDeadline, &cfg.SyncDeadline},
		{"SAM_DNS_GATEWAY_TIMEOUT", DefaultGatewayTimeout, &cfg.GatewayTimeout},
		{"SAM_DNS_TCP_IDLE_TIMEOUT", DefaultTCPIdleTimeout, &cfg.TCPIdleTimeout},
		{"SAM_DNS_SHUTDOWN_GRACE", DefaultShutdownGrace, &cfg.ShutdownGrace},
	}
	for _, spec := range durations {
		v, err := positiveDuration(get, spec.name, spec.fallback)
		if err != nil {
			return nil, err
		}
		*spec.target = v
	}
	cfg.CacheFile = strings.TrimSpace(get("SAM_DNS_CACHE_FILE"))
	return cfg, nil
}

// parseListen turns SAM_DNS_LISTEN into host:port entries. "auto" (optionally "auto:PORT") is
// resolved at startup by listenAddresses.
func parseListen(raw string) ([]string, error) {
	var out []string
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if entry == "auto" || strings.HasPrefix(entry, "auto:") {
			out = append(out, entry)
			continue
		}
		host, port, err := net.SplitHostPort(entry)
		if err != nil || net.ParseIP(host) == nil {
			return nil, fmt.Errorf("SAM_DNS_LISTEN entry %q must be auto, auto:PORT or IP:PORT", entry)
		}
		if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("SAM_DNS_LISTEN entry %q has a bad port", entry)
		}
		out = append(out, entry)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("SAM_DNS_LISTEN is empty")
	}
	return out, nil
}

// listenAddresses expands "auto" into one address per non-loopback unicast address of the host.
func listenAddresses(entries []string, interfaceAddrs func() ([]net.Addr, error)) ([]string, error) {
	var out []string
	for _, entry := range entries {
		if entry != "auto" && !strings.HasPrefix(entry, "auto:") {
			out = append(out, entry)
			continue
		}
		port := strconv.Itoa(DefaultListenPort)
		if strings.HasPrefix(entry, "auto:") {
			port = strings.TrimPrefix(entry, "auto:")
			if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
				return nil, fmt.Errorf("SAM_DNS_LISTEN entry %q has a bad port", entry)
			}
		}
		addrs, err := interfaceAddrs()
		if err != nil {
			return nil, fmt.Errorf("list interface addresses: %w", err)
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() || ipnet.IP.IsMulticast() {
				continue
			}
			out = append(out, net.JoinHostPort(ipnet.IP.String(), port))
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("SAM_DNS_LISTEN resolved to no address (no non-loopback interface?)")
	}
	return out, nil
}
