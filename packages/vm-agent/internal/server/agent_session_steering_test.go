package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
)

type steerTestServer struct {
	s     *Server
	token string
}

func newSteerTestServer(t *testing.T) *steerTestServer {
	t.Helper()
	s, _ := newRestoreRetryTestServer(t)
	validator, key := newWorkspaceCreateJWTValidator(t, "node-test")
	s.jwtValidator = validator
	s.executionRuntimeID = "runtime-1"
	host := acp.NewSessionHost(acp.SessionHostConfig{})
	t.Cleanup(host.Stop)
	s.sessionHosts["ws:session"] = host
	return &steerTestServer{s: s, token: signWorkspaceCreateNodeToken(t, key, "node-test", "ws")}
}

// fakeSteer swaps the SessionHost call for the test's script and counts calls.
func fakeSteer(t *testing.T, script func(claim func(int64) error) acp.SteerResult) *int {
	t.Helper()
	calls := 0
	previous := steerSessionHost
	steerSessionHost = func(_ *acp.SessionHost, _, _ string, claim func(int64) error) acp.SteerResult {
		calls++
		return script(claim)
	}
	t.Cleanup(func() { steerSessionHost = previous })
	return &calls
}

func (h *steerTestServer) steer(t *testing.T, deliveryID, prompt string) (int, steerPromptResponse) {
	t.Helper()
	body, _ := json.Marshal(steerPromptRequest{ProtocolVersion: 1, DeliveryID: deliveryID, MessageID: "message-1", Prompt: prompt})
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions/session/steer", strings.NewReader(string(body)))
	req.SetPathValue("workspaceId", "ws")
	req.SetPathValue("sessionId", "session")
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	h.s.handleSteerPrompt(rec, req)
	var resp steerPromptResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return rec.Code, resp
}

func (h *steerTestServer) lookup(t *testing.T, deliveryID string) (int, persistence.SteerDeliveryReceipt) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/workspaces/ws/agent-sessions/session/steer-receipts/"+deliveryID, nil)
	req.SetPathValue("workspaceId", "ws")
	req.SetPathValue("sessionId", "session")
	req.SetPathValue("deliveryId", deliveryID)
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	h.s.handleGetSteerReceipt(rec, req)
	var receipt persistence.SteerDeliveryReceipt
	_ = json.Unmarshal(rec.Body.Bytes(), &receipt)
	return rec.Code, receipt
}

func TestSteerInjectedIsClaimedBeforeInvocationAndNeverReplayed(t *testing.T) {
	h := newSteerTestServer(t)
	calls := fakeSteer(t, func(claim func(int64) error) acp.SteerResult {
		if err := claim(1700); err != nil {
			t.Fatalf("claim: %v", err)
		}
		// The possible-send boundary is durable before the adapter is contacted.
		receipt, err := h.s.store.GetSteerDelivery("ws", "session", "delivery-1", "runtime-1")
		if err != nil || receipt.State != persistence.SteerReceiptInFlight {
			t.Fatalf("receipt at invocation = %+v err=%v", receipt, err)
		}
		return acp.SteerResult{Outcome: acp.SteerInjected, PromptEpoch: 1700}
	})

	code, resp := h.steer(t, "delivery-1", "use tabs")
	if code != http.StatusOK || resp.Status != persistence.SteerReceiptInjected ||
		resp.Receipt.PromptEpoch == nil || *resp.Receipt.PromptEpoch != 1700 || resp.Receipt.CompletedAt == nil {
		t.Fatalf("response = %d %+v", code, resp)
	}
	// A lost response is recovered by repeating the request: same verdict, no second injection.
	code, resp = h.steer(t, "delivery-1", "use tabs")
	if code != http.StatusOK || resp.Status != persistence.SteerReceiptInjected || *calls != 1 {
		t.Fatalf("retry = %d %+v calls=%d", code, resp, *calls)
	}
	if code, receipt := h.lookup(t, "delivery-1"); code != http.StatusOK || receipt.State != persistence.SteerReceiptInjected {
		t.Fatalf("lookup = %d %+v", code, receipt)
	}
}

func TestSteerOutcomesMapToReceiptStates(t *testing.T) {
	cases := []struct {
		name   string
		claim  bool
		result acp.SteerResult
		state  string
		reason string
	}{
		{"idle", false, acp.SteerResult{Outcome: acp.SteerPromptRequired, Reason: "no_running_turn"},
			persistence.SteerReceiptNotConsumed, "no_running_turn"},
		{"adapter race", true, acp.SteerResult{Outcome: acp.SteerPromptRequired, Reason: "no_running_turn"},
			persistence.SteerReceiptNotConsumed, "no_running_turn"},
		{"rejected", true, acp.SteerResult{Outcome: acp.SteerRejected, Reason: "adapter_rejected_-32602"},
			persistence.SteerReceiptNotConsumed, "adapter_rejected_-32602"},
		{"unknown", true, acp.SteerResult{Outcome: acp.SteerUnknown, Reason: "steer_timeout"},
			persistence.SteerReceiptAmbiguous, "steer_timeout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newSteerTestServer(t)
			fakeSteer(t, func(claim func(int64) error) acp.SteerResult {
				if tc.claim {
					if err := claim(5); err != nil {
						t.Fatal(err)
					}
				}
				return tc.result
			})
			code, resp := h.steer(t, "delivery-1", "x")
			if code != http.StatusOK || resp.Status != tc.state || resp.Receipt.Reason != tc.reason {
				t.Fatalf("response = %d %+v", code, resp)
			}
		})
	}
}

