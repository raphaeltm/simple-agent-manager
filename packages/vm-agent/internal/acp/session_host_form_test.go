package acp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type sdkFormFixtureAgent struct {
	acpsdk.Agent
	conn      *acpsdk.AgentSideConnection
	responses chan acpsdk.UnstableCreateElicitationResponse
}

func (a *sdkFormFixtureAgent) Prompt(ctx context.Context, _ acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	response, err := a.conn.UnstableCreateElicitation(ctx, fixtureFormRequest())
	if err == nil {
		a.responses <- response
	}
	return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, err
}

func TestFormPinnedSDKWireAndNextPromptOwnership(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	host.ConfigureAcpInteractions(testFormConfig())
	t.Cleanup(host.Stop)
	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	t.Cleanup(func() {
		_ = clientToAgentReader.Close()
		_ = clientToAgentWriter.Close()
		_ = agentToClientReader.Close()
		_ = agentToClientWriter.Close()
	})
	agent := &sdkFormFixtureAgent{responses: make(chan acpsdk.UnstableCreateElicitationResponse, 2)}
	agent.conn = acpsdk.NewAgentSideConnection(agent, agentToClientWriter, clientToAgentReader)
	connection := acpsdk.NewClientSideConnection(client, clientToAgentWriter, agentToClientReader)

	firstAttempt, ok := host.activePromptAttempt()
	if !ok {
		t.Fatal("fixture prompt missing")
	}
	firstDone := make(chan error, 1)
	go func() {
		_, err := connection.Prompt(firstAttempt.ctx, acpsdk.PromptRequest{SessionId: "sdk-session", Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock("first")}})
		firstDone <- err
	}()
	first := waitCreate(t, recorder)
	host.cancelAcpInteractionWaiterForAttempt(first.InteractionID, first.Generation, firstAttempt.id, "wrapper_cancelled")
	if settled := waitSettle(t, recorder); settled.InteractionID != first.InteractionID || settled.Reason != "wrapper_cancelled" {
		t.Fatalf("first settlement = %+v", settled)
	}
	select {
	case response := <-agent.responses:
		if response.Cancel == nil {
			t.Fatalf("cancelled first SDK response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("first SDK form did not cancel")
	}
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first SDK prompt did not finish")
	}
	host.releasePrompt(firstAttempt)
	secondCtx, secondCancel := context.WithCancel(host.lifecycleContext())
	defer secondCancel()
	secondAttempt, ok := host.beginPromptForDelivery(secondCtx, secondCancel, "second-form-prompt", nil)
	if !ok {
		t.Fatal("second prompt was not accepted")
	}
	secondDone := make(chan error, 1)
	go func() {
		_, err := connection.Prompt(secondCtx, acpsdk.PromptRequest{SessionId: "sdk-session", Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock("second")}})
		secondDone <- err
	}()
	second := waitCreate(t, recorder)
	if host.cancelAcpInteractionWaiterForAttempt(second.InteractionID, second.Generation, firstAttempt.id, "wrapper_cancelled") {
		t.Fatal("stale prompt cancellation claimed next form")
	}
	if secondAttempt.id == firstAttempt.id {
		t.Fatal("prompt attempt identity was reused")
	}
	hash := sha256.Sum256([]byte(`{"question":"Fast"}`))
	decision := AcpInteractionAnswerDecision{Kind: "accepted", Content: map[string]any{"question": "Fast"}, AnswerHash: hex.EncodeToString(hash[:])}
	if got := host.ResolveAcpInteractionAnswer(second.InteractionID, second.Generation, decision); got != "consumed" {
		t.Fatalf("second form receipt = %s", got)
	}
	if settled := waitSettle(t, recorder); settled.InteractionID != second.InteractionID || settled.Reason != "completed" {
		t.Fatalf("second settlement = %+v", settled)
	}
	select {
	case response := <-agent.responses:
		if response.Accept == nil || response.Accept.Content["question"] != "Fast" {
			t.Fatalf("SDK response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("SDK form did not accept")
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second SDK prompt did not finish")
	}
}

func TestPinnedSDKFormDecodeScopeFieldsAreOmitted(t *testing.T) {
	// v0.13.5 omits these wrapper scope fields. The runtime therefore binds a
	// form to the live prompt attempt and connection generation, never to them.
	var request acpsdk.UnstableCreateElicitationRequest
	input := `{"mode":"form","sessionId":"wrapper-session","toolCallId":"tool-1","message":"Which path?","requestedSchema":{"type":"object","properties":{"question":{"type":"string"}}}}`
	if err := json.Unmarshal([]byte(input), &request); err != nil {
		t.Fatal(err)
	}
	if request.Form == nil || request.Form.Message != "Which path?" {
		t.Fatalf("SDK form decode = %+v", request)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	for _, omitted := range []string{"sessionId", "toolCallId"} {
		if string(encoded) == input || json.Valid(encoded) == false {
			t.Fatalf("SDK re-encode invalid: %s", encoded)
		}
		if jsonContainsKey(encoded, omitted) {
			t.Fatalf("SDK unexpectedly retained %s", omitted)
		}
	}
}

func jsonContainsKey(encoded []byte, key string) bool {
	var object map[string]any
	if json.Unmarshal(encoded, &object) != nil {
		return false
	}
	_, exists := object[key]
	return exists
}

func testFormConfig() AcpInteractionRuntimeConfig {
	config := testInteractionConfig()
	config.FormsEnabled = true
	config.FormDeadlineMs = 2000
	config.FormSchemaMaxBytes = 16 * 1024
	config.FormSchemaMaxProperties = 20
	config.FormSchemaMaxEnum = 50
	config.AnswerMaxBytes = 16 * 1024
	config.AnswerStringMaxBytes = 4 * 1024
	return config
}

func fixtureFormRequest() acpsdk.UnstableCreateElicitationRequest {
	request := acpsdk.NewUnstableCreateElicitationRequestForm(acpsdk.UnstableElicitationSchema{
		Type: "object",
		Properties: map[string]any{
			"question": map[string]any{"type": "string", "oneOf": []any{
				map[string]any{"const": "Fast", "title": "Fast"},
				map[string]any{"const": "Slow", "title": "Slow"},
			}},
		},
		Required: []string{"question"},
	})
	request.Form.Message = "Which path?"
	return request
}

func TestFormRoundTripThroughCloudflareCallbackRegistry(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testFormConfig())
	result := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		response, _ := client.UnstableCreateElicitation(context.Background(), fixtureFormRequest())
		result <- response
	}()
	created := waitCreate(t, recorder)
	if created.Kind != "form" || created.Detail.Message == nil || *created.Detail.Message != "Which path?" ||
		created.Detail.Schema == nil || created.Detail.Options != nil {
		t.Fatalf("form create shape = %+v", created)
	}
	content := map[string]any{"question": "Fast"}
	hash := sha256.Sum256([]byte(`{"question":"Fast"}`))
	decision := AcpInteractionAnswerDecision{Kind: "accepted", Content: content, AnswerHash: hex.EncodeToString(hash[:])}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "consumed" {
		t.Fatalf("receipt = %s", status)
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "duplicate" {
		t.Fatalf("duplicate receipt = %s", status)
	}
	select {
	case response := <-result:
		if response.Accept == nil || response.Accept.Content["question"] != "Fast" {
			t.Fatalf("response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("form callback did not resume")
	}
	if settled := waitSettle(t, recorder); settled.InteractionID != created.InteractionID || settled.Reason != "completed" {
		t.Fatalf("settlement = %+v", settled)
	}
}

func TestFormUnsupportedAndTaskModeCancelWithoutCreate(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	request := fixtureFormRequest()
	if response, _ := client.UnstableCreateElicitation(context.Background(), request); response.Cancel == nil {
		t.Fatalf("task-mode/no-capability response = %+v", response)
	}
	host.ConfigureAcpInteractions(testFormConfig())
	request.Form.RequestedSchema.Properties["question"] = map[string]any{"type": "string", "pattern": "(a+)+$"}
	if response, _ := client.UnstableCreateElicitation(context.Background(), request); response.Cancel == nil {
		t.Fatalf("unsupported constraint response = %+v", response)
	}
	select {
	case created := <-recorder.creates:
		t.Fatalf("unexpected create %+v", created)
	default:
	}
}

func TestFormInboundCancellationFencesLateAnswer(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testFormConfig())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() { response, _ := client.UnstableCreateElicitation(ctx, fixtureFormRequest()); done <- response }()
	created := waitCreate(t, recorder)
	cancel()
	select {
	case response := <-done:
		if response.Cancel == nil {
			t.Fatalf("cancel response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not finish")
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation,
		AcpInteractionAnswerDecision{Kind: "accepted", Content: map[string]any{"question": "Fast"}, AnswerHash: "a"}); status != "no_waiter" {
		t.Fatalf("late answer receipt = %s", status)
	}
}

func TestFormAnswerAfterPromptReleaseCannotConsumeWaiter(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testFormConfig())
	done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		response, _ := client.UnstableCreateElicitation(context.Background(), fixtureFormRequest())
		done <- response
	}()
	created := waitCreate(t, recorder)
	attempt, ok := host.activePromptAttempt()
	if !ok {
		t.Fatal("prompt missing")
	}
	host.releasePrompt(attempt)
	hash := sha256.Sum256([]byte(`{"question":"Fast"}`))
	decision := AcpInteractionAnswerDecision{Kind: "accepted", Content: map[string]any{"question": "Fast"}, AnswerHash: hex.EncodeToString(hash[:])}
	if got := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); got != "no_waiter" {
		t.Fatalf("completed prompt answer receipt = %s", got)
	}
	select {
	case response := <-done:
		if response.Cancel == nil {
			t.Fatalf("completed prompt form response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("released prompt form did not cancel")
	}
}

func TestCodexFormAutoResolutionTightensRuntimeDeadline(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	t.Cleanup(host.Stop)
	host.ConfigureAcpInteractions(testFormConfig())
	request := fixtureFormRequest()
	request.Form.Meta = map[string]any{"codex": map[string]any{"autoResolutionMs": float64(100)}}
	started := time.Now()
	done := make(chan acpsdk.UnstableCreateElicitationResponse, 1)
	go func() {
		response, _ := client.UnstableCreateElicitation(context.Background(), request)
		done <- response
	}()
	created := waitCreate(t, recorder)
	if created.DeadlineAt > started.Add(250*time.Millisecond).UnixMilli() {
		t.Fatalf("Codex auto-resolution deadline was dropped: %d", created.DeadlineAt)
	}
	select {
	case response := <-done:
		if response.Cancel == nil {
			t.Fatalf("expired Codex form response = %+v", response)
		}
	case <-time.After(time.Second):
		t.Fatal("Codex form did not expire")
	}
	if settled := waitSettle(t, recorder); settled.Reason != "expired" {
		t.Fatalf("settlement = %+v", settled)
	}
}
