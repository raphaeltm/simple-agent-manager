package acp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func parseCodexConfig(t *testing.T, config string) map[string]any {
	t.Helper()
	var root map[string]any
	if err := toml.Unmarshal([]byte(config), &root); err != nil {
		t.Fatalf("config is invalid TOML: %v\n%s", err, config)
	}
	return root
}

func codexFeatureTable(t *testing.T, root map[string]any) map[string]any {
	t.Helper()
	table, _ := root["features"].(map[string]any)
	return table
}

func assertCodexFeatures(t *testing.T, config string, want map[string]any) {
	t.Helper()
	root := parseCodexConfig(t, config)
	// Liveness: SAM's own managed block is still written, so an empty or broken merge
	// cannot pass as "features left alone".
	if root["sandbox_mode"] != "danger-full-access" {
		t.Fatalf("managed sandbox_mode missing:\n%s", config)
	}
	features := codexFeatureTable(t, root)
	for key, value := range want {
		if value == nil {
			if _, set := features[key]; set {
				t.Fatalf("features.%s = %v, want unset:\n%s", key, features[key], config)
			}
			continue
		}
		if features[key] != value {
			t.Fatalf("features.%s = %v, want %v:\n%s", key, features[key], value, config)
		}
	}
}

func TestMergeManagedCodexConfigFeatureDefaults(t *testing.T) {
	t.Parallel()

	allOff := map[string]any{"apps": false, "plugins": false, "remote_plugin": false}
	cases := []struct {
		name     string
		existing string
		want     map[string]any
		// preserved lines must survive the merge unchanged.
		preserved []string
	}{
		{name: "no existing config", want: allOff},
		{
			name: "config written by an older SAM vm-agent",
			existing: strings.Join([]string{
				codexManagedMcpStartMarker,
				`sandbox_mode = "danger-full-access"`,
				`[mcp_servers.sam-mcp]`,
				`url = "https://old.example.com/mcp"`,
				codexManagedMcpEndMarker,
			}, "\n"),
			want: allOff,
		},
		{
			name:      "user tables without features",
			existing:  "model = \"user-model\"\n\n[profiles.user]\nmodel = \"other\"\n",
			want:      allOff,
			preserved: []string{`model = "user-model"`, `[profiles.user]`},
		},
		{
			name:      "user [features] table with other flags",
			existing:  "model = \"user-model\"\n\n[features]\ncode_mode = true\n\n[profiles.user]\nmodel = \"other\"\n",
			want:      map[string]any{"apps": false, "plugins": false, "remote_plugin": false, "code_mode": true},
			preserved: []string{`code_mode = true`, `[profiles.user]`},
		},
		{
			name:     "user [features] table re-enables apps and plugins",
			existing: "[features]\napps = true\nplugins = true\n",
			want:     map[string]any{"apps": true, "plugins": true, "remote_plugin": false},
		},
		{
			name:     "user sets every managed feature",
			existing: "[features]\napps = true\nplugins = false\nremote_plugin = true\n",
			want:     map[string]any{"apps": true, "plugins": false, "remote_plugin": true},
		},
		{
			name:      "user dotted top-level features",
			existing:  "features.code_mode = true\nfeatures.apps = true\nmodel = \"user-model\"\n",
			want:      map[string]any{"apps": true, "plugins": false, "remote_plugin": false, "code_mode": true},
			preserved: []string{`features.code_mode = true`},
		},
		{
			name:      "user features defined only by a sub-table",
			existing:  "[features.example]\nlevel = 2\n",
			want:      allOff,
			preserved: []string{`[features.example]`},
		},
		{
			name: "multi-line string containing a [features] line before the real table",
			existing: strings.Join([]string{
				`notes = """`,
				`[features]`,
				`apps = true`,
				`"""`,
				``,
				`[features]`,
				`code_mode = true`,
			}, "\n"),
			want:      map[string]any{"apps": false, "plugins": false, "remote_plugin": false, "code_mode": true},
			preserved: []string{"notes = \"\"\"\n[features]\napps = true\n\"\"\""},
		},
		{
			name: "multi-line top-level array and literal string",
			existing: strings.Join([]string{
				`matrix = [`,
				`  [1, 2], # "[profiles.decoy]"`,
				`  [3, 4],`,
				`]`,
				`prompt = '''`,
				`[mcp_servers.decoy]`,
				`sandbox_mode = "read-only"`,
				`'''`,
				`model = "user-model"`,
				``,
				`[profiles.user]`,
				`model = "other"`,
			}, "\n"),
			want:      allOff,
			preserved: []string{"matrix = [\n  [1, 2], # \"[profiles.decoy]\"\n  [3, 4],\n]", "[mcp_servers.decoy]\nsandbox_mode = \"read-only\"", `model = "user-model"`},
		},
		{
			name:     "managed top-level key with a multi-line value is replaced whole",
			existing: "approval_policy = [\n  \"on-request\",\n]\nmodel = \"user-model\"\n",
			want:     allOff,
		},
		{
			name:     "user inline features table cannot be extended",
			existing: "features = { code_mode = true }\n",
			// SAM leaves Codex's defaults rather than write an invalid file.
			want:      map[string]any{"apps": nil, "plugins": nil, "remote_plugin": nil, "code_mode": true},
			preserved: []string{`features = { code_mode = true }`},
		},
	}

	managed, _ := generateCodexMcpConfig([]McpServerEntry{{URL: "https://api.example.com/mcp", Token: "tok"}}, nil, "")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			merged := mergeManagedCodexMcpConfig(tc.existing, managed)
			assertCodexFeatures(t, merged, tc.want)
			if got := codexFeaturesHeaderCount(merged); got > 1 {
				t.Fatalf("[features] header count = %d, want at most 1:\n%s", got, merged)
			}
			for _, line := range tc.preserved {
				if !strings.Contains(merged, line) {
					t.Fatalf("user line %q was not preserved:\n%s", line, merged)
				}
			}
			// A restart rewrites config.toml from the file the previous session left.
			if again := mergeManagedCodexMcpConfig(merged, managed); again != merged {
				t.Fatalf("rewrite is not idempotent:\nfirst:\n%s\nsecond:\n%s", merged, again)
			}
		})
	}
}

