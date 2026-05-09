package config

// Config holds application configuration.
type Config struct {
	Port        int
	DatabaseURL string
	JWTSecret   string
	LogLevel    string
}

// Load reads configuration from environment variables.
func Load() *Config {
	return &Config{
		Port:        8080,
		DatabaseURL: "postgres://localhost/app",
		JWTSecret:   "secret",
		LogLevel:    "info",
	}
}
