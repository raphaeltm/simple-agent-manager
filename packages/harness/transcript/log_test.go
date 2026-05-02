package transcript

import (
	"encoding/json"
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
