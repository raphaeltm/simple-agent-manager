package acp

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const (
	codexManagedFeaturesStartMarker = "# BEGIN SAM MANAGED FEATURES"
	codexManagedFeaturesEndMarker   = "# END SAM MANAGED FEATURES"
)

// codexDisabledByDefaultFeatures are Codex feature flags SAM turns off so a session
// only has the tools, skills and MCP servers SAM or the user configured. Codex
// 0.160.0 enables all three by default:
//   - apps: ChatGPT apps and connectors, served through the codex_apps MCP server
//   - plugins: plugin loading, including the OpenAI-curated plugins and their skills
//   - remote_plugin: downloading the remote plugin catalog
//
// They are written to config.toml rather than CODEX_CONFIG because codex-acp starts
// `codex app-server` without config overrides and applies CODEX_CONFIG per thread
// only, while plugins and apps are loaded from the base config. A value the user's
// own config.toml sets for one of these keys wins over SAM's default.
var codexDisabledByDefaultFeatures = []string{"apps", "plugins", "remote_plugin"}

type codexFeaturePlacement int

const (
	codexFeaturesNone codexFeaturePlacement = iota
	// codexFeaturesOwnTable: the user config has no [features] table, so SAM writes one.
	codexFeaturesOwnTable
	// codexFeaturesUserTable: the user config has a [features] header; a second header
	// is invalid TOML, so SAM's keys go directly under the user's header.
	codexFeaturesUserTable
	// codexFeaturesTopLevelDotted: the user config defines features with top-level
	// dotted keys (features.x = ...), so SAM adds its own dotted keys beside them.
	codexFeaturesTopLevelDotted
)

type codexFeaturePlan struct {
	placement codexFeaturePlacement
	// keys are the managed features the user config does not set.
	keys []string
	// headerLine is the index of the user's [features] header in the cleaned config
	// lines. Only meaningful for codexFeaturesUserTable.
	headerLine int
}

// planCodexManagedFeatures decides which managed feature defaults to write and where,
// given the user's config.toml with every SAM-managed block already removed.
func planCodexManagedFeatures(cleaned string) codexFeaturePlan {
	var root map[string]any
	if err := toml.Unmarshal([]byte(cleaned), &root); err != nil {
		slog.Warn("Codex config: existing config.toml is not valid TOML; leaving Codex feature flags at their defaults",
			"error", err)
		return codexFeaturePlan{}
	}
	userFeatures, defined := root["features"]
	userTable, _ := userFeatures.(map[string]any)
	keys := make([]string, 0, len(codexDisabledByDefaultFeatures))
	for _, key := range codexDisabledByDefaultFeatures {
		if _, set := userTable[key]; !set {
			keys = append(keys, key)
		}
	}
	switch {
	case len(keys) == 0:
		return codexFeaturePlan{}
	case !defined:
		return codexFeaturePlan{placement: codexFeaturesOwnTable, keys: keys}
	}
	if line := codexFeaturesHeaderLine(cleaned); line >= 0 {
		return codexFeaturePlan{placement: codexFeaturesUserTable, keys: keys, headerLine: line}
	}
	if codexTopLevelAssignmentKeys(cleaned)["features"] {
		// Also reached by an inline table (features = { ... }), which cannot be
		// extended; mergeManagedCodexMcpConfig's validation then drops SAM's keys.
		return codexFeaturePlan{placement: codexFeaturesTopLevelDotted, keys: keys}
	}
	// features is defined only through [features.<name>] sub-tables, and TOML allows
	// the [features] super-table to be declared once alongside them.
	return codexFeaturePlan{placement: codexFeaturesOwnTable, keys: keys}
}

// codexFeaturesHeaderLine returns the line index of a [features] table header, or -1.
func codexFeaturesHeaderLine(config string) int {
	lines := strings.Split(config, "\n")
	starts := codexTOMLStatementStarts(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !starts[i] || !strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "[[") {
			continue
		}
		var header map[string]any
		if err := toml.Unmarshal([]byte(trimmed), &header); err != nil || len(header) != 1 {
			continue
		}
		// [features.x] parses to a non-empty features table; only [features] is empty.
		if table, ok := header["features"].(map[string]any); ok && len(table) == 0 {
			return i
		}
	}
	return -1
}

// renderCodexFeaturesBlock renders the marked block for a plan. The markers let the
// next merge remove these lines wherever they were placed.
func renderCodexFeaturesBlock(plan codexFeaturePlan) string {
	var b strings.Builder
	b.WriteString(codexManagedFeaturesStartMarker)
	b.WriteString("\n# Added by SAM vm-agent: Codex apps and plugins stay off unless this file sets them.\n")
	prefix := ""
	switch plan.placement {
	case codexFeaturesOwnTable:
		b.WriteString("[features]\n")
	case codexFeaturesTopLevelDotted:
		prefix = "features."
	}
	for _, key := range plan.keys {
		b.WriteString(fmt.Sprintf("%s%s = false\n", prefix, key))
	}
	b.WriteString(codexManagedFeaturesEndMarker)
	return b.String()
}

// insertCodexFeaturesIntoUserTable places the block directly under the user's
// [features] header so the keys belong to that table.
func insertCodexFeaturesIntoUserTable(cleaned string, plan codexFeaturePlan) string {
	lines := strings.Split(cleaned, "\n")
	at := plan.headerLine + 1
	out := make([]string, 0, len(lines)+len(plan.keys)+3)
	out = append(out, lines[:at]...)
	out = append(out, renderCodexFeaturesBlock(plan))
	out = append(out, lines[at:]...)
	return strings.Join(out, "\n")
}
