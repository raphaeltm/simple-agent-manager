package deploy

import (
	"fmt"
	"strings"
)

func mergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}

	merged := make([]string, 0, len(base)+len(overrides))
	seen := make(map[string]bool, len(overrides))
	for _, item := range base {
		key, _, ok := strings.Cut(item, "=")
		if ok {
			if value, exists := overrides[key]; exists {
				merged = append(merged, fmt.Sprintf("%s=%s", key, value))
				seen[key] = true
				continue
			}
			seen[key] = true
		}
		merged = append(merged, item)
	}
	for key, value := range overrides {
		if !seen[key] {
			merged = append(merged, fmt.Sprintf("%s=%s", key, value))
			seen[key] = true
		}
	}
	return merged
}

type envRedactor struct {
	values []string
}

func newEnvRedactor(env map[string]string) envRedactor {
	values := make([]string, 0, len(env))
	for _, value := range env {
		if len(value) >= 6 {
			values = append(values, value)
		}
	}
	return envRedactor{values: values}
}

func (r envRedactor) redact(value string) string {
	result := value
	for _, secret := range r.values {
		result = strings.ReplaceAll(result, secret, "[REDACTED]")
	}
	return result
}

func (r envRedactor) redactError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s", r.redact(err.Error()))
}

func argsContainConfig(args []string) bool {
	for _, arg := range args {
		if arg == "config" {
			return true
		}
	}
	return false
}

func composeStderrHasMissingVar(stderr string) bool {
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "variable is not set") ||
		strings.Contains(lower, "required variable") ||
		strings.Contains(lower, "not set. defaulting to a blank string")
}
