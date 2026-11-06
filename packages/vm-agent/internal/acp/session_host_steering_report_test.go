package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The browser hides Steer for a session whose adapter cannot steer. The VM agent learns
// that at ACP initialize and must carry it on activity reports, so drive the real
// initialize against a fake adapter and read the report the control plane receives.
func TestActivityReportCarriesSteeringSupportFromInitialize(t *testing.T) {
	steeringMeta := `"_meta":{"steering":{"supported":true}}`
	for _, tc := range []struct {
		name, agentInfo, meta string
		want                  bool
	}{
		{"stock codex 2.1.1", `{"name":"@agentclientprotocol/codex-acp","version":"2.1.1"}`, steeringMeta, false},
		{"sam codex c2.3", `{"name":"@agentclientprotocol/codex-acp","version":"2.1.1-sam-c2.3"}`, steeringMeta, true},
		{"claude pinned", `{"name":"@agentclientprotocol/claude-agent-acp","version":"0.81.2"}`, steeringMeta, true},
		{"adapter without steering", `{"name":"gemini","version":"0.61.0"}`, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payloads := make(chan activityPayload, 4)
			host := newSteeringReportHost(t, payloads)

			// Before initialize nothing is known, so the field is omitted (older-agent shape).
			host.reportActivity("idle")
			if got := receiveActivityPayload(t, payloads); got.SteeringSupported != nil {
				t.Fatalf("steeringSupported = %v before initialize, want omitted", *got.SteeringSupported)
			}

			initializeAgainstFakeAdapter(t, host, tc.agentInfo, tc.meta)

			host.reportActivity("idle")
			got := receiveActivityPayload(t, payloads)
			if got.SteeringSupported == nil || *got.SteeringSupported != tc.want {
				t.Fatalf("steeringSupported = %v, want %v", got.SteeringSupported, tc.want)
			}
		})
	}
}

// A coalesced re-report is skipped when it matches the last one sent, so a change in
// steering support alone must make the snapshots differ.
func TestActivityReportSnapshotDistinguishesSteeringSupport(t *testing.T) {
	supported, unsupported := true, false
	base := activityPayload{Activity: "idle", NodeID: "node-1"}
	withSupported, withUnsupported := base, base
	withSupported.SteeringSupported = &supported
	withUnsupported.SteeringSupported = &unsupported
	if activityReportSnapshotFromPayload(withSupported) == activityReportSnapshotFromPayload(withUnsupported) {
		t.Fatal("snapshots ignore steeringSupported")
	}
	if activityReportSnapshotFromPayload(base) == activityReportSnapshotFromPayload(withUnsupported) {
		t.Fatal("snapshots ignore whether steeringSupported was reported")
	}
}

func newSteeringReportHost(t *testing.T, payloads chan<- activityPayload) *SessionHost {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload activityPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID: "proj-1", NodeID: "node-1", SessionID: "acp-1",
		ControlPlaneURL: server.URL, CallbackToken: "token", HTTPClient: server.Client(),
	}})
	t.Cleanup(host.Stop)
	return host
}

func initializeAgainstFakeAdapter(t *testing.T, host *SessionHost, agentInfo, meta string) {
	t.Helper()
	clientToAgentR, clientToAgentW := io.Pipe()
	agentToClientR, agentToClientW := io.Pipe()
	t.Cleanup(func() {
		_ = clientToAgentW.Close()
		_ = agentToClientW.Close()
	})
	go func() {
		scanner := bufio.NewScanner(clientToAgentR)
		for scanner.Scan() {
			var request struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if json.Unmarshal(scanner.Bytes(), &request) != nil || request.Method != "initialize" {
				continue
			}
			result := `{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"agentInfo":` + agentInfo
			if meta != "" {
				result += "," + meta
			}
			writeAgentLine(agentToClientW, `{"jsonrpc":"2.0","id":`+string(request.ID)+`,"result":`+result+`}}`)
		}
	}()
	host.mu.Lock()
	host.acpConn = acpsdk.NewClientSideConnection(&sessionHostClient{host: host}, clientToAgentW, agentToClientR)
	_, err := host.initializeACP(context.Background(), "test-agent", 2*time.Second)
	host.mu.Unlock()
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
}

func receiveActivityPayload(t *testing.T, payloads <-chan activityPayload) activityPayload {
	t.Helper()
	select {
	case payload := <-payloads:
		return payload
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for activity report")
		return activityPayload{}
	}
}
