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

func TestValidateNoComposeVolumesRejectsTopLevelAndServiceVolumes(t *testing.T) {
	cfg := &composeConfig{
		Services: map[string]composeConfigService{
			"api": {
				Volumes: json.RawMessage(`[
					{"type":"volume","source":"appdata","target":"/data"},
					{"source":"legacydata","target":"/legacy"},
					{"type":"bind","source":"/tmp/uploads","target":"/uploads"}
				]`),
			},
			"worker": {
				Volumes: json.RawMessage(`[
					{"type":"volume","target":"/cache"}
				]`),
			},
		},
		Volumes: map[string]json.RawMessage{
			"appdata": json.RawMessage(`{}`),
		},
	}

	err := validateNoComposeVolumes(cfg)
	if err == nil {
		t.Fatal("expected compose volumes to be rejected")
	}
	if !IsUnsupportedComposeVolumesError(err) {
		t.Fatalf("expected unsupported compose volumes error, got %T: %v", err, err)
	}
	for _, want := range []string{
		"build_and_publish does not support Docker Compose named or anonymous volumes yet",
		"api:appdata",
		"api:legacydata",
		"worker:anonymous at /cache",
		"top-level:appdata",
		"Docker-managed local volumes",
		"SAM provider-backed deployment volumes",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "/tmp/uploads") {
		t.Fatalf("bind mount should not be reported as a Docker Compose volume: %v", err)
	}
}

func TestValidateNoComposeVolumesAllowsComposeWithoutDockerVolumes(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {
			Volumes: json.RawMessage(`[
				{"type":"bind","source":"/tmp/uploads","target":"/uploads"}
			]`),
		},
	}}

	if err := validateNoComposeVolumes(cfg); err != nil {
		t.Fatalf("non-volume compose mounts should be left to downstream validators: %v", err)
	}
}

func TestValidateNoComposeVolumesRejectsStringVolumeEntries(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {
			Volumes: json.RawMessage(`["appdata:/data","/cache","/tmp/uploads:/uploads"]`),
		},
	}}

	err := validateNoComposeVolumes(cfg)
	if err == nil {
		t.Fatal("expected string compose volume entries to be rejected")
	}
	for _, want := range []string{"api:appdata", "api:anonymous at /cache"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "/tmp/uploads") {
		t.Fatalf("bind-like string mount should not be reported as a Docker Compose volume: %v", err)
	}
}

func TestBuildRejectsComposeVolumesBeforeBuild(t *testing.T) {
	dir := t.TempDir()
	buildMarker := filepath.Join(dir, "build-called")
	compose := filepath.Join(dir, "fake-compose")
	script := strings.Join([]string{
		"#!/bin/sh",
		"if [ \"$*\" = \"config --no-interpolate --format json\" ]; then",
		"  printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"},\"volumes\":[{\"type\":\"volume\",\"source\":\"appdata\",\"target\":\"/data\"}]}},\"volumes\":{\"appdata\":{}}}'",
		"  exit 0",
		"fi",
		"if [ \"$1\" = \"build\" ]; then",
		"  touch '" + buildMarker + "'",
		"  exit 0",
		"fi",
		"printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"}}}}'",
	}, "\n")
	if err := os.WriteFile(compose, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake compose: %v", err)
	}

	_, err := Build(context.Background(), BuildOptions{
		WorkspaceDir: dir,
		ComposeCmd:   compose,
	})
	if err == nil {
		t.Fatal("expected Build to reject compose volumes")
	}
	if !IsUnsupportedComposeVolumesError(err) {
		t.Fatalf("expected unsupported compose volumes error, got %T: %v", err, err)
	}
	if _, statErr := os.Stat(buildMarker); !os.IsNotExist(statErr) {
		t.Fatalf("compose build should not run after volume validation failure, stat err: %v", statErr)
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
