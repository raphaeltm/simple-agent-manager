package messagereport

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

// transportMessages visits one original message or a sequence of reversible
// fragments. Fragment content is byte-for-byte text from the source field;
// tool metadata travels as text fragments so the storage metadata size guard
// cannot silently remove it. The marker identifies the original field and
// order needed to reconstruct the source message.
func transportMessages(msg Message, cfg Config, visit func(Message) error) error {
	budget := cfg.BatchMaxBytes
	if budget > DefaultConfig().BatchMaxBytes {
		budget = DefaultConfig().BatchMaxBytes
	}
	if budget <= 0 || cfg.MaxMessageContentBytes <= 0 {
		return fmt.Errorf("messagereport: invalid transport byte budget")
	}
	if !utf8.ValidString(msg.Content) || !utf8.ValidString(msg.ToolMetadata) {
		return fmt.Errorf("messagereport: message contains invalid UTF-8")
	}
	if len(msg.Content) <= cfg.MaxMessageContentBytes && len(msg.Content)+len(msg.ToolMetadata) <= budget {
		original := apiMessage{MessageID: msg.MessageID, SessionID: msg.SessionID, Role: msg.Role,
			Content: msg.Content, ToolMetadata: msg.ToolMetadata, Timestamp: msg.Timestamp, Origin: msg.Origin}
		body, err := buildBatchPayload([]apiMessage{original})
		if err != nil {
			return err
		}
		if len(body) <= budget {
			return visit(msg)
		}
	}

	part := 0
	for _, field := range []struct{ name, value string }{{"content", msg.Content}, {"toolMetadata", msg.ToolMetadata}} {
		if field.value == "" {
			continue
		}
		remaining := field.value
		for len(remaining) > 0 {
			marker, err := json.Marshal(map[string]any{"samMultipart": map[string]any{
				"messageId": msg.MessageID, "field": field.name, "part": part,
			}})
			if err != nil {
				return err
			}
			fragment := msg
			fragment.MessageID = fmt.Sprintf("%s~sam-part-%d", msg.MessageID, part)
			fragment.ToolMetadata = string(marker)
			if field.name == "toolMetadata" {
				fragment.Role = "tool"
			}
			fragment.Content = ""
			base := rowToAPIMessage(outboxRow{messageID: fragment.MessageID, sessionID: fragment.SessionID,
				role: fragment.Role, content: "", createdAt: fragment.Timestamp})
			base.ToolMetadata = fragment.ToolMetadata
			base.Origin = fragment.Origin
			emptyBody, err := buildBatchPayload([]apiMessage{base})
			if err != nil {
				return err
			}
			// JSON escaping can expand one source byte to six bytes. Reserve
			// that worst case and check the actual body before every visit.
			maxBytes := (budget - len(emptyBody)) / 6
			if maxBytes > cfg.MaxMessageContentBytes {
				maxBytes = cfg.MaxMessageContentBytes
			}
			if maxBytes < utf8.UTFMax {
				return fmt.Errorf("messagereport: transport budget cannot hold one rune")
			}
			end := min(len(remaining), maxBytes)
			for end > 0 && end < len(remaining) && !utf8.RuneStart(remaining[end]) {
				end--
			}
			if end == 0 {
				return fmt.Errorf("messagereport: transport budget split a rune")
			}
			fragment.Content = remaining[:end]
			base.Content = fragment.Content
			serialized, err := buildBatchPayload([]apiMessage{base})
			if err != nil {
				return err
			}
			if len(serialized) > budget {
				return fmt.Errorf("messagereport: fragment exceeds transport budget")
			}
			if err := visit(fragment); err != nil {
				return err
			}
			remaining = remaining[end:]
			part++
		}
	}
	return nil
}
