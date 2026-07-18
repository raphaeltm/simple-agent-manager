package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type ConfigPaths struct {
	ConfigDir  string
	ConfigFile string
}

const configFileName = "config.json"
const maxAPIResponseBytesEnv = "SAM_CLI_MAX_API_RESPONSE_BYTES"

func LoadConfig(env ConfigEnv) (*CLIConfig, error) {
	apiURL := strings.TrimSpace(env.Getenv("SAM_API_URL"))
	cookie := strings.TrimSpace(env.Getenv("SAM_SESSION_COOKIE"))
	maxAPIResponseBytes, err := loadMaxAPIResponseBytes(env)
	if err != nil {
		return nil, err
	}
	if cookie != "" {
		if apiURL == "" {
			return nil, errors.New("SAM_API_URL must be set when SAM_SESSION_COOKIE is set")
		}
		return &CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: cookie, MaxAPIResponseBytes: maxAPIResponseBytes}, nil
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
	if cfg.MaxAPIResponseBytes <= 0 {
		cfg.MaxAPIResponseBytes = maxAPIResponseBytes
	}
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

// SetActiveProject updates the active project in the saved config file.
// It loads the existing config, sets the project fields, and saves.
func SetActiveProject(env ConfigEnv, projectID string, projectName string) error {
	cfg, err := LoadConfig(env)
	if err != nil {
		return err
	}
	if cfg == nil {
		return errors.New("not authenticated. Run `sam auth login` first")
	}
	cfg.ActiveProjectID = projectID
	cfg.ActiveProjectName = projectName
	_, err = SaveConfig(env, *cfg)
	return err
}

func loadMaxAPIResponseBytes(env ConfigEnv) (int64, error) {
	value := strings.TrimSpace(env.Getenv(maxAPIResponseBytesEnv))
	if value == "" {
		return defaultMaxAPIResponseBodyBytes, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", maxAPIResponseBytesEnv)
	}
	return parsed, nil
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
