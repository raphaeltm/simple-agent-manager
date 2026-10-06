package acp

import (
	"strings"
	"testing"
)

// The name resolver is the single source of truth for MCP server naming across ACP, Codex and
// Vibe. Before it existed the rule was implemented three times and had already drifted, so
// these tests pin both the new behaviour (entry names win) and the legacy fallback that
// unnamed entries must keep producing byte-identical config.

func TestResolveMcpServerNames_UsesEntryName(t *testing.T) {
	t.Parallel()

	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Name: SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Name: "zapier"},
		{URL: "https://executor.example/mcp", Name: "executor"},
	})

	want := []string{SamMcpServerName, "zapier", "executor"}
	for i, expected := range want {
		if names[i] != expected {
			t.Errorf("names[%d] = %q, want %q", i, names[i], expected)
		}
	}
}

func TestResolveMcpServerNames_LegacyFallbackForUnnamedEntries(t *testing.T) {
	t.Parallel()

	// A single unnamed entry keeps the historical "sam-mcp".
	single := ResolveMcpServerNames([]McpServerEntry{{URL: "https://a/mcp"}})
	if len(single) != 1 || single[0] != SamMcpServerName {
		t.Errorf("single unnamed entry = %v, want [%s]", single, SamMcpServerName)
	}

	// Multiple unnamed entries keep the historical positional suffixes.
	multi := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://a/mcp"},
		{URL: "https://b/mcp"},
	})
	if multi[0] != "sam-mcp-0" || multi[1] != "sam-mcp-1" {
		t.Errorf("unnamed entries = %v, want [sam-mcp-0 sam-mcp-1]", multi)
	}
}

func TestResolveMcpServerNames_MixedNamedAndUnnamed(t *testing.T) {
	t.Parallel()

	// An old control plane cannot produce this, but a partially-populated payload must still
	// yield unique names rather than colliding.
	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://a/mcp", Name: SamMcpServerName},
		{URL: "https://b/mcp"},
	})
	if names[0] != SamMcpServerName {
		t.Errorf("names[0] = %q, want %q", names[0], SamMcpServerName)
	}
	if names[1] != "sam-mcp-1" {
		t.Errorf("names[1] = %q, want sam-mcp-1", names[1])
	}
}

func TestResolveMcpServerNames_AlwaysUnique(t *testing.T) {
	t.Parallel()

	// Harness config formats key servers by name; a duplicate would silently drop one.
	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://a/mcp", Name: "zapier"},
		{URL: "https://b/mcp", Name: "zapier"},
		{URL: "https://c/mcp", Name: "zapier"},
	})

	seen := map[string]bool{}
	for i, name := range names {
		if seen[name] {
			t.Errorf("duplicate name %q at index %d (all: %v)", name, i, names)
		}
		seen[name] = true
	}
	if len(seen) != 3 {
		t.Errorf("expected 3 unique names, got %d: %v", len(seen), names)
	}
}

func TestResolveMcpServerNames_RejectsUnsafeNames(t *testing.T) {
	t.Parallel()

	// These would break a TOML bare key, an env var name, or shell/TOML quoting. Each must
	// fall back to the positional scheme rather than reaching a config file.
	unsafe := []string{
		"has space",
		"has\"quote",
		"has\nnewline",
		"-leading",
		"trailing-",
		"has.dot",
		"has/slash",
		"has$dollar",
		"has\\backslash",
		"has=equals",
		strings.Repeat("a", 33),
	}

	for _, name := range unsafe {
		names := ResolveMcpServerNames([]McpServerEntry{{URL: "https://a/mcp", Name: name}})
		if names[0] != SamMcpServerName {
			t.Errorf("unsafe name %q resolved to %q, expected positional fallback", name, names[0])
		}
	}
}

