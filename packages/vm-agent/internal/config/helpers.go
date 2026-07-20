// Package config — environment helpers, validation, and factory functions.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/auth"
)

// getEnv returns the value of an environment variable or a default.
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt returns an integer environment variable or a default.
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		i, err := strconv.Atoi(value)
		if err != nil {
			slog.Warn("config: could not parse env var", "key", key, "value", value, "default", defaultValue, "error", err)
			return defaultValue
		}
		return i
	}
	return defaultValue
}

// getEnvInt64 returns an int64 environment variable or a default.
func getEnvInt64(key string, defaultValue int64) int64 {
	if value := os.Getenv(key); value != "" {
		i, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			slog.Warn("config: could not parse env var", "key", key, "value", value, "default", defaultValue, "error", err)
			return defaultValue
		}
		return i
	}
	return defaultValue
}

// getEnvBool returns a boolean environment variable or a default.
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		b, err := strconv.ParseBool(value)
		if err != nil {
			slog.Warn("config: could not parse env var", "key", key, "value", value, "default", defaultValue, "error", err)
			return defaultValue
		}
		return b
	}
	return defaultValue
}

// getEnvDuration returns a duration environment variable or a default.
func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		d, err := time.ParseDuration(value)
		if err != nil {
			slog.Warn("config: could not parse env var", "key", key, "value", value, "default", defaultValue, "error", err)
			return defaultValue
		}
		return d
	}
	return defaultValue
}

// getEnvFloat returns a float64 environment variable or a default.
func getEnvFloat(key string, defaultValue float64) float64 {
	if value := os.Getenv(key); value != "" {
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			slog.Warn("config: could not parse env var", "key", key, "value", value, "default", defaultValue, "error", err)
			return defaultValue
		}
		return f
	}
	return defaultValue
}

