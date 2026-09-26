package messagereport

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// apiLimits are the control plane's shipped defaults.
var apiLimits = transportLimits{contentBytes: 100 * 1024, requestBytes: 256 * 1024}

func toolMessage(content, toolMetadata string) Message {
	return Message{
		MessageID:    "msg-1",
		SessionID:    "sess-1",
		Role:         "tool",
		Content:      content,
		ToolMetadata: toolMetadata,
		Timestamp:    "2026-09-25T10:00:00.123456789Z",
	}
}

func toolMetadataJSON(t *testing.T, title string, outputBytes int) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"toolCallId": "call-7",
		"title":      title,
		"kind":       "execute",
		"status":     "completed",
		"toolName":   "Bash",
		"locations":  []map[string]any{{"path": "/repo/main.go", "line": 12}},
		"content": []map[string]any{
			{"type": "content", "content": map[string]any{"type": "text", "text": strings.Repeat("o", outputBytes)}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeSummary(t *testing.T, raw string) toolMetadataSummary {
	t.Helper()
	var summary toolMetadataSummary
	if err := json.Unmarshal([]byte(raw), &summary); err != nil {
		t.Fatalf("metadata is not a summary: %v (%q)", err, raw)
	}
	return summary
}

func TestFitForTransport_LeavesAFittingMessageUntouched(t *testing.T) {
	msg := toolMessage("ran go test", toolMetadataJSON(t, "go test ./...", 4096))
	if got := fitForTransport(msg, apiLimits); got != msg {
		t.Fatalf("fitting message changed:\n got %+v\nwant %+v", got, msg)
	}
}

func TestTruncateContent_CutsOnARuneBoundaryAndMarksTheCut(t *testing.T) {
	content := strings.Repeat("🌊", 1000) // four bytes per rune
	for _, maxBytes := range []int{len(truncationMarker) + 1, 101, 102, 103, 104, 3999} {
		got := truncateContent(content, maxBytes)
		if !utf8.ValidString(got) {
			t.Fatalf("maxBytes=%d produced invalid UTF-8 %q", maxBytes, got)
		}
		if len(got) > maxBytes {
			t.Fatalf("maxBytes=%d produced %d bytes", maxBytes, len(got))
		}
		if !strings.HasSuffix(got, truncationMarker) {
			t.Fatalf("maxBytes=%d did not mark the cut: %q", maxBytes, got)
		}
		kept := strings.TrimSuffix(got, truncationMarker)
		if !strings.HasPrefix(content, kept) || maxBytes-len(got) >= utf8.UTFMax {
			t.Fatalf("maxBytes=%d kept %d bytes, a shorter prefix than fits", maxBytes, len(kept))
		}
	}
}

func TestFitForTransport_SummarizesToolMetadataTooLargeToSend(t *testing.T) {
	raw := toolMetadataJSON(t, "cat build.log", 400*1024)
	msg := toolMessage("build output", raw)

	got := fitForTransport(msg, apiLimits)

	if got.Content != msg.Content {
		t.Fatalf("content changed although only metadata was oversized: %q", got.Content)
	}
	if requestBytes(got) > apiLimits.requestBytes {
		t.Fatalf("request is %d bytes, limit %d", requestBytes(got), apiLimits.requestBytes)
	}
	want := toolMetadataSummary{
		ToolCallID:         "call-7",
		Title:              "cat build.log",
		Kind:               "execute",
		Status:             "completed",
		ToolName:           "Bash",
		ContentTruncated:   true,
		TransportTruncated: true,
		OriginalSizeBytes:  len(raw),
	}
	if summary := decodeSummary(t, got.ToolMetadata); summary != want {
		t.Fatalf("summary = %+v, want %+v", summary, want)
	}
}

func TestFitForTransport_ShortensContentThatJSONMustEscape(t *testing.T) {
	// Each control character is one byte of content but six bytes of JSON.
	msg := toolMessage(strings.Repeat("\x01", 90*1024), "")

	got := fitForTransport(msg, apiLimits)

	if requestBytes(got) > apiLimits.requestBytes {
		t.Fatalf("request is %d bytes, limit %d", requestBytes(got), apiLimits.requestBytes)
	}
	if !strings.HasSuffix(got.Content, truncationMarker) {
		t.Fatalf("shortened content is not marked: %q", got.Content[len(got.Content)-20:])
	}
	longer := got
	longer.Content = truncateContent(msg.Content, len(got.Content)+1)
	if requestBytes(longer) <= apiLimits.requestBytes {
		t.Fatalf("kept %d content bytes although %d would fit", len(got.Content), len(longer.Content))
	}
}

func TestFitForTransport_UnreadableMetadataKeepsOnlyTheRecordOfTheRemoval(t *testing.T) {
	raw := strings.Repeat("m", 300*1024)

	got := fitForTransport(toolMessage("output", raw), apiLimits)

	want := toolMetadataSummary{ContentTruncated: true, TransportTruncated: true, OriginalSizeBytes: len(raw)}
	if summary := decodeSummary(t, got.ToolMetadata); summary != want {
		t.Fatalf("summary = %+v, want %+v", summary, want)
	}
}

func TestFitForTransport_IdentityTooLargeForAnySummaryFallsBackToTheRecord(t *testing.T) {
	raw := toolMetadataJSON(t, strings.Repeat("t", 300*1024), 16)

	got := fitForTransport(toolMessage("output", raw), apiLimits)

	if got.ToolMetadata != truncationRecord(len(raw)) {
		t.Fatalf("metadata = %q, want the bare truncation record", got.ToolMetadata)
	}
	if got.Content != "output" {
		t.Fatalf("content = %q, want it kept", got.Content)
	}
	if requestBytes(got) > apiLimits.requestBytes {
		t.Fatalf("request is %d bytes, limit %d", requestBytes(got), apiLimits.requestBytes)
	}
}

func TestFitForTransport_IsStableForItsOwnOutput(t *testing.T) {
	for _, msg := range []Message{
		toolMessage(strings.Repeat("é", 80*1024), toolMetadataJSON(t, "grep", 300*1024)),
		toolMessage(strings.Repeat("\x01", 90*1024), ""),
		toolMessage("short", strings.Repeat("m", 300*1024)),
	} {
		once := fitForTransport(msg, apiLimits)
		if twice := fitForTransport(once, apiLimits); twice != once {
			t.Fatalf("fitting a fitted message changed it again")
		}
	}
}

func TestOmittedForTransport_KeepsIdentityAndRecordsTheRemoval(t *testing.T) {
	raw := toolMetadataJSON(t, "cat big.json", 1024)
	msg := toolMessage("output", raw)

	got := omittedForTransport(msg)

	if got.Content != omittedMessageMarker || got.ToolMetadata != truncationRecord(len(raw)) {
		t.Fatalf("omitted form = %+v", got)
	}
	if got.MessageID != msg.MessageID || got.SessionID != msg.SessionID || got.Role != msg.Role || got.Timestamp != msg.Timestamp {
		t.Fatalf("omitted form lost message identity: %+v", got)
	}
}
