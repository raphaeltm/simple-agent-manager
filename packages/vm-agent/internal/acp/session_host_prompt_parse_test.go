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
// NOTE: this only makes the marker AVAILABLE in-process. It does NOT make it
// survive OUTWARD — see TestContentBlockMarshal_DropsMetaAndAnnotations for the
// acp-go-sdk marshaling limitation that blocks carrying the marker on the ACP
// wire (to the agent CLI or via SDK-marshaled broadcasts).
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

// CHARACTERIZATION (constraint guard): acp-go-sdk v0.13.5's
// ContentBlock.MarshalJSON reconstructs the text variant as ONLY {type, text},
// deliberately dropping `_meta` and `annotations`. This is the exact serializer
// used both when sending a prompt to the agent CLI (acpConn.Prompt) and when the
// SDK marshals SessionNotification blocks. It means a SAM origin marker CANNOT
// be carried outward on the ACP content block itself with this SDK version.
//
// If this test ever FAILS after an SDK bump, the SDK started preserving these
// fields — revisit whether the marker can ride the ACP block directly.
func TestContentBlockMarshal_DropsMetaAndAnnotations(t *testing.T) {
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
	if _, ok := wire["_meta"]; ok {
		t.Fatalf("SDK unexpectedly preserved _meta on the wire: %v — the marker CAN now ride the ACP block; revisit design", wire)
	}
	if _, ok := wire["annotations"]; ok {
		t.Fatalf("SDK unexpectedly preserved annotations on the wire: %v — revisit design", wire)
	}
}

// CHARACTERIZATION (real mirror path): because the SDK marshaler strips the
// marker (see above), the live user-message mirror broadcast produced by
// injectUserMessageNotifications does NOT carry _meta/annotations either, even
// when the in-memory block has them. The origin-tagging consumer slice must
// therefore propagate `origin` via the vm-agent's OWN mirror/persistence fields
// (e.g. an ExtractedMessage.Origin + a distinct broadcast field), NOT by relying
// on the ACP block's _meta surviving.
func TestInjectUserMessageNotifications_SDKMarshalStripsMarker(t *testing.T) {
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
		if len(tb.Meta) != 0 {
			t.Fatalf("unexpected: mirror preserved _meta (%v) — SDK behavior changed, revisit design", tb.Meta)
		}
		if tb.Annotations != nil {
			t.Fatalf("unexpected: mirror preserved annotations (%v) — SDK behavior changed, revisit design", tb.Annotations)
		}
		if env.Params.Origin != OriginSystem {
			t.Fatalf("SAM broadcast origin = %q, want %q", env.Params.Origin, OriginSystem)
		}
	}
	if !sawUserUpdate {
		t.Fatal("no session/update user_message broadcast found")
	}
}