func TestResolveMcpServerNames_NormalizesCase(t *testing.T) {
	t.Parallel()

	// Case is normalized rather than rejected. The control plane already lowercases on write,
	// and silently renaming a user's server to "sam-mcp-0" because they typed a capital would
	// be worse than accepting it — the lowercased form is still a valid TOML key and env var
	// component.
	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://a/mcp", Name: "  Zapier  "},
	})
	if names[0] != "zapier" {
		t.Errorf("names[0] = %q, want zapier", names[0])
	}
}

func TestCodexMcpTokenEnvVar_PreservesLegacyNames(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		SamMcpServerName: "SAM_MCP_TOKEN",
		"sam-mcp-0":      "SAM_MCP_TOKEN_0",
		"sam-mcp-1":      "SAM_MCP_TOKEN_1",
		"zapier":         "SAM_MCP_ZAPIER_TOKEN",
		"my-tools":       "SAM_MCP_MY_TOOLS_TOKEN",
	}

	for name, want := range cases {
		if got := codexMcpTokenEnvVar(name); got != want {
			t.Errorf("codexMcpTokenEnvVar(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestCodexMcpTokenEnvVar_AlwaysClassifiedSecret(t *testing.T) {
	t.Parallel()

	// isSecretEnvVar in process.go classifies by the "_TOKEN"/"_KEY"/"_SECRET" substrings.
	// A name that failed to produce one of those would be passed through docker exec argv and
	// become visible in /proc/*/cmdline.
	for _, name := range []string{SamMcpServerName, "sam-mcp-0", "zapier", "my-tools", "x"} {
		envVar := codexMcpTokenEnvVar(name)
		if !isSecretEnvVar(envVar + "=value") {
			t.Errorf("env var %q for server %q is not classified as secret", envVar, name)
		}
	}
}

func TestGenerateCodexMcpConfig_UsesEntryNames(t *testing.T) {
	t.Parallel()

	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Token: "zap-token", Name: "zapier"},
	}, nil, "")

	if !strings.Contains(config, "[mcp_servers.sam-mcp]") {
		t.Error("expected [mcp_servers.sam-mcp] section")
	}
	if !strings.Contains(config, "[mcp_servers.zapier]") {
		t.Error("expected [mcp_servers.zapier] section")
	}
	if !strings.Contains(config, `bearer_token_env_var = "SAM_MCP_ZAPIER_TOKEN"`) {
		t.Errorf("expected zapier bearer env var, got config:\n%s", config)
	}

	joined := strings.Join(envVars, "\n")
	if !strings.Contains(joined, "SAM_MCP_TOKEN=sam-token") {
		t.Errorf("expected SAM_MCP_TOKEN env var, got %v", envVars)
	}
	if !strings.Contains(joined, "SAM_MCP_ZAPIER_TOKEN=zap-token") {
		t.Errorf("expected SAM_MCP_ZAPIER_TOKEN env var, got %v", envVars)
	}
}

func TestGenerateCodexMcpConfig_TokenlessUserServerOmitsBearer(t *testing.T) {
	t.Parallel()

	// A no-auth connection (pre-signed URL) must produce a url-only entry, not a dangling
	// bearer_token_env_var pointing at an unset variable.
	config, envVars := generateCodexMcpConfig([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://presigned.example/mcp?key=abc", Token: "", Name: "composio"},
	}, nil, "")

	if !strings.Contains(config, "[mcp_servers.composio]") {
		t.Error("expected composio section")
	}
	if strings.Contains(config, "SAM_MCP_COMPOSIO_TOKEN") {
		t.Errorf("tokenless server must not emit a bearer env var, got:\n%s", config)
	}
	for _, ev := range envVars {
		if strings.HasPrefix(ev, "SAM_MCP_COMPOSIO_TOKEN=") {
			t.Errorf("tokenless server must not contribute an env var, got %v", envVars)
		}
	}
}

func TestGenerateVibeConfig_UsesEntryNames(t *testing.T) {
	t.Parallel()

	config := generateVibeConfig("mistral-large", []McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Token: "zap-token", Name: "zapier"},
	})

	if !strings.Contains(config, `name = "sam-mcp"`) {
		t.Error("expected sam-mcp entry name")
	}
	if !strings.Contains(config, `name = "zapier"`) {
		t.Errorf("expected zapier entry name, got:\n%s", config)
	}
}

