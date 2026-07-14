package acp

import (
	"encoding/json"
	"strings"
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
	raw, err := json.Marshal(value)
	if err != nil || len(raw) <= 2 {
		return normalizedToolOutput{}
	}
	var output map[string]json.RawMessage
	if err := json.Unmarshal(raw, &output); err != nil {
		return normalizedToolOutput{}
	}
	if formattedRaw, ok := output["formatted_output"]; ok {
		var formatted string
		if json.Unmarshal(formattedRaw, &formatted) != nil || formatted == "" {
			return normalizedToolOutput{}
		}
		formatted = truncateContent(formatted)
		terminal := map[string]any{"type": "terminal", "output": formatted}
		if exitRaw, ok := output["exit_code"]; ok {
			var exitCode int
			if json.Unmarshal(exitRaw, &exitCode) == nil {
				terminal["exitCode"] = exitCode
			}
		}
		return normalizedContentItem(formatted, terminal)
	}
	if errorRaw, ok := output["error"]; ok && string(errorRaw) != "null" {
		text := rawOutputValueText(errorRaw)
		if text == "" {
			return normalizedToolOutput{}
		}
		text = truncateContent("Error: " + text)
		return normalizedContentItem(text, textContentItem(text))
	}
	if resultRaw, ok := output["result"]; ok && string(resultRaw) != "null" {
		text := rawOutputValueText(resultRaw)
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

func rawOutputValueText(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return toolOutputValueText(value, 0)
}

func toolOutputValueText(value any, depth int) string {
	if depth > 5 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case float64, bool:
		return strings.TrimSpace(string(marshalJSON(typed)))
	case []any:
		parts := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text := strings.TrimSpace(toolOutputValueText(entry, depth+1)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		for _, key := range []string{"text", "output", "content", "message", "result"} {
			if text := strings.TrimSpace(toolOutputValueText(typed[key], depth+1)); text != "" {
				return text
			}
		}
		return strings.TrimSpace(string(marshalJSON(typed)))
	default:
		return ""
	}
}

func marshalJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}
