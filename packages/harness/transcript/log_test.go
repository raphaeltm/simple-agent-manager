package transcript

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLog_AppendAndRetrieve(t *testing.T) {
	log := NewLog()

	log.Append(EventLLMRequest, 1, map[string]string{"model": "test"})
	log.Append(EventToolCall, 1, map[string]string{"name": "read_file"})

	if log.Len() != 2 {
		t.Fatalf("len = %d, want 2", log.Len())
	}

	events := log.Events()
	if events[0].Type != EventLLMRequest {
		t.Errorf("event 0 type = %s, want %s", events[0].Type, EventLLMRequest)
	}
	if events[1].Type != EventToolCall {
		t.Errorf("event 1 type = %s, want %s", events[1].Type, EventToolCall)
	}
	if events[0].Turn != 1 {
		t.Errorf("event 0 turn = %d, want 1", events[0].Turn)
	}
}

func TestLog_JSON(t *testing.T) {
	log := NewLog()
	log.Append(EventInfo, 0, "started")

	data, err := log.JSON()
	if err != nil {
		t.Fatalf("JSON() error: %v", err)
	}

	var events []Event
	if err := json.Unmarshal(data, &events); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if events[0].Type != EventInfo {
		t.Errorf("type = %s, want %s", events[0].Type, EventInfo)
	}
}

func TestLog_EventsReturnsCopy(t *testing.T) {
	log := NewLog()
	log.Append(EventInfo, 0, "first")

	events := log.Events()
	events[0].Turn = 999 // modify the copy

	original := log.Events()
	if original[0].Turn != 0 {
		t.Error("Events() did not return a copy — original was modified")
	}
}

func TestSummarizeToolParams_RedactsValuesAndRetainsSafeMetadata(t *testing.T) {
	canary := "sk-live-51N2xREALISTICcanarySecretDoNotPersist"
	params := map[string]any{
		"command": "OPENAI_API_KEY=" + canary + " curl -H 'Authorization: Bearer " + canary + "' https://example.invalid",
		"count":   3,
	}

	summary := SummarizeToolParams(params)
	command := summary["command"]
	if !command.Redacted {
		t.Fatal("command summary is not marked redacted")
	}
	if command.Type != "string" {
		t.Fatalf("command type = %q, want string", command.Type)
	}
	if command.ByteLength != len(params["command"].(string)) {
		t.Fatalf("command byte length = %d, want %d", command.ByteLength, len(params["command"].(string)))
	}
	wantHash := sha256.Sum256([]byte(params["command"].(string)))
	if command.SHA256 != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("command sha256 = %q, want %q", command.SHA256, hex.EncodeToString(wantHash[:]))
	}

	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	jsonText := string(encoded)
	for _, forbidden := range []string{canary, "OPENAI_API_KEY", "Authorization", "curl"} {
		if strings.Contains(jsonText, forbidden) {
			t.Fatalf("summary JSON leaked %q: %s", forbidden, jsonText)
		}
	}
}

type secretFormattingParam struct {
	calls *atomic.Int32
	fn    func()
}

func (p secretFormattingParam) String() string {
	p.calls.Add(1)
	return "fmt-string-leaked-ghp_CANARY_SECRET_DO_NOT_PERSIST"
}

func (p secretFormattingParam) GoString() string {
	p.calls.Add(1)
	return "fmt-gostring-leaked-sk-proj-CANARY_SECRET_DO_NOT_PERSIST"
}

func TestSummarizeToolParams_UnsupportedValuesUseOpaqueMetadataWithoutFormatting(t *testing.T) {
	canaries := []string{
		"fmt-string-leaked-ghp_CANARY_SECRET_DO_NOT_PERSIST",
		"fmt-gostring-leaked-sk-proj-CANARY_SECRET_DO_NOT_PERSIST",
		"nested-xoxb-CANARY_SECRET_DO_NOT_PERSIST",
		"cycle-secret-CANARY_SECRET_DO_NOT_PERSIST",
	}

	var unsupportedCalls atomic.Int32
	var nestedCalls atomic.Int32
	unsupported := secretFormattingParam{calls: &unsupportedCalls, fn: func() {}}
	nested := []any{
		map[string]any{"nested": secretFormattingParam{calls: &nestedCalls, fn: func() {}}},
	}
	cyclic := map[string]any{}
	cyclic["self"] = cyclic

	params := map[string]any{
		"unsupported": unsupported,
		"nested":      nested,
		"cyclic":      cyclic,
	}

	first := SummarizeToolParams(params)
	second := SummarizeToolParams(params)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("unsupported summaries are not deterministic:\nfirst=%#v\nsecond=%#v", first, second)
	}
	if unsupportedCalls.Load() != 0 || nestedCalls.Load() != 0 {
		t.Fatalf("summarization invoked user-controlled formatting methods: unsupported=%d nested=%d", unsupportedCalls.Load(), nestedCalls.Load())
	}

	for key, summary := range first {
		if !summary.Redacted {
			t.Fatalf("%s summary is not marked redacted: %#v", key, summary)
		}
		if summary.ByteLength <= 0 || len(summary.SHA256) != 64 {
			t.Fatalf("%s summary lacks opaque length/hash metadata: %#v", key, summary)
		}
	}
	if first["unsupported"].Type != "transcript.secretFormattingParam" {
		t.Fatalf("unsupported type = %q", first["unsupported"].Type)
	}
	if first["nested"].Type != "[]interface {}" {
		t.Fatalf("nested type = %q", first["nested"].Type)
	}
	if first["cyclic"].Type != "map[string]interface {}" {
		t.Fatalf("cyclic type = %q", first["cyclic"].Type)
	}

	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	jsonText := string(encoded)
	for _, forbidden := range canaries {
		if strings.Contains(jsonText, forbidden) {
			t.Fatalf("summary JSON leaked %q: %s", forbidden, jsonText)
		}
	}
}

func TestLogJSON_UnsupportedToolParamSummariesDoNotLeakFormatterCanaries(t *testing.T) {
	var calls atomic.Int32
	params := map[string]any{
		"value": secretFormattingParam{calls: &calls, fn: func() {}},
	}

	log := NewLog()
	log.Append(EventToolCall, 1, map[string]any{
		"id":                     "call-unsafe",
		"name":                   "unsafe_tool",
		"params":                 SummarizeToolParams(params),
		"params_redacted":        true,
		"params_summary_version": ToolParamsSummaryVersion,
	})

	jsonBytes, err := log.JSON()
	if err != nil {
		t.Fatalf("transcript JSON: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("transcript serialization invoked user-controlled formatting methods: %d", calls.Load())
	}
	jsonText := string(jsonBytes)
	for _, forbidden := range []string{
		"fmt-string-leaked-ghp_CANARY_SECRET_DO_NOT_PERSIST",
		"fmt-gostring-leaked-sk-proj-CANARY_SECRET_DO_NOT_PERSIST",
	} {
		if strings.Contains(jsonText, forbidden) {
			t.Fatalf("transcript JSON leaked %q: %s", forbidden, jsonText)
		}
	}
}
