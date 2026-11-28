package acp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func readSDKWireForm(t *testing.T, field string) acpsdk.CreateElicitationRequest {
	t.Helper()
	input := `{"jsonrpc":"2.0","id":1,"method":"elicitation/create","params":{"mode":"form","sessionId":"sdk-session-1","message":"Choose","requestedSchema":{"type":"object","properties":{"question":` + field + `}}}}` + "\n"
	done := make(chan struct{})
	defer close(done)
	reader := newOrderedPipe(strings.NewReader(input), make(chan struct{}, 1), done, time.Second, func() string { return "sdk-session-1" })
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var frame struct {
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	var request acpsdk.CreateElicitationRequest
	if err := json.Unmarshal(frame.Params, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func TestSDKWireFormRejectsNestedConstraintsBeforeDecode(t *testing.T) {
	for name, field := range map[string]string{
		"string composition": `{"type":"string","allOf":[{"minLength":8}]}`,
		"number multiple":    `{"type":"integer","multipleOf":2}`,
		"option constraint":  `{"type":"string","oneOf":[{"const":"yes","title":"Yes","allOf":[{}]}]}`,
		"array constraint":   `{"type":"array","items":{"type":"string","enum":["yes"],"pattern":"x"}}`,
		"null description":   `{"type":"string","description":null}`,
		"null metadata":      `{"type":"string","_meta":null}`,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, http.StatusCreated)
			host, client := newInteractionHost(recorder)
			t.Cleanup(host.Stop)
			host.ConfigureAcpInteractions(testFormConfig())
			request := readSDKWireForm(t, field)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			response, err := client.CreateElicitation(ctx, request)
			if err != nil || response.Cancel == nil {
				t.Fatalf("response=%+v err=%v", response, err)
			}
			select {
			case <-recorder.creates:
				t.Fatal("unsupported raw constraint was dropped and dispatched")
			default:
			}
		})
	}
}

func TestSDKWireFormValidOwnerControl(t *testing.T) {
	assertSDKWireFormAnswer(t, `{"type":"string","enum":["yes","no"]}`, "yes")
}

func TestSDKWireFormEscapedTextOwnerControl(t *testing.T) {
	assertSDKWireFormAnswer(t, `{"type":"string","description":"`+strings.Repeat("<>&", 100)+`","default":"`+strings.Repeat("<", 100)+`"}`, "yes")
}

// Every accepted schema goes through the ordered reader, SDK decode, durable
// interaction registry and typed response encoding, with the same assertions.
func assertSDKWireFormAnswer(t *testing.T, field string, value any) {
	t.Helper()
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testFormConfig())
	request := readSDKWireForm(t, field)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	responses := make(chan acpsdk.CreateElicitationResponse, 1)
	go func() { response, _ := client.CreateElicitation(ctx, request); responses <- response }()
	created := waitCreate(t, recorder)
	answer := map[string]any{"question": value}
	if got := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, AcpInteractionAnswerDecision{Kind: "accepted", Content: answer, AnswerHash: "fixture"}); got != "consumed" {
		t.Fatalf("receipt=%s", got)
	}
	select {
	case response := <-responses:
		if response.Accept == nil {
			t.Fatalf("response=%+v", response)
		}
		encoded, err := json.Marshal(response.Accept.Content)
		if err != nil {
			t.Fatal(err)
		}
		want, err := json.Marshal(answer)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != string(want) {
			t.Fatalf("content=%s want=%s", encoded, want)
		}
	case <-ctx.Done():
		t.Fatal("typed answer never returned")
	}
}

func TestSDKFormAnswerPrimitiveTypes(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		value       any
	}{
		{"integer", `{"type":"integer"}`, float64(42)},
		{"number", `{"type":"number"}`, 1.5},
		{"boolean", `{"type":"boolean"}`, false},
		{"string array", `{"type":"array","items":{"type":"string","enum":["yes","no"]}}`, []any{"yes"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertSDKWireFormAnswer(t, tc.field, tc.value)
		})
	}
}
