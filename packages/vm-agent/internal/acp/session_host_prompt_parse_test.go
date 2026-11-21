package acp

import (
	"encoding/json"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

// parsePromptBlocks must preserve the ACP-standard optional `_meta` and
// `annotations` fields on a text content block. This is the INBOUND read step:
// the vm-agent needs the SAM "system-injected" marker in memory so a future
// consumer (mirror/persistence) can tag the user message origin=system.
//
// The SDK also preserves these optional fields when marshaling outward; see
// TestContentBlockMarshal_PreservesMetaAndAnnotations. SAM still records message
// origin independently so untrusted metadata cannot establish a trusted origin.
func TestParsePromptBlocks_PreservesMetaAndAnnotations(t *testing.T) {
	params := json.RawMessage(`{
		"messageId": "m1",
		"prompt": [
			{
				"type": "text",
				"text": "call get_instructions",
				"_meta": { "sam.origin": "system" },
				"annotations": { "audience": ["assistant"], "priority": 0.5 }
			}
		]
	}`)

	blocks, first, msgID, err := parsePromptBlocks(params)
	if err != nil {
		t.Fatalf("parsePromptBlocks error: %v", err)
	}
	if msgID != "m1" {
		t.Fatalf("messageID = %q, want m1", msgID)
	}
	if first != "call get_instructions" {
		t.Fatalf("firstTextContent = %q", first)
	}
	if len(blocks) != 1 {
		t.Fatalf("blocks len = %d, want 1", len(blocks))
	}
	tb := blocks[0].Text
	if tb == nil {
		t.Fatal("blocks[0].Text is nil — expected a text content block")
	}
	if tb.Text != "call get_instructions" {
		t.Fatalf("text = %q", tb.Text)
	}
	if tb.Meta == nil {
		t.Fatal("Meta is nil — _meta was dropped by parse")
	}
	if got := tb.Meta["sam.origin"]; got != "system" {
		t.Fatalf("Meta[sam.origin] = %v, want system", got)
	}
	if tb.Annotations == nil {
		t.Fatal("Annotations is nil — annotations were dropped by parse")
	}
	if len(tb.Annotations.Audience) != 1 || tb.Annotations.Audience[0] != acpsdk.RoleAssistant {
		t.Fatalf("Audience = %v, want [assistant]", tb.Annotations.Audience)
	}
	if tb.Annotations.Priority == nil || *tb.Annotations.Priority != 0.5 {
		t.Fatalf("Priority = %v, want 0.5", tb.Annotations.Priority)
	}
}

// A plain text block (no _meta/annotations) must still parse unchanged.
func TestParsePromptBlocks_PlainTextRegression(t *testing.T) {
	params := json.RawMessage(`{"messageId":"m2","prompt":[{"type":"text","text":"hello"}]}`)
	blocks, first, msgID, err := parsePromptBlocks(params)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if msgID != "m2" || first != "hello" || len(blocks) != 1 {
		t.Fatalf("unexpected: msgID=%q first=%q len=%d", msgID, first, len(blocks))
	}
	tb := blocks[0].Text
	if tb == nil || tb.Text != "hello" || tb.Type != "text" {
		t.Fatalf("text block malformed: %+v", tb)
	}
	if tb.Meta != nil {
		t.Fatalf("Meta = %v, want nil for a plain block", tb.Meta)
	}
	if tb.Annotations != nil {
		t.Fatalf("Annotations = %v, want nil for a plain block", tb.Annotations)
	}
}

// Non-text blocks and empty-text blocks are still skipped (existing behavior),
// and firstTextContent tracks the first non-empty text block.
func TestParsePromptBlocks_SkipsNonTextAndEmpty(t *testing.T) {
	params := json.RawMessage(`{
		"messageId": "m3",
		"prompt": [
			{ "type": "image", "text": "" },
			{ "type": "text", "text": "" },
			{ "type": "text", "text": "real", "_meta": { "k": "v" } }
		]
	}`)
	blocks, first, _, err := parsePromptBlocks(params)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("blocks len = %d, want 1 (image + empty skipped)", len(blocks))
	}
	if first != "real" {
		t.Fatalf("firstTextContent = %q, want real", first)
	}
	if blocks[0].Text == nil || blocks[0].Text.Meta["k"] != "v" {
		t.Fatalf("surviving block lost its _meta: %+v", blocks[0].Text)
	}
}

