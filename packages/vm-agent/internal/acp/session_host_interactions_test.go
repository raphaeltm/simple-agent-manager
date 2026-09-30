package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func testInteractionConfig() AcpInteractionRuntimeConfig {
	return AcpInteractionRuntimeConfig{
		Enabled: true, ProtocolVersion: acpInteractionProtocolVersion,
		PermissionDeadlineMs: 2_000, MaxDeadlineMs: 4_000, DeadlineMarginMs: 10,
		RequestMaxBytes: 32 * 1024, OptionsMaxCount: 16, OptionIDMaxChars: 128,
		OptionNameMaxChars: 200, ReceiptLimit: 2,
		ResponseMaxBytes:    64 * 1024,
		SettleRetryDelaysMs: []int{1, 5}, SettleRetrySteadyMs: 10,
	}
}

func permissionRequest() acpsdk.RequestPermissionRequest {
	title := "Run deterministic fixture"
	kind := acpsdk.ToolKindExecute
	return acpsdk.RequestPermissionRequest{
		SessionId: "acp-session",
		ToolCall: acpsdk.ToolCallUpdate{
			ToolCallId: "tool-call-1",
			Title:      &title,
			Kind:       &kind,
			RawInput:   map[string]any{"secret": "must-not-cross-the-boundary"},
		},
		Options: []acpsdk.PermissionOption{
			{OptionId: "reject", Name: "Reject", Kind: acpsdk.PermissionOptionKindRejectOnce},
			{OptionId: "allow", Name: "Allow once", Kind: acpsdk.PermissionOptionKindAllowOnce},
		},
	}
}

type interactionRecorder struct {
	server      *httptest.Server
	creates     chan acpInteractionCreateRequest
	settles     chan acpInteractionSettleRequest
	createBlock <-chan struct{}
}

func newInteractionRecorder(t *testing.T, createStatus int) *interactionRecorder {
	t.Helper()
	recorder := &interactionRecorder{
		creates: make(chan acpInteractionCreateRequest, 8),
		settles: make(chan acpInteractionSettleRequest, 8),
	}
	recorder.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer callback-token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/projects/project-1/workspaces/workspace-1/acp-interactions" {
			var request acpInteractionCreateRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode create: %v", err)
			}
			recorder.creates <- request
			if recorder.createBlock != nil {
				select {
				case <-recorder.createBlock:
				case <-r.Context().Done():
					return
				}
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(createStatus)
			status := "created"
			if createStatus != http.StatusCreated {
				status = "disabled"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": status})
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/settle") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request acpInteractionSettleRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode settle: %v", err)
		}
		recorder.settles <- request
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "settled"})
	}))
	t.Cleanup(recorder.server.Close)
	return recorder
}

func newInteractionHost(recorder *interactionRecorder) (*SessionHost, *sessionHostClient) {
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ControlPlaneURL: recorder.server.URL,
		ProjectID:       "project-1",
		WorkspaceID:     "workspace-1",
		SessionID:       "agent-session-1",
		RuntimeIdentity: "runtime-1",
		CallbackToken:   "callback-token",
		HTTPClient:      recorder.server.Client(),
	}})
	host.ConfigureAcpInteractions(testInteractionConfig())
	generation := host.attachAcpInteractionGeneration()
	promptCtx, promptCancel := context.WithCancel(host.lifecycleContext())
	if _, ok := host.beginPromptForDelivery(promptCtx, promptCancel, "test-prompt", nil); !ok {
		panic("test prompt was not accepted")
	}
	return host, &sessionHostClient{host: host, interactionGeneration: generation}
}

