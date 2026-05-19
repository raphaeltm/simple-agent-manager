package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type ConfigPaths struct {
	ConfigDir  string
	ConfigFile string
}

const configFileName = "config.json"

func LoadConfig(env ConfigEnv) (*CLIConfig, error) {
	apiURL := strings.TrimSpace(env.Getenv("SAM_API_URL"))
	cookie := strings.TrimSpace(env.Getenv("SAM_SESSION_COOKIE"))
	if cookie != "" {
		if apiURL == "" {
			return nil, errors.New("SAM_API_URL must be set when SAM_SESSION_COOKIE is set")
		}
		return &CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: cookie}, nil
	}
	if apiURL != "" {
		return nil, nil
	}

	paths, err := ResolveConfigPaths(env)
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(paths.ConfigFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var cfg CLIConfig
	if err := json.Unmarshal(content, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse SAM config: %w", err)
	}
	cfg.APIURL = normalizeAPIURL(cfg.APIURL)
	if cfg.APIURL == "" || strings.TrimSpace(cfg.SessionCookie) == "" {
		return nil, errors.New("SAM config is missing apiUrl or sessionCookie")
	}
	return &cfg, nil
}

func SaveConfig(env ConfigEnv, cfg CLIConfig) (ConfigPaths, error) {
	paths, err := ResolveConfigPaths(env)
	if err != nil {
		return ConfigPaths{}, err
	}
	if err := os.MkdirAll(paths.ConfigDir, 0o700); err != nil {
		return ConfigPaths{}, err
	}
	cfg.APIURL = normalizeAPIURL(cfg.APIURL)
	content, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return ConfigPaths{}, err
	}
	content = append(content, '\n')
	if err := os.WriteFile(paths.ConfigFile, content, 0o600); err != nil {
		return ConfigPaths{}, err
	}
	return paths, nil
}

func ResolveConfigPaths(env ConfigEnv) (ConfigPaths, error) {
	if dir := strings.TrimSpace(env.Getenv("SAM_CONFIG_DIR")); dir != "" {
		return ConfigPaths{ConfigDir: dir, ConfigFile: filepath.Join(dir, configFileName)}, nil
	}
	if xdg := strings.TrimSpace(env.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		dir := filepath.Join(xdg, "sam")
		return ConfigPaths{ConfigDir: dir, ConfigFile: filepath.Join(dir, configFileName)}, nil
	}
	home, err := env.UserHomeDir()
	if err != nil {
		return ConfigPaths{}, err
	}
	dir := filepath.Join(home, ".config", "sam")
	return ConfigPaths{ConfigDir: dir, ConfigFile: filepath.Join(dir, configFileName)}, nil
}

func normalizeAPIURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func redactSecret(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(not set)"
	}
	return "(redacted)"
}