// The stable SDK preserves content metadata and annotations on both prompt and
// notification serialization. SAM still carries its authoritative origin field
// independently; metadata from a peer is never an authorization signal.
func TestContentBlockMarshal_PreservesMetaAndAnnotations(t *testing.T) {
	priority := 0.9
	block := acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{
		Type:        "text",
		Text:        "call get_instructions",
		Meta:        map[string]any{"sam.origin": "system"},
		Annotations: &acpsdk.Annotations{Audience: []acpsdk.Role{acpsdk.RoleAssistant}, Priority: &priority},
	}}

	data, err := json.Marshal(block)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wire["text"] != "call get_instructions" || wire["type"] != "text" {
		t.Fatalf("expected type+text to survive, got %v", wire)
	}
	if meta, ok := wire["_meta"].(map[string]any); !ok || meta["sam.origin"] != "system" {
		t.Fatalf("SDK lost content metadata: %v", wire)
	}
	if annotations, ok := wire["annotations"].(map[string]any); !ok || annotations["priority"] != priority {
		t.Fatalf("SDK lost content annotations: %v", wire)
	}
}

// The actual mirror keeps ACP metadata while SAM's independent origin field
// remains authoritative across the vm-agent broadcast and persistence path.
func TestInjectUserMessageNotifications_SDKMarshalPreservesMetadataAndSAMOrigin(t *testing.T) {
	host := newTestSessionHost(t)
	defer host.Stop()

	block := acpsdk.ContentBlock{Text: &acpsdk.ContentBlockText{
		Type:        "text",
		Text:        "call get_instructions",
		Meta:        map[string]any{"sam.origin": "system"},
		Annotations: &acpsdk.Annotations{Audience: []acpsdk.Role{acpsdk.RoleAssistant}},
	}}

	host.injectUserMessageNotifications(acpsdk.SessionId("sess"), []acpsdk.ContentBlock{block}, "msg-1")

	host.bufMu.RLock()
	buffered := make([][]byte, 0, len(host.messageBuf))
	for _, m := range host.messageBuf {
		buffered = append(buffered, m.Data)
	}
	host.bufMu.RUnlock()

	if len(buffered) == 0 {
		t.Fatal("no messages broadcast by injectUserMessageNotifications")
	}

	var sawUserUpdate bool
	for _, data := range buffered {
		var env struct {
			Method string `json:"method"`
			Params struct {
				Update acpsdk.SessionUpdate `json:"update"`
				Origin string               `json:"origin"`
			} `json:"params"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Method != "session/update" || env.Params.Update.UserMessageChunk == nil {
			continue
		}
		sawUserUpdate = true
		tb := env.Params.Update.UserMessageChunk.Content.Text
		if tb == nil || tb.Text != "call get_instructions" {
			t.Fatalf("mirror dropped the text itself: %+v", tb)
		}
		if tb.Meta["sam.origin"] != "system" {
			t.Fatalf("mirror lost content metadata: %v", tb.Meta)
		}
		if tb.Annotations == nil || len(tb.Annotations.Audience) != 1 || tb.Annotations.Audience[0] != acpsdk.RoleAssistant {
			t.Fatalf("mirror lost content annotations: %v", tb.Annotations)
		}
		if env.Params.Origin != OriginSystem {
			t.Fatalf("SAM broadcast origin = %q, want %q", env.Params.Origin, OriginSystem)
		}
	}
	if !sawUserUpdate {
		t.Fatal("no session/update user_message broadcast found")
	}
}