func newBlockedCreateInteractionHost(t *testing.T) (
	*SessionHost,
	*sessionHostClient,
	<-chan acpInteractionCreateRequest,
	<-chan acpInteractionSettleRequest,
	chan struct{},
) {
	t.Helper()
	creates := make(chan acpInteractionCreateRequest, 1)
	settles := make(chan acpInteractionSettleRequest, 1)
	releaseCreate := make(chan struct{})
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/settle") {
			var settle acpInteractionSettleRequest
			if err := json.NewDecoder(request.Body).Decode(&settle); err != nil {
				t.Errorf("decode settle: %v", err)
			}
			settles <- settle
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       http.NoBody,
				Header:     make(http.Header),
			}, nil
		}
		var create acpInteractionCreateRequest
		if err := json.NewDecoder(request.Body).Decode(&create); err != nil {
			t.Errorf("decode create: %v", err)
		}
		creates <- create
		// Deliberately ignore request.Context(). This models an injected client
		// with no transport timeout and proves the permission callback itself is
		// bounded even if the transport does not return on cancellation.
		<-releaseCreate
		return nil, errors.New("create acknowledgement lost")
	})}
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ControlPlaneURL: "https://control-plane.test",
		ProjectID:       "project-1",
		WorkspaceID:     "workspace-1",
		SessionID:       "agent-session-1",
		RuntimeIdentity: "runtime-1",
		CallbackToken:   "callback-token",
		HTTPClient:      httpClient,
	}})
	host.ConfigureAcpInteractions(testInteractionConfig())
	generation := host.attachAcpInteractionGeneration()
	promptCtx, promptCancel := context.WithCancel(host.lifecycleContext())
	if _, ok := host.beginPromptForDelivery(promptCtx, promptCancel, "blocked-create-test", nil); !ok {
		t.Fatal("test prompt was not accepted")
	}
	return host, &sessionHostClient{host: host, interactionGeneration: generation}, creates, settles, releaseCreate
}

func waitCreate(t *testing.T, recorder *interactionRecorder) acpInteractionCreateRequest {
	t.Helper()
	select {
	case request := <-recorder.creates:
		return request
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for durable interaction create")
		return acpInteractionCreateRequest{}
	}
}

func waitSettle(t *testing.T, recorder *interactionRecorder) acpInteractionSettleRequest {
	t.Helper()
	select {
	case request := <-recorder.settles:
		return request
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for durable interaction settle")
		return acpInteractionSettleRequest{}
	}
}

func TestRequestPermissionUsesDurableAuthorityAndExactOptionID(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	defer host.Stop()

	type result struct {
		response acpsdk.RequestPermissionResponse
		err      error
	}
	done := make(chan result, 1)
	go func() {
		response, err := client.RequestPermission(context.Background(), permissionRequest())
		done <- result{response: response, err: err}
	}()
	created := waitCreate(t, recorder)
	if created.Generation != client.interactionGeneration || created.RuntimeIdentity != "runtime-1" ||
		created.AgentSessionID != "agent-session-1" {
		t.Fatalf("create identity = %+v", created)
	}
	if created.Detail.Options[0].ID != "reject" || created.Detail.Options[1].ID != "allow" {
		t.Fatalf("option order changed: %+v", created.Detail.Options)
	}
	encoded, _ := json.Marshal(created.Detail)
	if len(encoded) == 0 || bytes.Contains(encoded, []byte("must-not-cross-the-boundary")) {
		t.Fatalf("raw tool input crossed the interaction boundary: %s", encoded)
	}
	decision := AcpInteractionAnswerDecision{
		Kind: "selected_option", OptionID: "allow", AnswerHash: "answer-hash",
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "consumed" {
		t.Fatalf("answer status = %q", status)
	}
	permissionResult := <-done
	if permissionResult.err != nil || permissionResult.response.Outcome.Selected == nil ||
		permissionResult.response.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("permission result = %+v err=%v", permissionResult.response, permissionResult.err)
	}
	host.bufMu.RLock()
	bufferedMessages := len(host.messageBuf)
	host.bufMu.RUnlock()
	if bufferedMessages != 0 {
		t.Fatalf("permission request was broadcast to viewer buffer, messages=%d", bufferedMessages)
	}
	if settle := waitSettle(t, recorder); settle.Reason != "completed" {
		t.Fatalf("settle reason = %q", settle.Reason)
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "duplicate" {
		t.Fatalf("duplicate status = %q", status)
	}
	decision.OptionID = "reject"
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "conflict" {
		t.Fatalf("conflicting status = %q", status)
	}
}

func TestRequestPermissionCancellationLifecycleSettlesExactlyOnce(t *testing.T) {
	tests := []struct {
		name   string
		cancel func(*SessionHost)
		reason string
	}{
		{name: "process loss", cancel: func(host *SessionHost) { host.cancelInteractionWaiters("connection_closed") }, reason: "connection_closed"},
		{name: "connection replacement", cancel: func(host *SessionHost) { host.attachAcpInteractionGeneration() }, reason: "connection_replaced"},
		{name: "explicit stop", cancel: func(host *SessionHost) { host.Stop() }, reason: "session_stopped"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, http.StatusCreated)
			host, client := newInteractionHost(recorder)
			done := make(chan acpsdk.RequestPermissionResponse, 1)
			go func() {
				response, _ := client.RequestPermission(context.Background(), permissionRequest())
				done <- response
			}()
			waitCreate(t, recorder)
			test.cancel(host)
			response := <-done
			if response.Outcome.Cancelled == nil {
				t.Fatalf("outcome = %+v", response.Outcome)
			}
			if settle := waitSettle(t, recorder); settle.Reason != test.reason {
				t.Fatalf("settle reason = %q, want %q", settle.Reason, test.reason)
			}
			host.Stop()
		})
	}
}

