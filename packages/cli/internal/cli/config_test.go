package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadConfig(t *testing.T) {
	env := tempConfigEnv(t)
	paths, err := SaveConfig(env, CLIConfig{
		APIURL:        "https://api.example.com/",
		SessionCookie: "better-auth.session_token=secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(paths.ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config mode = %o, want 0600", got)
	}
	loaded, err := LoadConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.APIURL != "https://api.example.com" {
		t.Fatalf("APIURL = %q", loaded.APIURL)
	}
	if loaded.SessionCookie != "better-auth.session_token=secret" {
		t.Fatal("session cookie was not loaded")
	}
}

func TestLoadConfigRequiresAPIURLWithCookieEnv(t *testing.T) {
	_, err := LoadConfig(fakeEnv{values: map[string]string{"SAM_SESSION_COOKIE": "cookie=value"}})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadConfigRejectsIncompleteFileConfig(t *testing.T) {
	env := tempConfigEnv(t)
	paths, err := ResolveConfigPaths(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.ConfigDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ConfigFile, []byte(`{"apiUrl":"https://api.example.com"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = LoadConfig(env)
	if err == nil {
		t.Fatal("expected incomplete config error")
	}
}

func TestLoadConfigUsesCompleteEnvPair(t *testing.T) {
	loaded, err := LoadConfig(fakeEnv{values: map[string]string{
		"SAM_API_URL":        "https://api.example.com/",
		"SAM_SESSION_COOKIE": "cookie=value",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.APIURL != "https://api.example.com" || loaded.SessionCookie != "cookie=value" {
		t.Fatalf("unexpected config: %#v", loaded)
	}
}

func TestLoadConfigUsesMaxAPIResponseBytesEnv(t *testing.T) {
	loaded, err := LoadConfig(fakeEnv{values: map[string]string{
		"SAM_API_URL":                    "https://api.example.com/",
		"SAM_SESSION_COOKIE":             "cookie=value",
		"SAM_CLI_MAX_API_RESPONSE_BYTES": "2048",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if loaded.MaxAPIResponseBytes != 2048 {
		t.Fatalf("MaxAPIResponseBytes = %d, want 2048", loaded.MaxAPIResponseBytes)
	}
}

func TestLoadConfigRejectsInvalidMaxAPIResponseBytesEnv(t *testing.T) {
	_, err := LoadConfig(fakeEnv{values: map[string]string{"SAM_CLI_MAX_API_RESPONSE_BYTES": "0"}})
	if err == nil {
		t.Fatal("expected invalid max response bytes error")
	}
}

func TestResolveConfigPathsHonorsConfigPrecedence(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "explicit")
	xdgDir := filepath.Join(t.TempDir(), "xdg")

	paths, err := ResolveConfigPaths(fakeEnv{values: map[string]string{
		"SAM_CONFIG_DIR":  configDir,
		"XDG_CONFIG_HOME": xdgDir,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if paths.ConfigFile != filepath.Join(configDir, configFileName) {
		t.Fatalf("config path = %s", paths.ConfigFile)
	}

	paths, err = ResolveConfigPaths(fakeEnv{
		values: map[string]string{"XDG_CONFIG_HOME": xdgDir},
		home:   filepath.Join(t.TempDir(), "home"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if paths.ConfigFile != filepath.Join(xdgDir, "sam", configFileName) {
		t.Fatalf("xdg config path = %s", paths.ConfigFile)
	}
}

func TestRedactSecret(t *testing.T) {
	if redactSecret("better-auth.session_token=abcdef") != "(redacted)" {
		t.Fatal("secret was not redacted")
	}
	if redactSecret("") != "(not set)" {
		t.Fatal("empty secret did not use not-set marker")
	}
}
