package tools

import "fmt"

// PermissionMode controls how tool execution is gated.
type PermissionMode string

const (
	// PermissionAllowAll executes all tools without prompting (default).
	PermissionAllowAll PermissionMode = "allow-all"
	// PermissionDenyDangerous requires approval for tools tagged as Dangerous.
	PermissionDenyDangerous PermissionMode = "deny-dangerous"
	// PermissionAskAlways requires approval for every tool call.
	PermissionAskAlways PermissionMode = "ask-always"
)

// ParsePermissionMode converts a string flag value to a PermissionMode.
func ParsePermissionMode(s string) (PermissionMode, error) {
	switch s {
	case "allow-all", "":
		return PermissionAllowAll, nil
	case "deny-dangerous":
		return PermissionDenyDangerous, nil
	case "ask-always":
		return PermissionAskAlways, nil
	default:
		return "", fmt.Errorf("unknown permission mode: %q (use allow-all, deny-dangerous, or ask-always)", s)
	}
}

// DangerLevel classifies how risky a tool operation is.
type DangerLevel int

const (
	// Safe tools only read state (read_file, grep, glob, git_status, git_log, git_diff).
	Safe DangerLevel = iota
	// Write tools modify files (write_file, edit_file, apply_diff).
	Write
	// Dangerous tools execute arbitrary commands or mutate version control (bash, git_commit, git_branch).
	Dangerous
)

// String returns the human-readable name of a DangerLevel.
func (d DangerLevel) String() string {
	switch d {
	case Safe:
		return "safe"
	case Write:
		return "write"
	case Dangerous:
		return "dangerous"
	default:
		return "unknown"
	}
}

// DangerLeveler is an optional interface that tools can implement to declare
// their danger level. Tools that don't implement this default to Dangerous.
type DangerLeveler interface {
	DangerLevel() DangerLevel
}

// PermissionChecker decides whether a tool call should proceed.
type PermissionChecker interface {
	CheckPermission(toolName string, params map[string]any, level DangerLevel) (bool, error)
}

// AutoApproveChecker always approves — preserves current allow-all behavior.
type AutoApproveChecker struct{}

func (AutoApproveChecker) CheckPermission(string, map[string]any, DangerLevel) (bool, error) {
	return true, nil
}

// defaultDangerLevels maps built-in tool names to their danger levels.
// Tools not in this map and not implementing DangerLeveler default to Dangerous.
var defaultDangerLevels = map[string]DangerLevel{
	"read_file":   Safe,
	"grep":        Safe,
	"glob":        Safe,
	"git_status":  Safe,
	"git_log":     Safe,
	"git_diff":    Safe,
	"write_file":  Write,
	"edit_file":   Write,
	"apply_diff":  Write,
	"bash":        Dangerous,
	"git_commit":  Dangerous,
	"git_branch":  Dangerous,
}

// GetDangerLevel resolves the danger level for a tool. Priority:
// 1. Tool implements DangerLeveler interface
// 2. Tool name in defaultDangerLevels map
// 3. Defaults to Dangerous
func GetDangerLevel(tool Tool) DangerLevel {
	if dl, ok := tool.(DangerLeveler); ok {
		return dl.DangerLevel()
	}
	if level, ok := defaultDangerLevels[tool.Name()]; ok {
		return level
	}
	return Dangerous
}

// NeedsPermission returns true if the given mode and danger level require
// an explicit permission check (i.e., calling PermissionChecker).
func NeedsPermission(mode PermissionMode, level DangerLevel) bool {
	switch mode {
	case PermissionAllowAll:
		return false
	case PermissionAskAlways:
		return true
	case PermissionDenyDangerous:
		return level == Dangerous
	default:
		return true
	}
}
