// Package config provides configuration loading for the VM Agent.
package config

import (
	"fmt"
	"os"
	"strconv"
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

	// Workspace settings
	WorkspaceID     string
	CallbackToken   string

	// Session settings
	SessionTTL      time.Duration
	CookieName      string
	CookieSecure    bool

	// Idle settings
	IdleTimeout     time.Duration
	HeartbeatInterval time.Duration

	// PTY settings
	DefaultShell    string
	DefaultRows     int
	DefaultCols     int
}

// Load reads configuration from environment variables.
func Load() (*Config, error) {
	cfg := &Config{
		// Default values
		Port:              getEnvInt("VM_AGENT_PORT", 8080),
		Host:              getEnv("VM_AGENT_HOST", "0.0.0.0"),
		AllowedOrigins:    []string{"*"}, // Will be restricted in production

		ControlPlaneURL:   getEnv("CONTROL_PLANE_URL", ""),
		JWKSEndpoint:      getEnv("JWKS_ENDPOINT", ""),

		WorkspaceID:       getEnv("WORKSPACE_ID", ""),
		CallbackToken:     getEnv("CALLBACK_TOKEN", ""),

		SessionTTL:        getEnvDuration("SESSION_TTL", 24*time.Hour),
		CookieName:        getEnv("COOKIE_NAME", "vm_session"),
		CookieSecure:      getEnvBool("COOKIE_SECURE", true),

		IdleTimeout:       getEnvDuration("IDLE_TIMEOUT", 30*time.Minute),
		HeartbeatInterval: getEnvDuration("HEARTBEAT_INTERVAL", 60*time.Second),

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

	if cfg.WorkspaceID == "" {
		return nil, fmt.Errorf("WORKSPACE_ID is required")
	}

	return cfg, nil
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
