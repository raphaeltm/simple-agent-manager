package acp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

type normalizedToolOutput struct {
	text    string
	content []json.RawMessage
}

// normalizeRawToolOutput adapts the small, reviewed result shapes emitted by
// maintained ACP wrappers into ordinary ACP tool content. It deliberately does
// not retain the source rawOutput object: only allowlisted output fields become
// bounded content, while arbitrary raw fields and every rawInput remain outside
// the durable generic-tool path.
func normalizeRawToolOutput(value any) normalizedToolOutput {
	output, ok := value.(map[string]any)
	if !ok || len(output) == 0 {
		return normalizedToolOutput{}
	}
	if formatted, ok := output["formatted_output"].(string); ok && formatted != "" {
		formatted = truncateContent(formatted)
		terminal := map[string]any{"type": "terminal", "output": formatted}
		if exitCode, ok := integerValue(output["exit_code"]); ok {
			terminal["exitCode"] = exitCode
		}
		return normalizedContentItem(formatted, terminal)
	}
	if errorValue, ok := output["error"]; ok && errorValue != nil {
		text := toolOutputValueText(errorValue, 0, maxToolContentSize)
		if text == "" {
			return normalizedToolOutput{}
		}
		text = truncateContent("Error: " + text)
		return normalizedContentItem(text, textContentItem(text))
	}
	if resultValue, ok := output["result"]; ok && resultValue != nil {
		text := toolOutputValueText(resultValue, 0, maxToolContentSize)
		if text == "" {
			return normalizedToolOutput{}
		}
		text = truncateContent(text)
		return normalizedContentItem(text, textContentItem(text))
	}
	return normalizedToolOutput{}
}

func textContentItem(text string) map[string]any {
	return map[string]any{
		"type":    "content",
		"content": map[string]any{"type": "text", "text": text},
	}
}

func normalizedContentItem(text string, item map[string]any) normalizedToolOutput {
	raw, err := json.Marshal(item)
	if err != nil {
		return normalizedToolOutput{}
	}
	return normalizedToolOutput{text: text, content: []json.RawMessage{raw}}
}

func toolOutputValueText(value any, depth, remaining int) string {
	if depth > 5 || value == nil || remaining <= 0 {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return truncateToByteBudget(typed, remaining)
	case float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, bool:
		return truncateToByteBudget(fmt.Sprint(typed), remaining)
	case []any:
		var builder strings.Builder
		for _, entry := range typed {
			budget := remaining - builder.Len()
			if budget <= 0 {
				break
			}
			if text := strings.TrimSpace(toolOutputValueText(entry, depth+1, budget)); text != "" {
				if builder.Len() > 0 && builder.Len() < remaining {
					builder.WriteByte('\n')
				}
				builder.WriteString(truncateToByteBudget(text, remaining-builder.Len()))
			}
		}
		return builder.String()
	case map[string]any:
		for _, key := range []string{"text", "output", "content", "message", "result"} {
			if text := strings.TrimSpace(toolOutputValueText(typed[key], depth+1, remaining)); text != "" {
				return text
			}
		}
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var builder strings.Builder
		for _, key := range keys {
			budget := remaining - builder.Len()
			if budget <= 0 {
				break
			}
			text := "[redacted]"
			if !sensitiveOutputKey(key) {
				text = strings.TrimSpace(toolOutputValueText(typed[key], depth+1, budget))
			}
			if text == "" {
				continue
			}
			if builder.Len() > 0 && builder.Len() < remaining {
				builder.WriteByte('\n')
			}
			builder.WriteString(truncateToByteBudget(key+": "+text, remaining-builder.Len()))
		}
		return builder.String()
	default:
		return ""
	}
}

func sensitiveOutputKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(key))
	for _, marker := range []string{
		"token", "secret", "credential", "password", "authorization", "apikey",
		"privatekey", "accesskey", "command", "argument", "args",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func truncateToByteBudget(value string, budget int) string {
	if budget <= 0 {
		return ""
	}
	if len(value) <= budget {
		return value
	}
	value = value[:budget]
	for len(value) > 0 && !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func integerValue(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		return int64(typed), typed == float64(int64(typed))
	default:
		return 0, false
	}
}