// getEnvStringSlice returns a slice from a comma-separated environment variable.
func getEnvStringSlice(key string, defaultValue []string) []string {
	if value := os.Getenv(key); value != "" {
		parts := strings.Split(value, ",")
		result := make([]string, 0, len(parts))
		for _, p := range parts {
			trimmed := strings.TrimSpace(p)
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return defaultValue
}

// ResolveStandaloneCloneFilter normalizes a STANDALONE_CLONE_FILTER value.
// "off", "none", and "false" (case-insensitive) disable partial cloning and
// return "" (full clone); any other non-blank value is passed to git verbatim
// as --filter=<value>. Note: through Load(), an unset or empty env var yields
// DefaultStandaloneCloneFilter (getEnv treats empty as unset), so the only
// env-var way to disable the filter is an explicit "off"/"none"/"false".
// Blank input to this function directly resolves to "" (no filter).
func ResolveStandaloneCloneFilter(raw string) string {
	trimmed := strings.TrimSpace(raw)
	switch strings.ToLower(trimmed) {
	case "", "off", "none", "false":
		return ""
	}
	return trimmed
}

// getEnvOrGenerate returns the value of an environment variable, or generates
// a cryptographically random hex password of the given byte length.
// If the operator sets a value shorter than 8 characters, a warning is logged.
func getEnvOrGenerate(key string, byteLen int) string {
	if value := os.Getenv(key); value != "" {
		if len(value) < 8 {
			slog.Warn("config: weak password detected — consider using at least 8 characters", "key", key)
		}
		return value
	}
	return GenerateRandomPassword(byteLen)
}

// GenerateRandomPassword returns a hex-encoded string of byteLen random bytes
// using crypto/rand. Panics on rand failure (should never happen on a healthy OS).
func GenerateRandomPassword(byteLen int) string {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		panic("config: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// controlPlaneTransport is a package-shared *http.Transport used by every
// control-plane HTTP client the VM agent constructs. It is shared so that
// CloseIdleControlPlaneConnections() can flush pooled sockets that have been
// silently broken by network-disruptive provisioning steps (Docker install,
// Docker restart, firewall install). Without flushing, Go's default
// IdleConnTimeout of 90s would keep dead sockets in the pool and every new
// request would hang until the per-request Timeout fires, extending boot
// outages from seconds into multiple minutes.
//
// Values are tuned for a low-volume control-plane client that talks to a
// single host (api.<base-domain>): small pool, short idle timeout, strict
// sub-timeouts so a dead connection surfaces fast.
var controlPlaneTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	MaxIdleConns:          10,
	MaxIdleConnsPerHost:   2,
	IdleConnTimeout:       30 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
	ForceAttemptHTTP2:     true,
}

// NewControlPlaneClient returns an *http.Client with an explicit timeout
// and the package-shared control-plane transport. If timeout is 0 or
// negative, a default of 30 seconds is used.
//
// All control-plane HTTP clients MUST be constructed via this function so
// that CloseIdleControlPlaneConnections can purge stale sockets from the
// shared pool.
func NewControlPlaneClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: controlPlaneTransport,
	}
}

// CloseIdleControlPlaneConnections purges idle sockets from the shared
// control-plane transport pool. Call this after steps that may invalidate
// conntrack or veth state (Docker install/restart, firewall install) so
// subsequent requests establish fresh TCP connections instead of hanging
// on broken pooled sockets.
func CloseIdleControlPlaneConnections() {
	controlPlaneTransport.CloseIdleConnections()
}

// Validate checks the loaded configuration for semantic correctness.
// It returns an error describing all validation failures found.
func (c *Config) Validate() error {
	var errs []error

	// Port range
	if c.Port < 1 || c.Port > 65535 {
		errs = append(errs, fmt.Errorf("VM_AGENT_PORT must be 1-65535, got %d", c.Port))
	}

	// Control plane URL is required and must be valid
	if c.ControlPlaneURL == "" {
		errs = append(errs, fmt.Errorf("CONTROL_PLANE_URL is required"))
	} else if u, err := url.Parse(c.ControlPlaneURL); err != nil {
		errs = append(errs, fmt.Errorf("CONTROL_PLANE_URL is not a valid URL: %w", err))
	} else if u.Scheme != "http" && u.Scheme != "https" {
		errs = append(errs, fmt.Errorf("CONTROL_PLANE_URL must use http or https scheme, got %q", u.Scheme))
	} else if err := auth.ValidateIssuerURL(c.ControlPlaneURL); err != nil {
		errs = append(errs, fmt.Errorf("CONTROL_PLANE_URL: %w", err))
	}

	if c.JWKSEndpoint != "" {
		if err := auth.ValidateJWKSURL(c.JWKSEndpoint); err != nil {
			errs = append(errs, fmt.Errorf("JWKS_ENDPOINT: %w", err))
		}
	}

	if c.JWTIssuer != "" {
		if err := auth.ValidateIssuerURL(c.JWTIssuer); err != nil {
			errs = append(errs, fmt.Errorf("JWT_ISSUER: %w", err))
		}
	}

	// TLS cert/key paths must exist when TLS is enabled
	if c.TLSEnabled {
		if _, err := os.Stat(c.TLSCertPath); err != nil {
			errs = append(errs, fmt.Errorf("TLS_CERT_PATH %q: %w", c.TLSCertPath, err))
		}
		if _, err := os.Stat(c.TLSKeyPath); err != nil {
			errs = append(errs, fmt.Errorf("TLS_KEY_PATH %q: %w", c.TLSKeyPath, err))
		}
	}

	// Workspace-specific validations (skip in deployment mode)
	if !c.IsDeploymentMode() {
		if c.GitCredentialTimeout <= 0 {
			errs = append(errs, fmt.Errorf("GIT_CREDENTIAL_TIMEOUT must be > 0, got %s", c.GitCredentialTimeout))
		}
		if c.SessionMaxCount < 1 {
			errs = append(errs, fmt.Errorf("SESSION_MAX_COUNT must be > 0, got %d", c.SessionMaxCount))
		}
		if c.DefaultRows < 1 {
			errs = append(errs, fmt.Errorf("DEFAULT_ROWS must be > 0, got %d", c.DefaultRows))
		}
		if c.DefaultCols < 1 {
			errs = append(errs, fmt.Errorf("DEFAULT_COLS must be > 0, got %d", c.DefaultCols))
		}

		// WebSocket buffer sizes
		if c.WSReadBufferSize < 1 {
			errs = append(errs, fmt.Errorf("WS_READ_BUFFER_SIZE must be > 0, got %d", c.WSReadBufferSize))
		}
		if c.WSWriteBufferSize < 1 {
			errs = append(errs, fmt.Errorf("WS_WRITE_BUFFER_SIZE must be > 0, got %d", c.WSWriteBufferSize))
		}
		if c.TerminalWSMaxMessageBytes < 1 {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_MAX_MESSAGE_BYTES must be > 0, got %d", c.TerminalWSMaxMessageBytes))
		}
		if c.TerminalWSReadTimeout <= 0 {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_READ_TIMEOUT must be > 0, got %s", c.TerminalWSReadTimeout))
		}
		if c.TerminalWSPingInterval <= 0 {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_PING_INTERVAL must be > 0, got %s", c.TerminalWSPingInterval))
		}
		if c.TerminalWSPingInterval >= c.TerminalWSReadTimeout {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_PING_INTERVAL must be less than TERMINAL_WS_READ_TIMEOUT, got %s >= %s", c.TerminalWSPingInterval, c.TerminalWSReadTimeout))
		}
		if c.TerminalWSMessageRate < 1 {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_MESSAGE_RATE must be > 0, got %d", c.TerminalWSMessageRate))
		}
		if c.TerminalWSMessageBurst < 1 {
			errs = append(errs, fmt.Errorf("TERMINAL_WS_MESSAGE_BURST must be > 0, got %d", c.TerminalWSMessageBurst))
		}
		if c.TerminalSessionIDMaxLength < 1 {
			errs = append(errs, fmt.Errorf("TERMINAL_SESSION_ID_MAX_LENGTH must be > 0, got %d", c.TerminalSessionIDMaxLength))
		}
	}

	return errors.Join(errs...)
}
