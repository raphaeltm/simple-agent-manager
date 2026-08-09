package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
)

func TestLegacyPromptRequestRemainsCompatibleWithoutDeliveryFields(t *testing.T) {
	var request sendPromptRequest
	if err := json.Unmarshal([]byte(`{"prompt":"hello","messageId":"message-1"}`), &request); err != nil {
		t.Fatal(err)
	}
	if request.Prompt != "hello" || request.MessageID != "message-1" {
		t.Fatalf("legacy request changed: %+v", request)
	}
	if request.ProtocolVersion != 0 || request.DeliveryID != "" {
		t.Fatalf("legacy request unexpectedly enabled versioned delivery: %+v", request)
	}
}

func TestExecutionProtocolRoutesRequireNodeManagementBearerToken(t *testing.T) {
	s := newContractTestServer()
	tests := []struct {
		name    string
		method  string
		target  string
		handler http.HandlerFunc
	}{
		{name: "capabilities", method: http.MethodGet, target: "/workspaces/ws-existing/agent-capabilities", handler: s.handleAgentCapabilities},
		{name: "receipt", method: http.MethodGet, target: "/workspaces/ws-existing/agent-sessions/session/prompt-receipts/delivery", handler: s.handleGetPromptReceipt},
		{name: "rollover submit", method: http.MethodPost, target: "/workspaces/ws-existing/agent-sessions/session/checkpoint-rollovers", handler: s.handleCheckpointRollover},
		{name: "rollover lookup", method: http.MethodGet, target: "/workspaces/ws-existing/agent-sessions/session/checkpoint-rollovers/op", handler: s.handleGetCheckpointRollover},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.target, nil)
			req.SetPathValue("workspaceId", "ws-existing")
			req.SetPathValue("sessionId", "session")
			req.SetPathValue("deliveryId", "delivery")
			req.SetPathValue("operationId", "op")
			rec := httptest.NewRecorder()
			tc.handler(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
		})
	}
}

func TestPromptReceiptObserverDurablyCompletesOnce(t *testing.T) {
	store, err := persistence.Open(filepath.Join(t.TempDir(), "receipts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Server{store: store, executionRuntimeID: "runtime-1"}
	_, _, _, err = store.AcceptPromptDelivery("ws", "session", "delivery", 1, "hash")
	if err != nil {
		t.Fatal(err)
	}
	_, claimed, err := store.ClaimPromptDelivery("ws", "session", "delivery", s.executionRuntimeID)
	if err != nil || !claimed {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	observer := s.promptReceiptObserver("ws", "session", "delivery")
	observer("end_turn", nil)
	observer("fatal_error", errors.New("late duplicate"))
	receipt, err := store.GetPromptDelivery("ws", "session", "delivery", s.executionRuntimeID)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.State != persistence.PromptReceiptCompleted || receipt.CompletedAt == nil {
		t.Fatalf("receipt changed after late duplicate: %+v", receipt)
	}
}

func TestAgentCapabilitiesAdvertiseVersionedInertExecutionFeatures(t *testing.T) {
	s := &Server{executionRuntimeID: "runtime-vm-01", config: &config.Config{
		ACPCheckpointPreemptGrace:    30 * time.Second,
		ACPCheckpointPreemptMaxGrace: 2 * time.Minute,
		ACPCheckpointRolloverTimeout: 2 * time.Minute,
	}}
	capabilities := s.agentCapabilities()
	if capabilities["protocolVersion"] != vmExecutionProtocolVersion {
		t.Fatalf("protocolVersion = %v", capabilities["protocolVersion"])
	}
	receipts := capabilities["promptReceipts"].(map[string]interface{})
	if receipts["supported"] != true {
		t.Fatalf("prompt receipts = %#v", receipts)
	}
	rollover := capabilities["checkpointRollover"].(map[string]interface{})
	if rollover["supported"] != true || rollover["automatic"] != false {
		t.Fatalf("checkpoint rollover = %#v", rollover)
	}
	if rollover["defaultGraceMs"] != int64(30_000) || rollover["operationTimeoutMs"] != int64(120_000) {
		t.Fatalf("checkpoint defaults = %#v", rollover)
	}

	fixture := loadDurableExecutionProtocolFixture(t)
	assertJSONContractEqual(t, capabilities, fixture.Capabilities)
}

func TestVersionedPromptResponseMatchesSharedProtocolFixture(t *testing.T) {
	fixture := loadDurableExecutionProtocolFixture(t)
	acceptedAt := int64(1_786_312_800_123)
	response := versionedPromptResponse{
		Status:    "accepted",
		SessionID: "session-01",
		Receipt: persistence.PromptDeliveryReceipt{
			DeliveryID:      "delivery-01",
			State:           persistence.PromptReceiptInFlight,
			RuntimeIdentity: "runtime-vm-01",
			AcceptedAt:      &acceptedAt,
		},
	}
	assertJSONContractEqual(t, response, fixture.NewPrompt)
}

type durableExecutionProtocolFixture struct {
	Capabilities json.RawMessage `json:"capabilities"`
	NewPrompt    json.RawMessage `json:"newPrompt"`
}

func loadDurableExecutionProtocolFixture(t *testing.T) durableExecutionProtocolFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "durable-execution-protocol-v1.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared protocol fixture: %v", err)
	}
	var fixture durableExecutionProtocolFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode shared protocol fixture: %v", err)
	}
	return fixture
}

func assertJSONContractEqual(t *testing.T, actual interface{}, expected json.RawMessage) {
	t.Helper()
	actualJSON, err := json.Marshal(actual)
	if err != nil {
		t.Fatalf("encode actual contract: %v", err)
	}
	var actualValue interface{}
	var expectedValue interface{}
	if err := json.Unmarshal(actualJSON, &actualValue); err != nil {
		t.Fatalf("decode actual contract: %v", err)
	}
	if err := json.Unmarshal(expected, &expectedValue); err != nil {
		t.Fatalf("decode expected contract: %v", err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("contract mismatch\nactual:   %s\nexpected: %s", actualJSON, expected)
	}
}

func TestExecutionProtocolIDsAreURLSafeAndBounded(t *testing.T) {
	for _, valid := range []string{"01KZK586BN98BRDGKC44V12HT0", "delivery-1", "worker:attempt_2.v1"} {
		if !validExecutionProtocolID(valid, maxDeliveryIDLength) {
			t.Fatalf("valid ID rejected: %q", valid)
		}
	}
	for _, invalid := range []string{"", "contains/slash", "contains space", "line\nbreak"} {
		if validExecutionProtocolID(invalid, maxDeliveryIDLength) {
			t.Fatalf("invalid ID accepted: %q", invalid)
		}
	}
}