func TestRequestPermissionContextCancelAndDeadlineFailClosed(t *testing.T) {
	t.Run("context cancellation", func(t *testing.T) {
		recorder := newInteractionRecorder(t, http.StatusCreated)
		host, client := newInteractionHost(recorder)
		defer host.Stop()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan acpsdk.RequestPermissionResponse, 1)
		go func() {
			response, _ := client.RequestPermission(ctx, permissionRequest())
			done <- response
		}()
		waitCreate(t, recorder)
		cancel()
		if response := <-done; response.Outcome.Cancelled == nil {
			t.Fatalf("outcome = %+v", response.Outcome)
		}
		if settle := waitSettle(t, recorder); settle.Reason != "wrapper_cancelled" {
			t.Fatalf("settle reason = %q", settle.Reason)
		}
	})

	t.Run("deadline", func(t *testing.T) {
		recorder := newInteractionRecorder(t, http.StatusCreated)
		host, client := newInteractionHost(recorder)
		defer host.Stop()
		config := testInteractionConfig()
		config.PermissionDeadlineMs = 20
		host.ConfigureAcpInteractions(config)
		response, err := client.RequestPermission(context.Background(), permissionRequest())
		if err != nil || response.Outcome.Cancelled == nil {
			t.Fatalf("response = %+v err=%v", response, err)
		}
		waitCreate(t, recorder)
		if settle := waitSettle(t, recorder); settle.Reason != "expired" {
			t.Fatalf("settle reason = %q", settle.Reason)
		}
	})
}

func TestRequestPermissionDelayedCreateObeysDeadlineAndLifecycle(t *testing.T) {
	tests := []struct {
		name        string
		cancel      func(*SessionHost)
		wantReason  string
		wantReceipt string
		deadlineMs  int64
	}{
		{name: "deadline", wantReason: "expired", wantReceipt: "no_waiter", deadlineMs: 30},
		{
			name:       "Stop",
			cancel:     func(host *SessionHost) { host.Stop() },
			wantReason: "session_stopped", wantReceipt: "no_waiter",
		},
		{
			name:       "connection replacement",
			cancel:     func(host *SessionHost) { host.attachAcpInteractionGeneration() },
			wantReason: "connection_replaced", wantReceipt: "stale_generation",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			host, client, creates, settles, releaseCreate := newBlockedCreateInteractionHost(t)
			defer close(releaseCreate)
			defer host.Stop()
			if test.deadlineMs > 0 {
				config := testInteractionConfig()
				config.PermissionDeadlineMs = test.deadlineMs
				host.ConfigureAcpInteractions(config)
			}

			done := make(chan acpsdk.RequestPermissionResponse, 1)
			go func() {
				response, _ := client.RequestPermission(context.Background(), permissionRequest())
				done <- response
			}()
			var created acpInteractionCreateRequest
			select {
			case created = <-creates:
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for blocked durable create")
			}
			if test.cancel != nil {
				test.cancel(host)
			}
			select {
			case response := <-done:
				if response.Outcome.Cancelled == nil || response.Outcome.Selected != nil {
					t.Fatalf("outcome = %+v, want cancelled", response.Outcome)
				}
			case <-time.After(time.Second):
				t.Fatal("permission remained blocked behind delayed create")
			}
			select {
			case settle := <-settles:
				if settle.Reason != test.wantReason {
					t.Fatalf("settle reason = %q, want %q", settle.Reason, test.wantReason)
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for durable settle")
			}
			decision := AcpInteractionAnswerDecision{
				Kind: "selected_option", OptionID: "allow", AnswerHash: "late-answer",
			}
			if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != test.wantReceipt {
				t.Fatalf("late answer receipt = %q, want %q", status, test.wantReceipt)
			}
		})
	}
}

