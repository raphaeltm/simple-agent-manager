package server

import (
	"encoding/json"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
)

func TestBuildInitialPromptParams_PreservesVisibleAndInjectedBlocks(t *testing.T) {
	payload, err := buildInitialPromptParams("user text unchanged", "must call get_instructions")
	if err != nil {
		t.Fatalf("build params: %v", err)
	}
	var decoded struct {
		Prompt []struct {
			Type string         `json:"type"`
			Text string         `json:"text"`
			Meta map[string]any `json:"_meta"`
		} `json:"prompt"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode params: %v", err)
	}
	if len(decoded.Prompt) != 2 {
		t.Fatalf("prompt blocks = %d, want 2", len(decoded.Prompt))
	}
	if decoded.Prompt[0].Text != "user text unchanged" || len(decoded.Prompt[0].Meta) != 0 {
		t.Fatalf("visible block changed or marked: %+v", decoded.Prompt[0])
	}
	if decoded.Prompt[1].Text != "must call get_instructions" {
		t.Fatalf("agent lost injected instructions: %+v", decoded.Prompt[1])
	}
	if decoded.Prompt[1].Meta[acp.MetaOriginKey] != acp.OriginSystem {
		t.Fatalf("injected origin = %v, want %q", decoded.Prompt[1].Meta[acp.MetaOriginKey], acp.OriginSystem)
	}
}
