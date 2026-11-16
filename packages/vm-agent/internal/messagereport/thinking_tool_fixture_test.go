package messagereport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/workspace/vm-agent/internal/acp"
)

// TestThinkingToolReporterFixture drives production ACP extraction, the durable
// outbox and HTTP sender. Synthetic proportions: 5% user, 35% thinking, 40%
// assistant and 20% tool (two calls/loop, each initiated then completed).
// Four events per simulated two-second batch represent moderate streaming;
// production reporter configuration is unchanged. Normalize random UUIDs only
// AFTER capture so regeneration is reproducible without bypassing extraction.
// Regenerate with UPDATE_THINKING_TOOL_REPORTER_FIXTURE=1 go test
// ./internal/messagereport -run '^TestThinkingToolReporterFixture$'.
func TestThinkingToolReporterFixture(t *testing.T) {
	reporter, capture := newArchiveFixtureReporter(t)
	counts, seen := map[string]int{}, map[string]bool{}
	contentBytes, metadataBytes := 0, 0
	text := func(value string) acpsdk.ContentBlock {
		return acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{Text: value}}
	}
	for index := 0; index < 1000; index++ {
		position, loop := index%20, index/20
		update := acpsdk.SessionUpdate{}
		switch {
		case position == 0:
			update.UserMessageChunk = &acpsdk.SessionUpdateUserMessageChunk{Content: text(fmt.Sprintf("Inspect synthetic iteration %d", loop))}
		case position >= 1 && position <= 4 || position >= 11 && position <= 13:
			update.AgentThoughtChunk = &acpsdk.SessionUpdateAgentThoughtChunk{Content: text("Consider the synthetic implementation and its verification boundary. ")}
		case position == 5 || position == 14:
			update.ToolCall = &acpsdk.SessionUpdateToolCall{ToolCallId: acpsdk.ToolCallId(fmt.Sprintf("synthetic-call-%d-%d", loop, position)), Title: "Read synthetic module", Kind: acpsdk.ToolKindRead, Status: acpsdk.ToolCallStatusInProgress}
		case position == 6 || position == 15:
			status, title := acpsdk.ToolCallStatusCompleted, "Finished synthetic module"
			update.ToolCallUpdate = &acpsdk.SessionToolCallUpdate{ToolCallId: acpsdk.ToolCallId(fmt.Sprintf("synthetic-call-%d-%d", loop, position-1)), Status: &status, Title: &title}
		default:
			update.AgentMessageChunk = &acpsdk.SessionUpdateAgentMessageChunk{Content: text("Synthetic implementation progress preserves the persisted transcript and lifecycle. ")}
		}
		extracted := acp.ExtractMessages(acpsdk.SessionNotification{SessionId: "synthetic-acp", Update: update})
		if len(extracted) != 1 {
			t.Fatalf("notification %d emitted %d messages", index, len(extracted))
		}
		message := extracted[0]
		if seen[message.MessageID] {
			t.Fatal("extractor reused an emitted message ID")
		}
		seen[message.MessageID] = true
		counts[message.Role]++
		contentBytes += len(message.Content)
		metadataBytes += len(message.ToolMetadata)
		if message.Role == "tool" {
			var meta acp.ToolMeta
			if err := json.Unmarshal([]byte(message.ToolMetadata), &meta); err != nil {
				t.Fatal(err)
			}
			if meta.ToolCallId == "" || meta.Status == "" {
				t.Fatal("tool metadata lost correlation or status")
			}
		}
		if err := reporter.Enqueue(Message{MessageID: message.MessageID, Role: message.Role, Content: message.Content, ToolMetadata: message.ToolMetadata, Origin: message.Origin, Timestamp: time.UnixMilli(1_000_000 + int64(index)*500).UTC().Format("2006-01-02T15:04:05.000Z")}); err != nil {
			t.Fatal(err)
		}
		if (index+1)%4 == 0 {
			reporter.flush()
		}
	}
	assertOutboxCount(t, reporter.db, 0, "after extracted thinking/tool fixture")
	if capture.requests != 250 || len(capture.messages) != 1000 {
		t.Fatalf("transport counts: batches=%d messages=%d", capture.requests, len(capture.messages))
	}
	for role, want := range map[string]int{"user": 50, "thinking": 350, "assistant": 400, "tool": 200} {
		if counts[role] != want {
			t.Fatalf("role %s count=%d want=%d", role, counts[role], want)
		}
	}
	normalized := append([]apiMessage(nil), capture.messages...)
	for index := range normalized {
		if normalized[index].Sequence != int64(index+1) {
			t.Fatal("reporter sequence changed")
		}
		normalized[index].MessageID = fmt.Sprintf("thinking-profile-%05d", index)
	}
	encoded, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join("..", "..", "..", "..", "apps", "api", "tests", "workers", "fixtures", "thinking-tool-reporter-messages.json")
	if os.Getenv("UPDATE_THINKING_TOOL_REPORTER_FIXTURE") == "1" {
		if err := os.WriteFile(path, encoded, 0644); err != nil {
			t.Fatal(err)
		}
	}
	checked, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(checked, encoded) {
		t.Fatal("fixture differs from extracted reporter HTTP output; regenerate explicitly")
	}
	t.Logf("messages=%d batches=%d user=%d thinking=%d assistant=%d tool=%d content_bytes=%d metadata_bytes=%d", len(normalized), capture.requests, counts["user"], counts["thinking"], counts["assistant"], counts["tool"], contentBytes, metadataBytes)
}