func TestRequestPermissionAnswerWinsBeforeLostCreateAcknowledgement(t *testing.T) {
	blockCreate := make(chan struct{})
	recorder := newInteractionRecorder(t, http.StatusCreated)
	recorder.createBlock = blockCreate
	host, client := newInteractionHost(recorder)
	defer host.Stop()

	type result struct {
		response acpsdk.RequestPermissionResponse
		err      error
	}
	done := make(chan result, 1)
	go func() {
		response, err := client.RequestPermission(context.Background(), permissionRequest())
		done <- result{response: response, err: err}
	}()
	created := waitCreate(t, recorder)
	decision := AcpInteractionAnswerDecision{
		Kind: "selected_option", OptionID: "allow", AnswerHash: "durable-answer",
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "consumed" {
		t.Fatalf("answer receipt = %q, want consumed", status)
	}

	permissionResult := <-done
	if permissionResult.err != nil || permissionResult.response.Outcome.Selected == nil ||
		permissionResult.response.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("permission result = %+v err=%v", permissionResult.response, permissionResult.err)
	}
	if settle := waitSettle(t, recorder); settle.Reason != "completed" {
		t.Fatalf("settle reason = %q, want completed", settle.Reason)
	}
	if status := host.ResolveAcpInteractionAnswer(created.InteractionID, created.Generation, decision); status != "duplicate" {
		t.Fatalf("duplicate receipt = %q, want duplicate", status)
	}
}

func TestRequestPermissionFeatureOffAndCreateFailureNeverSelect(t *testing.T) {
	recorder := newInteractionRecorder(t, http.StatusCreated)
	host, client := newInteractionHost(recorder)
	config := testInteractionConfig()
	config.Enabled = false
	host.ConfigureAcpInteractions(config)
	response, err := client.RequestPermission(context.Background(), permissionRequest())
	if err != nil || response.Outcome.Cancelled == nil {
		t.Fatalf("feature-off response = %+v err=%v", response, err)
	}
	select {
	case request := <-recorder.creates:
		t.Fatalf("feature-off path created interaction: %+v", request)
	default:
	}
	host.Stop()

	rejected := newInteractionRecorder(t, http.StatusConflict)
	host, client = newInteractionHost(rejected)
	defer host.Stop()
	response, err = client.RequestPermission(context.Background(), permissionRequest())
	if err != nil || response.Outcome.Cancelled == nil {
		t.Fatalf("create-failed response = %+v err=%v", response, err)
	}
	waitCreate(t, rejected)
}

func TestRequestPermissionInvalidContractsAndRequestsFailClosedBeforeCreate(t *testing.T) {
	tests := map[string]func(*AcpInteractionRuntimeConfig, *acpsdk.RequestPermissionRequest, *string){
		"missing contract": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			*config = AcpInteractionRuntimeConfig{}
		},
		"protocol version skew": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			config.ProtocolVersion++
		},
		"missing generation": func(_ *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, generation *string) {
			*generation = ""
		},
		"unsupported option kind": func(_ *AcpInteractionRuntimeConfig, request *acpsdk.RequestPermissionRequest, _ *string) {
			request.Options[0].Kind = acpsdk.PermissionOptionKind("unsupported")
		},
		"empty options": func(_ *AcpInteractionRuntimeConfig, request *acpsdk.RequestPermissionRequest, _ *string) {
			request.Options = nil
		},
		"too many options": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			config.OptionsMaxCount = 1
		},
		"oversized option id": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			config.OptionIDMaxChars = 3
		},
		"oversized option name": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			config.OptionNameMaxChars = 3
		},
		"duplicate option ids": func(_ *AcpInteractionRuntimeConfig, request *acpsdk.RequestPermissionRequest, _ *string) {
			request.Options[1].OptionId = request.Options[0].OptionId
		},
		"oversized encoded detail": func(config *AcpInteractionRuntimeConfig, _ *acpsdk.RequestPermissionRequest, _ *string) {
			config.RequestMaxBytes = 1
		},
	}

	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			recorder := newInteractionRecorder(t, http.StatusCreated)
			host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
				ControlPlaneURL: recorder.server.URL,
				ProjectID:       "project-1",
				WorkspaceID:     "workspace-1",
				SessionID:       "agent-session-1",
				RuntimeIdentity: "runtime-1",
				CallbackToken:   "callback-token",
				HTTPClient:      recorder.server.Client(),
			}})
			t.Cleanup(host.Stop)
			promptCtx, promptCancel := context.WithCancel(host.lifecycleContext())
			if _, ok := host.beginPromptForDelivery(promptCtx, promptCancel, "invalid-request-test", nil); !ok {
				t.Fatal("test prompt was not accepted")
			}
			config := testInteractionConfig()
			request := permissionRequest()
			generation := host.attachAcpInteractionGeneration()
			mutate(&config, &request, &generation)
			host.ConfigureAcpInteractions(config)

			response, err := (&sessionHostClient{host: host, interactionGeneration: generation}).RequestPermission(
				context.Background(), request,
			)
			if err != nil || response.Outcome.Cancelled == nil || response.Outcome.Selected != nil {
				t.Fatalf("response = %+v err=%v", response, err)
			}
			select {
			case created := <-recorder.creates:
				t.Fatalf("fail-closed path created durable interaction: %+v", created)
			default:
			}
		})
	}
}

