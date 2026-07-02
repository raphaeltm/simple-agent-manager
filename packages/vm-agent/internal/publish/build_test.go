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

func TestValidateComposeVolumeSafetyAllowsDeclaredNamedVolumes(t *testing.T) {
	cfg := &composeConfig{
		Services: map[string]composeConfigService{
			"api": {
				Volumes: json.RawMessage(`[
					{"type":"volume","source":"appdata","target":"/data"},
					{"source":"cache","target":"/cache","read_only":true}
				]`),
			},
		},
		Volumes: map[string]json.RawMessage{
			"appdata": json.RawMessage(`{"name":"demo_appdata"}`),
			"cache":   json.RawMessage(`{"x-sam-size-hint-mb":2048}`),
		},
	}

	if err := validateComposeVolumeSafety(cfg); err != nil {
		t.Fatalf("declared named volumes should be allowed: %v", err)
	}
}

func TestValidateComposeVolumeSafetyRejectsUnsupportedVolumeFeatures(t *testing.T) {
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
			"appdata": json.RawMessage(`{"external":true}`),
			"cache":   json.RawMessage(`{"driver_opts":{"type":"none","device":"/","o":"bind"}}`),
			"BadName": json.RawMessage(`{}`),
		},
	}

	err := validateComposeVolumeSafety(cfg)
	if err == nil {
		t.Fatal("expected unsupported compose volume features to be rejected")
	}
	if !IsUnsupportedComposeVolumesError(err) {
		t.Fatalf("expected unsupported compose volumes error, got %T: %v", err, err)
	}
	for _, want := range []string{
		"build_and_publish supports safe named Docker Compose volumes",
		"top-level:appdata.external",
		"top-level:cache.driver_opts",
		"top-level:BadName: invalid volume name",
		"api:legacydata (undeclared named volume)",
		"api:/tmp/uploads",
		"worker:anonymous at /cache",
		"SAM provider-backed deployment volumes",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
}

func TestValidateComposeVolumeSafetyRejectsBindAndTmpfsServiceMounts(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {
			Volumes: json.RawMessage(`[
				{"type":"bind","source":"/tmp/uploads","target":"/uploads"},
				{"type":"tmpfs","target":"/cache"}
			]`),
		},
	}}

	err := validateComposeVolumeSafety(cfg)
	if err == nil {
		t.Fatal("expected service mounts to be rejected")
	}
	for _, want := range []string{"api:/tmp/uploads", "api:anonymous at /cache"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
}

func TestValidateComposeVolumeSafetyRejectsUnsafeStringVolumeEntries(t *testing.T) {
	cfg := &composeConfig{
		Services: map[string]composeConfigService{
			"api": {
				Volumes: json.RawMessage(`["appdata:/data","/cache","/tmp/uploads:/uploads","other:/other"]`),
			},
		},
		Volumes: map[string]json.RawMessage{
			"appdata": json.RawMessage(`{}`),
		},
	}

	err := validateComposeVolumeSafety(cfg)
	if err == nil {
		t.Fatal("expected unsafe string compose volume entries to be rejected")
	}
	for _, want := range []string{"api:anonymous at /cache", "api:/tmp/uploads", "api:other (undeclared named volume)"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "api:appdata") {
		t.Fatalf("declared named volume should be allowed, got: %v", err)
	}
}

func TestValidateComposeVolumeSafetyRejectsVolumesFromAndServiceTmpfs(t *testing.T) {
	cfg := &composeConfig{Services: map[string]composeConfigService{
		"api": {
			VolumesFrom: json.RawMessage(`["db:ro"]`),
			Tmpfs:       json.RawMessage(`["/run/cache"]`),
		},
		"worker": {
			VolumesFrom: json.RawMessage(`"api"`),
			Tmpfs:       json.RawMessage(`"/tmp"`),
		},
	}}

	err := validateComposeVolumeSafety(cfg)
	if err == nil {
		t.Fatal("expected service volumes_from/tmpfs to be rejected")
	}
	for _, want := range []string{
		"api:volumes_from:db:ro",
		"api:tmpfs:/run/cache",
		"worker:volumes_from:api",
		"worker:tmpfs:/tmp",
		"service volumes_from",
		"service tmpfs",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected error to contain %q, got: %v", want, err)
		}
	}
}

func TestBuildRejectsUnsafeComposeVolumesBeforeBuild(t *testing.T) {
	dir := t.TempDir()
	buildMarker := filepath.Join(dir, "build-called")
	compose := filepath.Join(dir, "fake-compose")
	script := strings.Join([]string{
		"#!/bin/sh",
		"if [ \"$*\" = \"config --no-interpolate --format json\" ]; then",
		"  printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"},\"volumes\":[{\"type\":\"bind\",\"source\":\"/tmp/uploads\",\"target\":\"/uploads\"}]}},\"volumes\":{}}'",
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

func TestBuildAllowsSafeComposeVolumesBeforeBuild(t *testing.T) {
	dir := t.TempDir()
	buildMarker := filepath.Join(dir, "build-called")
	compose := filepath.Join(dir, "fake-compose")
	script := strings.Join([]string{
		"#!/bin/sh",
		"if [ \"$*\" = \"config --no-interpolate --format json\" ]; then",
		"  printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"},\"volumes\":[{\"type\":\"volume\",\"source\":\"appdata\",\"target\":\"/data\"}]}},\"volumes\":{\"appdata\":{\"name\":\"demo_appdata\"}}}'",
		"  exit 0",
		"fi",
		"if [ \"$1\" = \"build\" ]; then",
		"  touch '" + buildMarker + "'",
		"  exit 0",
		"fi",
		"if [ \"$*\" = \"config --format json\" ]; then",
		"  printf '%s' '{\"name\":\"demo\",\"services\":{\"api\":{\"image\":\"demo-api\",\"build\":{\"context\":\".\"}}}}'",
		"  exit 0",
		"fi",
		"if [ \"$*\" = \"config --no-interpolate\" ]; then",
		"  printf '%s' 'services:\\n  api:\\n    image: demo-api\\n    volumes:\\n      - appdata:/data\\nvolumes:\\n  appdata:\\n'",
		"  exit 0",
		"fi",
		"printf '%s' '{}'",
	}, "\n")
	if err := os.WriteFile(compose, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake compose: %v", err)
	}

	_, _ = Build(context.Background(), BuildOptions{
		WorkspaceDir: dir,
		ComposeCmd:   compose,
	})
	if _, statErr := os.Stat(buildMarker); statErr != nil {
		t.Fatalf("compose build should run after safe named volume validation, stat err: %v", statErr)
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