func codexFeaturesHeaderCount(config string) int {
	count := 0
	lines := strings.Split(config, "\n")
	starts := codexTOMLStatementStarts(lines)
	for i, line := range lines {
		if starts[i] && strings.TrimSpace(line) == "[features]" {
			count++
		}
	}
	return count
}

func TestMergeManagedCodexConfigInvalidUserConfigKeepsPriorBehaviour(t *testing.T) {
	t.Parallel()

	existing := "model = \"unterminated\n"
	managed, _ := generateCodexMcpConfig(nil, nil, "")
	merged := mergeManagedCodexMcpConfig(existing, managed)
	if strings.Contains(merged, codexManagedFeaturesStartMarker) {
		t.Fatalf("feature defaults added to an unparseable config:\n%s", merged)
	}
	if !strings.Contains(merged, `sandbox_mode = "danger-full-access"`) || !strings.Contains(merged, existing[:len(existing)-1]) {
		t.Fatalf("managed block or user content missing:\n%s", merged)
	}
}

// TestCodexStartupDisablesAppsAndPluginsOnEveryRuntime enters through
// writeAgentStartupConfig, the path every Codex session start and restart takes,
// for the Instant/standalone runtime (local file) and the VM runtime (devcontainer
// via docker exec). Each case starts twice to model an agent restart rewriting the
// file the previous start left behind.
func TestCodexStartupDisablesAppsAndPluginsOnEveryRuntime(t *testing.T) {
	cases := []struct {
		name      string
		container bool
		existing  string
		want      map[string]any
	}{
		{name: "standalone fresh", want: map[string]any{"apps": false, "plugins": false, "remote_plugin": false}},
		{name: "container fresh", container: true, want: map[string]any{"apps": false, "plugins": false, "remote_plugin": false}},
		{
			name:     "standalone with user features table",
			existing: "[features]\ncode_mode = true\napps = true\n",
			want:     map[string]any{"apps": true, "plugins": false, "remote_plugin": false, "code_mode": true},
		},
		{
			name:      "container with user features table",
			container: true,
			existing:  "[features]\ncode_mode = true\nplugins = true\n",
			want:      map[string]any{"apps": false, "plugins": true, "remote_plugin": false, "code_mode": true},
		},
		{
			name:      "container with user inline features table",
			container: true,
			existing:  "features = { code_mode = true }\n",
			want:      map[string]any{"apps": nil, "plugins": nil, "remote_plugin": nil, "code_mode": true},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			var configPath, containerID string
			if tc.container {
				configPath = filepath.Join(tmpDir, "container-config.toml")
				containerID = "container-123"
				installStatefulFakeDocker(t, tmpDir, configPath)
			} else {
				t.Setenv("HOME", tmpDir)
				t.Setenv("CODEX_HOME", "")
				configPath = filepath.Join(tmpDir, ".codex", "config.toml")
			}
			if tc.existing != "" {
				if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(configPath, []byte(tc.existing), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			h := &SessionHost{config: SessionHostConfig{GatewayConfig: GatewayConfig{
				McpServers:    []McpServerEntry{{URL: "https://api.example.com/mcp", Token: "tok"}},
				WorkspaceID:   "ws-features",
				ContainerUser: "testuser",
			}}}
			var first string
			for attempt := 0; attempt < 2; attempt++ {
				startup := &agentStartup{containerID: containerID, settings: &agentSettingsPayload{}}
				if err := h.writeAgentStartupConfig(context.Background(), "openai-codex", nil, startup); err != nil {
					t.Fatalf("start %d: writeAgentStartupConfig: %v", attempt, err)
				}
				data, err := os.ReadFile(configPath)
				if err != nil {
					t.Fatalf("start %d: read config: %v", attempt, err)
				}
				assertCodexFeatures(t, string(data), tc.want)
				assertCodexStartupTOML(t, data, "https://api.example.com/mcp", "SAM_MCP_TOKEN")
				if attempt == 0 {
					first = string(data)
				} else if string(data) != first {
					t.Fatalf("restart changed config.toml:\nfirst:\n%s\nsecond:\n%s", first, data)
				}
			}
		})
	}
}

// installStatefulFakeDocker serves one devcontainer file at /home/testuser/.codex/config.toml,
// backed by configPath, so reads see the previous write.
func installStatefulFakeDocker(t *testing.T, dir, configPath string) {
	t.Helper()
	script := `#!/bin/sh
case " $* " in
  *" printenv CODEX_HOME "*) exit 1 ;;
  *" id -un "*) exit 1 ;;
  *" printenv HOME "*) printf '/home/testuser\n'; exit 0 ;;
  *" test -f /home/testuser/.codex/config.toml "*) test -f "$FAKE_CODEX_CONFIG"; exit $? ;;
  *" cat /home/testuser/.codex/config.toml "*) cat "$FAKE_CODEX_CONFIG"; exit $? ;;
  *" tee /home/testuser/.codex/config.toml "*) cat > "$FAKE_CODEX_CONFIG"; exit 0 ;;
  *) exit 0 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o700); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_CODEX_CONFIG", configPath)
}
