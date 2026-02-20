package acp

import (
	"encoding/json"
	"testing"
)

func TestParseWebSocketMessage_PingPong(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		wantControl bool
		wantType    ControlMessageType
	}{
		{
			name:        "ping message",
			input:       `{"type":"ping"}`,
			wantControl: true,
			wantType:    MsgPing,
		},
		{
			name:        "pong message",
			input:       `{"type":"pong"}`,
			wantControl: true,
			wantType:    MsgPong,
		},
		{
			name:        "agent_status message",
			input:       `{"type":"agent_status","status":"ready","agentType":"claude-code"}`,
			wantControl: true,
			wantType:    MsgAgentStatus,
		},
		{
			name:        "select_agent message",
			input:       `{"type":"select_agent","agentType":"claude-code"}`,
			wantControl: true,
			wantType:    MsgSelectAgent,
		},
		{
			name:        "session_state message",
			input:       `{"type":"session_state","status":"ready","replayCount":0}`,
			wantControl: true,
			wantType:    MsgSessionState,
		},
		{
			name:        "session_replay_complete message",
			input:       `{"type":"session_replay_complete"}`,
			wantControl: true,
			wantType:    MsgSessionReplayDone,
		},
		{
			name:        "session_prompting message",
			input:       `{"type":"session_prompting"}`,
			wantControl: true,
			wantType:    MsgSessionPrompting,
		},
		{
			name:        "session_prompt_done message",
			input:       `{"type":"session_prompt_done"}`,
			wantControl: true,
			wantType:    MsgSessionPromptDone,
		},
		{
			name:        "ACP JSON-RPC message",
			input:       `{"jsonrpc":"2.0","method":"session/prompt","id":1}`,
			wantControl: false,
			wantType:    "",
		},
		{
			name:        "unknown type",
			input:       `{"type":"unknown_type"}`,
			wantControl: false,
			wantType:    "",
		},
		{
			name:        "invalid JSON",
			input:       `this is not json`,
			wantControl: false,
			wantType:    "",
		},
		{
			name:        "empty object",
			input:       `{}`,
			wantControl: false,
			wantType:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isControl, controlType := ParseWebSocketMessage([]byte(tt.input))
			if isControl != tt.wantControl {
				t.Errorf("isControl = %v, want %v", isControl, tt.wantControl)
			}
			if controlType != tt.wantType {
				t.Errorf("controlType = %q, want %q", controlType, tt.wantType)
			}
		})
	}
}

func TestPongMessageMarshalling(t *testing.T) {
	data, err := json.Marshal(map[string]string{"type": string(MsgPong)})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	expected := `{"type":"pong"}`
	if string(data) != expected {
		t.Errorf("got %s, want %s", string(data), expected)
	}
}
