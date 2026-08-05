package transcript

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
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
