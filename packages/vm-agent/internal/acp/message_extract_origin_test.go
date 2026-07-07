package acp

import (
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

// ExtractMessages must read the SAM origin marker from a user block's in-memory
// _meta (this happens before any SDK marshaling, so the marker is intact) and
// set it on the ExtractedMessage.
func TestExtractMessages_UserOriginMarker(t *testing.T) {
	withMarker := acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{
					Type: "text",
					Text: "call get_instructions",
					Meta: map[string]any{MetaOriginKey: OriginSystem},
				}},
			},
		},
	}
	msgs := ExtractMessages(withMarker)
	if len(msgs) != 1 || msgs[0].Role != "user" {
		t.Fatalf("expected 1 user message, got %+v", msgs)
	}
	if msgs[0].Origin != OriginSystem {
		t.Fatalf("Origin = %q, want %q", msgs[0].Origin, OriginSystem)
	}

	plain := acpsdk.SessionNotification{
		Update: acpsdk.SessionUpdate{
			UserMessageChunk: &acpsdk.SessionUpdateUserMessageChunk{
				Content: acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{Type: "text", Text: "hi"}},
			},
		},
	}
	pmsgs := ExtractMessages(plain)
	if len(pmsgs) != 1 || pmsgs[0].Origin != "" {
		t.Fatalf("plain user message should have empty Origin, got %+v", pmsgs)
	}
}
