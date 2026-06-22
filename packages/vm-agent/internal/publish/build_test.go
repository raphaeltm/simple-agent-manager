package publish

import (
	"encoding/json"
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
