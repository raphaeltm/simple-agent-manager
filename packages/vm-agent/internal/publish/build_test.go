package publish

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateNoSecretRefsInBuildFieldsRejectsImageReference(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {Image: "registry.example.com/app:${DATABASE_URL:-latest}"},
	}}

	err := validateNoSecretRefsInBuildFields(cfg, []string{"DATABASE_URL"})
	if err == nil {
		t.Fatal("expected secret image reference to be rejected")
	}
	if !strings.Contains(err.Error(), "service api image references secret interpolation key DATABASE_URL") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateNoSecretRefsInBuildFieldsRejectsBuildReference(t *testing.T) {
	build := json.RawMessage(`{"context":".","args":{"TOKEN":"${NPM_TOKEN}"}}`)
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {Build: build},
	}}

	err := validateNoSecretRefsInBuildFields(cfg, []string{"NPM_TOKEN"})
	if err == nil {
		t.Fatal("expected secret build reference to be rejected")
	}
	if !strings.Contains(err.Error(), "service api build section references secret interpolation key NPM_TOKEN") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateNoSecretRefsInBuildFieldsAllowsDeployOnlyReference(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {
			Image: "registry.example.com/app:${PUBLIC_TAG:-latest}",
			Build: json.RawMessage(`{
				"context": ".",
				"args": {
					"PUBLIC_TAG": "${PUBLIC_TAG:-latest}"
				}
			}`),
		},
	}}

	if err := validateNoSecretRefsInBuildFields(cfg, []string{"DATABASE_URL"}); err != nil {
		t.Fatalf("non-secret build/image references should be allowed: %v", err)
	}
}

func TestBuildComposeCommandEnvAddsSecretPlaceholders(t *testing.T) {
	buildEnv := map[string]string{
		"PUBLIC_TAG":   "v1",
		"DATABASE_URL": "should-not-leak",
	}

	env := buildComposeCommandEnv(buildEnv, []string{"DATABASE_URL", "API_TOKEN", "DATABASE_URL", " "})

	if env["PUBLIC_TAG"] != "v1" {
		t.Fatalf("PUBLIC_TAG = %q, want v1", env["PUBLIC_TAG"])
	}
	if env["DATABASE_URL"] != secretInterpolationPlaceholder {
		t.Fatalf("DATABASE_URL = %q, want placeholder", env["DATABASE_URL"])
	}
	if env["API_TOKEN"] != secretInterpolationPlaceholder {
		t.Fatalf("API_TOKEN = %q, want placeholder", env["API_TOKEN"])
	}
	if buildEnv["DATABASE_URL"] != "should-not-leak" {
		t.Fatalf("buildComposeCommandEnv mutated buildEnv: %#v", buildEnv)
	}
}

func TestRunComposeAllowsConfiguredSecretRuntimeReference(t *testing.T) {
	dir := t.TempDir()
	compose := filepath.Join(dir, "fake-compose")
	script := strings.Join([]string{
		"#!/bin/sh",
		"if [ -z \"${SAM_RUNTIME_SECRET_FOR_TEST+x}\" ]; then",
		"  echo 'time=\"2026-06-22T00:00:00Z\" level=warning msg=\"The \"SAM_RUNTIME_SECRET_FOR_TEST\" variable is not set. Defaulting to a blank string.\"' >&2",
		"fi",
		"printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"}}}}'",
	}, "\n")
	if err := os.WriteFile(compose, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake compose: %v", err)
	}

	env := buildComposeCommandEnv(nil, []string{"SAM_RUNTIME_SECRET_FOR_TEST"})
	if _, err := runCompose(context.Background(), compose, dir, env, "config", "--format", "json"); err != nil {
		t.Fatalf("runCompose should allow configured secret runtime interpolation: %v", err)
	}
}

func TestContainsEnvReference(t *testing.T) {
	cases := []struct {
		value string
		key   string
		want  bool
	}{
		{value: "${DATABASE_URL}", key: "DATABASE_URL", want: true},
		{value: "${DATABASE_URL:-postgres://example}", key: "DATABASE_URL", want: true},
		{value: "$DATABASE_URL/path", key: "DATABASE_URL", want: true},
		{value: "${DATABASE_URL_BACKUP}", key: "DATABASE_URL", want: false},
		{value: "$DATABASE_URL_BACKUP", key: "DATABASE_URL", want: false},
		{value: "${PUBLIC_TAG:-latest}", key: "DATABASE_URL", want: false},
	}

	for _, c := range cases {
		if got := containsEnvReference(c.value, c.key); got != c.want {
			t.Errorf("containsEnvReference(%q, %q) = %v, want %v", c.value, c.key, got, c.want)
		}
	}
}

func TestMissingVariableWarnings(t *testing.T) {
	stderr := strings.Join([]string{
		"time=\"2026-06-22T00:00:00Z\" level=warning msg=\"The \\\"DATABASE_URL\\\" variable is not set. Defaulting to a blank string.\"",
		"unrelated compose output",
	}, "\n")

	warnings := missingVariableWarnings(stderr)
	if len(warnings) != 1 {
		t.Fatalf("expected one warning, got %d: %#v", len(warnings), warnings)
	}
	if !strings.Contains(warnings[0], "DATABASE_URL") {
		t.Fatalf("expected DATABASE_URL warning, got %#v", warnings)
	}
}
