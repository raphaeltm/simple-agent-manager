// Package config provides configuration loading for the VM Agent.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration values for the VM Agent.
type Config struct {
	// Server settings
	Port            int
	Host            string
	AllowedOrigins  []string

	// Control plane settings
	ControlPlaneURL string
	JWKSEndpoint    string

	// JWT settings
	JWTAudience     string
	JWTIssuer       string

	// Workspace settings
	WorkspaceID     string
	CallbackToken   string

	// Session settings
	SessionTTL            time.Duration
	SessionCleanupInterval time.Duration
	SessionMaxCount       int
	CookieName            string
	CookieSecure          bool

	// Idle settings
	IdleTimeout       time.Duration
	HeartbeatInterval time.Duration

	// HTTP server timeouts
	HTTPReadTimeout  time.Duration
	HTTPWriteTimeout time.Duration
	HTTPIdleTimeout  time.Duration

	// WebSocket settings
	WSReadBufferSize  int
	WSWriteBufferSize int

	// PTY settings
	DefaultShell    string
	DefaultRows     int
	DefaultCols     int
}

// Load reads configuration from environment variables.
func Load() (*Config, error) {
	controlPlaneURL := getEnv("CONTROL_PLANE_URL", "")

	cfg := &Config{
		// Default values
		Port:              getEnvInt("VM_AGENT_PORT", 8080),
		Host:              getEnv("VM_AGENT_HOST", "0.0.0.0"),
		AllowedOrigins:    getEnvStringSlice("ALLOWED_ORIGINS", nil), // Parsed from comma-separated list

		ControlPlaneURL:   controlPlaneURL,
		JWKSEndpoint:      getEnv("JWKS_ENDPOINT", ""),

		// JWT settings - derived from control plane URL by default
		JWTAudience:       getEnv("JWT_AUDIENCE", "workspace-terminal"),
		JWTIssuer:         getEnv("JWT_ISSUER", ""), // Will be derived from ControlPlaneURL if not set

		WorkspaceID:       getEnv("WORKSPACE_ID", ""),
		CallbackToken:     getEnv("CALLBACK_TOKEN", ""),

		SessionTTL:             getEnvDuration("SESSION_TTL", 24*time.Hour),
		SessionCleanupInterval: getEnvDuration("SESSION_CLEANUP_INTERVAL", 1*time.Minute),
		SessionMaxCount:        getEnvInt("SESSION_MAX_COUNT", 100),
		CookieName:             getEnv("COOKIE_NAME", "vm_session"),
		CookieSecure:           getEnvBool("COOKIE_SECURE", true),

		IdleTimeout:       getEnvDuration("IDLE_TIMEOUT", 30*time.Minute),
		HeartbeatInterval: getEnvDuration("HEARTBEAT_INTERVAL", 60*time.Second),

		// HTTP server timeouts - configurable per constitution
		HTTPReadTimeout:  getEnvDuration("HTTP_READ_TIMEOUT", 15*time.Second),
		HTTPWriteTimeout: getEnvDuration("HTTP_WRITE_TIMEOUT", 15*time.Second),
		HTTPIdleTimeout:  getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),

		// WebSocket buffer sizes - configurable per constitution
		WSReadBufferSize:  getEnvInt("WS_READ_BUFFER_SIZE", 1024),
		WSWriteBufferSize: getEnvInt("WS_WRITE_BUFFER_SIZE", 1024),

		DefaultShell:      getEnv("DEFAULT_SHELL", "/bin/bash"),
		DefaultRows:       getEnvInt("DEFAULT_ROWS", 24),
		DefaultCols:       getEnvInt("DEFAULT_COLS", 80),
	}

	// Validate required fields
	if cfg.ControlPlaneURL == "" {
		return nil, fmt.Errorf("CONTROL_PLANE_URL is required")
	}

	// Derive JWKS endpoint if not set
	if cfg.JWKSEndpoint == "" {
		cfg.JWKSEndpoint = cfg.ControlPlaneURL + "/.well-known/jwks.json"
	}

	// Derive JWT issuer from control plane URL if not explicitly set
	if cfg.JWTIssuer == "" {
		cfg.JWTIssuer = cfg.ControlPlaneURL
	}

	// Derive allowed origins from control plane URL if not explicitly set
	if len(cfg.AllowedOrigins) == 0 {
		// Extract base domain from control plane URL to allow workspace subdomains
		// e.g., https://api.example.com -> allow *.example.com
		cfg.AllowedOrigins = deriveAllowedOrigins(cfg.ControlPlaneURL)
	}

	if cfg.WorkspaceID == "" {
		return nil, fmt.Errorf("WORKSPACE_ID is required")
	}

	return cfg, nil
}

// deriveAllowedOrigins extracts allowed origins from the control plane URL.
// This allows the control plane domain and workspace subdomains.
func deriveAllowedOrigins(controlPlaneURL string) []string {
	// Remove protocol
	url := controlPlaneURL
	url = strings.TrimPrefix(url, "https://")
	url = strings.TrimPrefix(url, "http://")

	// Remove path if any
	if idx := strings.Index(url, "/"); idx != -1 {
		url = url[:idx]
	}

	// Remove port if any
	if idx := strings.Index(url, ":"); idx != -1 {
		url = url[:idx]
	}

	// Get base domain (remove 'api.' prefix if present)
	baseDomain := url
	if strings.HasPrefix(baseDomain, "api.") {
		baseDomain = baseDomain[4:]
	}

	// Return the control plane origin and workspace subdomain pattern
	return []string{
		controlPlaneURL,
		"https://*." + baseDomain, // Allow workspace subdomains
	}
}

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
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}

// getEnvBool returns a boolean environment variable or a default.
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}

// getEnvDuration returns a duration environment variable or a default.
func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if d, err := time.ParseDuration(value); err == nil {
			return d
		}
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