func TestSteerRealHostWithoutSteeringAdapterIsNotConsumed(t *testing.T) {
	h := newSteerTestServer(t)
	code, resp := h.steer(t, "delivery-1", "x")
	if code != http.StatusOK || resp.Status != persistence.SteerReceiptNotConsumed ||
		resp.Receipt.Reason != "adapter_does_not_advertise_steering" {
		t.Fatalf("response = %d %+v", code, resp)
	}
}

func TestSteerReusedDeliveryIDWithOtherContentConflicts(t *testing.T) {
	h := newSteerTestServer(t)
	calls := fakeSteer(t, func(func(int64) error) acp.SteerResult {
		return acp.SteerResult{Outcome: acp.SteerPromptRequired, Reason: "no_running_turn"}
	})
	if code, _ := h.steer(t, "delivery-1", "first"); code != http.StatusOK {
		t.Fatalf("first status = %d", code)
	}
	if code, resp := h.steer(t, "delivery-1", "second"); code != http.StatusConflict || resp.Status != "conflict" {
		t.Fatalf("conflict = %d %+v", code, resp)
	}
	if *calls != 1 {
		t.Fatalf("calls = %d", *calls)
	}
}

func TestSteerReceiptFromEarlierRuntimeIsNeverReplayed(t *testing.T) {
	h := newSteerTestServer(t)
	calls := fakeSteer(t, func(func(int64) error) acp.SteerResult {
		t.Fatal("a receipt from an earlier runtime must not be invoked again")
		return acp.SteerResult{}
	})
	store := h.s.store
	hash := steerDeliveryFingerprint(1, "message-1", "x")
	// Crashed after claiming: the adapter may have taken it.
	if _, _, _, err := store.AcceptSteerDelivery("ws", "session", "claimed", 1, hash, "runtime-0"); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.ClaimSteerDelivery("ws", "session", "claimed", "runtime-0", 9); err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	// Crashed before claiming: never sent.
	if _, _, _, err := store.AcceptSteerDelivery("ws", "session", "unclaimed", 1, hash, "runtime-0"); err != nil {
		t.Fatal(err)
	}

	if code, resp := h.steer(t, "claimed", "x"); code != http.StatusOK || resp.Status != persistence.SteerReceiptAmbiguous ||
		resp.Receipt.Reason != "runtime_changed_after_invocation_claim" {
		t.Fatalf("claimed = %d %+v", code, resp)
	}
	if code, resp := h.steer(t, "unclaimed", "x"); code != http.StatusOK || resp.Status != persistence.SteerReceiptNotConsumed ||
		resp.Receipt.Reason != "runtime_changed_before_invocation" {
		t.Fatalf("unclaimed = %d %+v", code, resp)
	}
	if *calls != 0 {
		t.Fatalf("calls = %d", *calls)
	}
}

func TestSteerValidationAndLookupNotFound(t *testing.T) {
	h := newSteerTestServer(t)
	if code, receipt := h.lookup(t, "missing"); code != http.StatusNotFound || receipt.State != "not_found" {
		t.Fatalf("lookup = %d %+v", code, receipt)
	}
	delete(h.s.sessionHosts, "ws:session")
	if code, _ := h.steer(t, "delivery-1", "x"); code != http.StatusNotFound {
		t.Fatalf("missing host status = %d", code)
	}
	body := `{"protocolVersion":2,"deliveryId":"delivery-1","prompt":"x"}`
	req := httptest.NewRequest(http.MethodPost, "/workspaces/ws/agent-sessions/session/steer", strings.NewReader(body))
	req.SetPathValue("workspaceId", "ws")
	req.SetPathValue("sessionId", "session")
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("X-SAM-Workspace-Id", "ws")
	rec := httptest.NewRecorder()
	h.s.handleSteerPrompt(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "unsupported_protocol_version") {
		t.Fatalf("version = %d %s", rec.Code, rec.Body.String())
	}
}

func TestAgentCapabilitiesAdvertiseSteering(t *testing.T) {
	h := newSteerTestServer(t)
	steering, ok := h.s.agentCapabilities()["steering"].(map[string]interface{})
	if !ok || steering["supported"] != true || steering["version"] != steeringCapabilityVersion || steering["lookup"] != true {
		t.Fatalf("steering capability = %#v", h.s.agentCapabilities()["steering"])
	}
}

func TestSteerResponsesMatchSharedProtocolFixture(t *testing.T) {
	fixture := loadDurableExecutionProtocolFixture(t)
	epoch, acceptedAt, completedAt := int64(1_786_312_790_000), int64(1_786_312_800_123), int64(1_786_312_800_456)
	ambiguousAt := int64(1_786_312_801_123)
	receipt := func(state, reason string, promptEpoch *int64, done *int64) persistence.SteerDeliveryReceipt {
		return persistence.SteerDeliveryReceipt{DeliveryID: "delivery-01", State: state, Reason: reason,
			RuntimeIdentity: "runtime-vm-01", PromptEpoch: promptEpoch, AcceptedAt: &acceptedAt, CompletedAt: done}
	}
	assertJSONContractEqual(t, steerPromptResponse{Status: "injected", SessionID: "session-01",
		Receipt: receipt(persistence.SteerReceiptInjected, "", &epoch, &completedAt)}, fixture.InjectedSteer)
	assertJSONContractEqual(t, steerPromptResponse{Status: "not_consumed", SessionID: "session-01",
		Receipt: receipt(persistence.SteerReceiptNotConsumed, "no_running_turn", nil, &completedAt)}, fixture.NotConsumedSteer)
	assertJSONContractEqual(t, steerPromptResponse{Status: "ambiguous", SessionID: "session-01",
		Receipt: receipt(persistence.SteerReceiptAmbiguous, "runtime_changed_after_invocation_claim", &epoch, &ambiguousAt)},
		fixture.AmbiguousSteer)
}