func TestAcpInteractionRuntimeConfigRejectsNonPositiveRuntimeBounds(t *testing.T) {
	tests := map[string]func(*AcpInteractionRuntimeConfig){
		"response bytes": func(config *AcpInteractionRuntimeConfig) { config.ResponseMaxBytes = 0 },
		"retry delay": func(config *AcpInteractionRuntimeConfig) {
			config.SettleRetryDelaysMs = []int{0}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			config := testInteractionConfig()
			mutate(&config)
			if err := ValidateAcpInteractionRuntimeConfig(config); err == nil {
				t.Fatal("invalid runtime contract was accepted")
			}
		})
	}
}

func TestAcpConnectionGenerationsAreOpaqueAndUniqueAcrossHosts(t *testing.T) {
	first := NewSessionHost(SessionHostConfig{})
	second := NewSessionHost(SessionHostConfig{})
	defer first.Stop()
	defer second.Stop()
	firstGeneration := first.attachAcpInteractionGeneration()
	replacementGeneration := first.attachAcpInteractionGeneration()
	recreatedHostGeneration := second.attachAcpInteractionGeneration()
	if firstGeneration == replacementGeneration || firstGeneration == recreatedHostGeneration ||
		replacementGeneration == recreatedHostGeneration {
		t.Fatalf("connection generations were reused: %q %q %q", firstGeneration, replacementGeneration, recreatedHostGeneration)
	}
}

func TestInteractionAnswerRaceAndReceiptEvictionAreBounded(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{})
	config := testInteractionConfig()
	config.ReceiptLimit = 1
	host.ConfigureAcpInteractions(config)
	generation := host.attachAcpInteractionGeneration()
	options := map[string]struct{}{"allow": {}}
	first, err := host.registerInteractionWaiter("first", generation, 1, options, func() {})
	if err != nil {
		t.Fatal(err)
	}
	decision := AcpInteractionAnswerDecision{Kind: "selected_option", OptionID: "allow", AnswerHash: "a"}
	var wait sync.WaitGroup
	wait.Add(2)
	statuses := make(chan string, 2)
	go func() {
		defer wait.Done()
		statuses <- host.ResolveAcpInteractionAnswer("first", generation, decision)
	}()
	go func() {
		defer wait.Done()
		if host.cancelAcpInteractionWaiter("first", generation, "wrapper_cancelled") {
			statuses <- "cancelled"
		} else {
			statuses <- "lost_race"
		}
	}()
	wait.Wait()
	close(statuses)
	seen := make(map[string]int)
	for status := range statuses {
		seen[status]++
	}
	answerWon := seen["consumed"] == 1 && seen["lost_race"] == 1
	cancelWon := seen["cancelled"] == 1 && seen["no_waiter"] == 1
	if len(seen) != 2 || (!answerWon && !cancelWon) {
		t.Fatalf("race statuses = %+v", seen)
	}
	if len(first.result) != 1 {
		t.Fatalf("waiter resolved %d times", len(first.result))
	}

	second, err := host.registerInteractionWaiter("second", generation, 2, options, func() {})
	if err != nil {
		t.Fatal(err)
	}
	if status := host.ResolveAcpInteractionAnswer("second", generation, decision); status != "consumed" {
		t.Fatalf("second status = %q", status)
	}
	<-second.result
	if status := host.ResolveAcpInteractionAnswer("first", generation, decision); status != "no_waiter" {
		t.Fatalf("evicted receipt status = %q", status)
	}
}
