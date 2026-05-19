package cli

import (
	"os"
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

func TestRedactSecret(t *testing.T) {
	if redactSecret("better-auth.session_token=abcdef") != "(redacted)" {
		t.Fatal("secret was not redacted")
	}
	if redactSecret("") != "(not set)" {
		t.Fatal("empty secret did not use not-set marker")
	}
}