func TestBuildAcpMcpServers_UsesEntryNames(t *testing.T) {
	t.Parallel()

	servers := buildAcpMcpServers([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Token: "zap-token", Name: "zapier"},
		{URL: "https://presigned.example/mcp", Token: "", Name: "composio"},
	}, "claude-code")

	if len(servers) != 3 {
		t.Fatalf("expected 3 servers, got %d", len(servers))
	}

	wantNames := []string{SamMcpServerName, "zapier", "composio"}
	for i, want := range wantNames {
		if servers[i].Http == nil {
			t.Fatalf("server %d is not an HTTP server", i)
		}
		if servers[i].Http.Name != want {
			t.Errorf("server %d name = %q, want %q", i, servers[i].Http.Name, want)
		}
	}

	// The tokenless entry must carry no Authorization header at all.
	if len(servers[2].Http.Headers) != 0 {
		t.Errorf("tokenless server must have no headers, got %v", servers[2].Http.Headers)
	}
	if len(servers[1].Http.Headers) != 1 || servers[1].Http.Headers[0].Value != "Bearer zap-token" {
		t.Errorf("expected bearer header on zapier, got %v", servers[1].Http.Headers)
	}
}

func TestBuildAcpMcpServers_AmpUsesEntryNames(t *testing.T) {
	t.Parallel()

	servers := buildAcpMcpServers([]McpServerEntry{
		{URL: "https://api.example.com/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://mcp.zapier.com/x", Token: "zap-token", Name: "zapier"},
	}, "amp")

	if servers[1].Stdio == nil {
		t.Fatal("amp server should use the stdio bridge")
	}
	if servers[1].Stdio.Name != "zapier" {
		t.Errorf("amp server name = %q, want zapier", servers[1].Stdio.Name)
	}
	// The token must reach the bridge via env, never argv (/proc visibility).
	for _, arg := range servers[1].Stdio.Args {
		if strings.Contains(arg, "zap-token") {
			t.Errorf("token leaked into amp argv: %v", servers[1].Stdio.Args)
		}
	}
}

// The reserved name must be defended by the vm-agent itself, not only by the control plane's
// write-time validation. This is the last point before the name becomes a TOML key and an ACP
// server identity, and the payload arrives over the wire alongside third-party entries.
func TestResolveMcpServerNames_ReservedNameOnlyAtIndexZero(t *testing.T) {
	t.Parallel()

	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://api.sam.internal/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://attacker.example/mcp", Token: "attacker-token", Name: "SAM-MCP"},
	})

	if names[0] != SamMcpServerName {
		t.Errorf("SAM's own entry lost the reserved name: got %q", names[0])
	}
	if names[1] == SamMcpServerName {
		t.Error("a non-index-0 entry was allowed to claim the reserved name")
	}
}

// The imposter must not win even when it arrives first — index 0 is where the control plane
// puts SAM's entry, so a claim at any other index is rejected regardless of ordering.
func TestResolveMcpServerNames_ReservedNameNotStolenByLaterEntry(t *testing.T) {
	t.Parallel()

	names := ResolveMcpServerNames([]McpServerEntry{
		{URL: "https://api.sam.internal/mcp", Token: "sam-token", Name: SamMcpServerName},
		{URL: "https://a.example/mcp", Name: SamMcpServerName},
		{URL: "https://b.example/mcp", Name: SamMcpServerName},
	})

	reserved := 0
	for _, n := range names {
		if n == SamMcpServerName {
			reserved++
		}
	}
	if reserved != 1 {
		t.Errorf("expected exactly one entry named %q, got %d (%v)", SamMcpServerName, reserved, names)
	}
	if names[0] != SamMcpServerName {
		t.Errorf("index 0 must keep the reserved name, got %q", names[0])
	}
}
