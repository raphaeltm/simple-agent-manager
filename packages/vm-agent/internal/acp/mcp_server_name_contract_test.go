package acp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Go half of the cross-language MCP server name contract.
//
// The TypeScript half is packages/shared/tests/unit/mcp-server-name-contract.test.ts and reads
// the same fixture. The rule is implemented independently in both languages; without a shared
// corpus they drift silently, and a drift means the control plane accepts a name that the
// vm-agent then refuses, so the user's server is silently renamed to sam-mcp-<i> with no error
// surfaced anywhere.
//
// The two differ in disposition, not in the rule: TypeScript rejects with a 400, Go falls back
// to positional naming. Both must agree on which names are valid.

type mcpNameContract struct {
	Valid      []string          `json:"valid"`
	Invalid    []string          `json:"invalid"`
	Normalized map[string]string `json:"normalized"`
	URLs       struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"urls"`
	HeaderNames struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	} `json:"headerNames"`
}

func loadMcpNameContract(t *testing.T) mcpNameContract {
	t.Helper()
	path := filepath.Join(
		"..", "..", "..", "..",
		"packages", "shared", "src", "fixtures", "mcp-server-name-contract.json",
	)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared name contract fixture (%s): %v", path, err)
	}
	var contract mcpNameContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatalf("parse shared name contract fixture: %v", err)
	}
	// Guard against a fixture that loaded but is empty — an all-clear from zero cases is
	// indistinguishable from a pass (rule 02).
	if len(contract.Valid) < 8 || len(contract.Invalid) < 15 {
		t.Fatalf("contract fixture looks truncated: %d valid, %d invalid",
			len(contract.Valid), len(contract.Invalid))
	}
	return contract
}

func TestMcpServerNameContract_AcceptsValid(t *testing.T) {
	t.Parallel()
	contract := loadMcpNameContract(t)

	for _, name := range contract.Valid {
		if got := sanitizeMcpServerName(name); got == "" {
			t.Errorf("sanitizeMcpServerName(%q) rejected a name the shared contract marks valid", name)
		}
	}
}

func TestMcpServerNameContract_RejectsInvalid(t *testing.T) {
	t.Parallel()
	contract := loadMcpNameContract(t)

	for _, name := range contract.Invalid {
		if got := sanitizeMcpServerName(name); got != "" {
			t.Errorf("sanitizeMcpServerName(%q) = %q, but the shared contract marks it invalid", name, got)
		}
	}
}

func TestMcpServerNameContract_Normalizes(t *testing.T) {
	t.Parallel()
	contract := loadMcpNameContract(t)

	for input, expected := range contract.Normalized {
		if got := sanitizeMcpServerName(input); got != expected {
			t.Errorf("sanitizeMcpServerName(%q) = %q, want %q", input, got, expected)
		}
	}
}

// Header names are judged as exact strings on both sides — no trimming or case folding — so a
// name the control plane stores is byte-for-byte the name written into TOML and mcp-remote
// arguments. The TypeScript half checks MCP_CONNECTION_HEADER_NAME_PATTERN against the same list.
func TestMcpHeaderNameContract(t *testing.T) {
	t.Parallel()
	contract := loadMcpNameContract(t)

	if len(contract.HeaderNames.Valid) < 8 || len(contract.HeaderNames.Invalid) < 15 {
		t.Fatalf("header name corpus looks truncated: %d valid, %d invalid",
			len(contract.HeaderNames.Valid), len(contract.HeaderNames.Invalid))
	}
	for _, name := range contract.HeaderNames.Valid {
		if !ValidMcpHeaderName(name) {
			t.Errorf("ValidMcpHeaderName(%q) rejected a name the shared contract marks valid", name)
		}
	}
	for _, name := range contract.HeaderNames.Invalid {
		if ValidMcpHeaderName(name) {
			t.Errorf("ValidMcpHeaderName(%q) accepted a name the shared contract marks invalid", name)
		}
	}
}
