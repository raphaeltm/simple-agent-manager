package acp

import (
	"encoding/json"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Decode the real wrapper wire shapes rather than constructing the SDK's Go
// representations: changes to raw JSON or Patch must reach the consumers.
func TestSDKWireToolOutputAndMetadata(t *testing.T) {
	for _, kind := range []string{"tool_call", "tool_call_update"} {
		t.Run(kind, func(t *testing.T) {
			wire := `{"sessionId":"s","update":{"sessionUpdate":"` + kind + `","toolCallId":"t","title":"Run","kind":"execute","status":"completed","rawOutput":{"formatted_output":"wire output","exit_code":0},"_meta":{"claudeCode":{"toolName":"Bash"}}}}`
			var notification acpsdk.SessionNotification
			if err := json.Unmarshal([]byte(wire), &notification); err != nil {
				t.Fatal(err)
			}
			messages := ExtractMessages(notification)
			if len(messages) != 1 || !strings.Contains(messages[0].Content, "wire output") {
				t.Fatalf("messages = %#v", messages)
			}
			var meta ToolMeta
			if err := json.Unmarshal([]byte(messages[0].ToolMetadata), &meta); err != nil {
				t.Fatal(err)
			}
			if meta.ToolName != "Bash" || meta.Status != "completed" || len(meta.Content) != 1 {
				t.Fatalf("metadata = %#v", meta)
			}
			if meta.RawInput != nil || meta.RawOutput != nil {
				t.Fatal("generic tool raw fields must remain excluded")
			}
		})
	}
}

func TestSDKWireNullAndAbsentToolUpdatesStayUnchanged(t *testing.T) {
	for _, fields := range []string{``, `,"title":null,"status":null,"content":null,"locations":null,"rawOutput":null,"_meta":null`} {
		var notification acpsdk.SessionNotification
		wire := `{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"t"` + fields + `}}`
		if err := json.Unmarshal([]byte(wire), &notification); err != nil {
			t.Fatal(err)
		}
		if messages := ExtractMessages(notification); len(messages) != 0 {
			t.Fatalf("empty update emitted: %#v", messages)
		}
	}
}

// Fixture encoders keep existing scenario data readable while making the SDK
// representation explicit. A malformed test fixture must fail immediately.
func sdkFixtureJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func sdkFixtureMeta(values map[string]any) acpsdk.Meta {
	meta, err := acpsdk.NewMeta(values)
	if err != nil {
		panic(err)
	}
	return meta
}

func TestSDKWireUsageAndRawJSONKeepLargeIntegers(t *testing.T) {
	var response acpsdk.PromptResponse
	if err := json.Unmarshal([]byte(`{"stopReason":"end_turn","usage":{"inputTokens":4294967297,"outputTokens":2,"totalTokens":4294967299}}`), &response); err != nil {
		t.Fatal(err)
	}
	usage := promptTurnTokenUsage(response, "model")
	if len(usage) != 1 || usage[0].InputTokens != 4294967297 {
		t.Fatalf("usage=%+v", usage)
	}
	var notification acpsdk.SessionNotification
	if err := json.Unmarshal([]byte(`{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t","title":"mcp__sam__display_from_library","kind":"read","status":"completed","rawOutput":{"fileId":9007199254740993}}}`), &notification); err != nil {
		t.Fatal(err)
	}
	messages := ExtractMessages(notification)
	if len(messages) != 1 || !strings.Contains(messages[0].ToolMetadata, `9007199254740993`) {
		t.Fatalf("raw integer changed: %+v", messages)
	}
}

func TestSDKFileLineLimitExtremes(t *testing.T) {
	content := "first\nsecond"
	for _, line := range []int64{1<<63 - 1, 1<<32 + 1} {
		if got := applyLineLimit(content, &line, nil); got != "" {
			t.Fatalf("line %d: %q", line, got)
		}
	}
	zero, huge := int64(0), int64(1<<63-1)
	if got := applyLineLimit(content, &zero, &huge); got != content {
		t.Fatalf("zero line/large limit = %q", got)
	}
	negative := int64(-1)
	if got := applyLineLimit(content, &negative, &negative); got != content {
		t.Fatalf("negative bounds = %q", got)
	}
}

// Snapshot merging already ignores clear-only tool updates on both sides of
// the VM/control-plane boundary. Preserve that behavior during SDK migration.
func TestSDKWireEmptyToolListsKeepSnapshotBehavior(t *testing.T) {
	var notification acpsdk.SessionNotification
	if err := json.Unmarshal([]byte(`{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"t","content":[],"locations":[]}}`), &notification); err != nil {
		t.Fatal(err)
	}
	if messages := ExtractMessages(notification); len(messages) != 0 {
		t.Fatalf("clear-only update changed behavior: %+v", messages)
	}
}
