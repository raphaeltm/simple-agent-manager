package acp

import (
	"encoding/json"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestRawFormGuardRejectsConstraintsPinnedSDKWouldDrop(t *testing.T) {
	for _, extra := range []string{`"additionalProperties":false,`, `"allOf":[{"required":["question"]}],`} {
		line := []byte(`{"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{"mode":"form","sessionId":"session-1","message":"Choose","requestedSchema":{"type":"object",` + extra + `"properties":{"question":{"type":"string"}}}}}`)
		guarded := guardRawElicitationSchema(line, "session-1")
		var frame struct {
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(guarded, &frame); err != nil {
			t.Fatal(err)
		}
		var request acpsdk.UnstableCreateElicitationRequest
		if err := json.Unmarshal(frame.Params, &request); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(request.Form.RequestedSchema)
		if err != nil {
			t.Fatal(err)
		}
		var schema map[string]any
		if err := json.Unmarshal(encoded, &schema); err != nil {
			t.Fatal(err)
		}
		if validateAcpFormSchema(schema, acpFormLimits{schemaBytes: 16 * 1024, properties: 20, enum: 50, answerBytes: 16 * 1024, stringBytes: 4 * 1024, keyChars: 128, labelChars: 200}) {
			t.Fatal("SDK decoded an unsupported root constraint as an acceptable form")
		}
	}
}

func TestRawFormGuardRejectsWrongSessionBeforeSDKDropsScope(t *testing.T) {
	line := []byte(`{"jsonrpc":"2.0","id":8,"method":"elicitation/create","params":{"mode":"form","sessionId":"old-session","message":"Old question","requestedSchema":{"type":"object","properties":{"question":{"type":"string"}}}}}`)
	guarded := guardRawElicitationSchema(line, "current-session")
	var frame struct {
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(guarded, &frame); err != nil {
		t.Fatal(err)
	}
	var request acpsdk.UnstableCreateElicitationRequest
	if err := json.Unmarshal(frame.Params, &request); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(request.Form.RequestedSchema)
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(encoded, &schema); err != nil {
		t.Fatal(err)
	}
	if validateAcpFormSchema(schema, acpFormLimits{schemaBytes: 16 * 1024, properties: 20, enum: 50, answerBytes: 16 * 1024, stringBytes: 4 * 1024, keyChars: 128, labelChars: 200}) {
		t.Fatal("wrong-session form survived SDK scope loss")
	}
}
