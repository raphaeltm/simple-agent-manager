package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// fakeVibeModes models Vibe 2.25.8's set_session_mode contract: an unknown
// mode succeeds without changing state. In particular, a restored session can
// retain auto-approve when SAM omits or sends an invalid reset.
type fakeVibeModes struct {
	mu           sync.Mutex
	currentMode  string
	rejectMode   bool
	sessionCalls []string
	modeRequests []acpsdk.SetSessionModeRequest
}

func (f *fakeVibeModes) serve(reader io.Reader, writer io.Writer) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			return
		}
		if len(req.ID) == 0 {
			continue
		}
		result := f.handle(req.Method, req.Params)
		response := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}
		if f.rejectMode && req.Method == acpsdk.AgentMethodSessionSetMode {
			delete(response, "result")
			response["error"] = map[string]any{"code": -32602, "message": "mode rejected"}
		}
		if json.NewEncoder(writer).Encode(response) != nil {
			return
		}
	}
}

func (f *fakeVibeModes) handle(method string, params json.RawMessage) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch method {
	case acpsdk.AgentMethodInitialize:
		return map[string]any{
			"protocolVersion":   acpsdk.ProtocolVersionNumber,
			"agentCapabilities": map[string]any{"loadSession": true},
			"authMethods":       []any{},
		}
	case acpsdk.AgentMethodSessionNew, acpsdk.AgentMethodSessionLoad:
		f.sessionCalls = append(f.sessionCalls, method)
		modes := []any{}
		for _, mode := range []string{"ask", "plan", "accept-edits", "auto-approve"} {
			modes = append(modes, map[string]string{"id": mode, "name": mode})
		}
		result := map[string]any{
			"modes": map[string]any{"currentModeId": f.currentMode, "availableModes": modes},
		}
		if method == acpsdk.AgentMethodSessionNew {
			result["sessionId"] = "vibe-new"
		}
		return result
	case acpsdk.AgentMethodSessionSetMode:
		var request acpsdk.SetSessionModeRequest
		if json.Unmarshal(params, &request) != nil {
			return nil
		}
		f.modeRequests = append(f.modeRequests, request)
		if f.rejectMode {
			return nil
		}
		switch string(request.ModeId) {
		case "ask", "plan", "accept-edits", "auto-approve":
			f.currentMode = string(request.ModeId)
			return map[string]any{}
		}
		return nil // Vibe silently ignores an unsupported mode, returning null.
	}
	return map[string]any{}
}

func TestVibeStartupAppliesNativePermissionModes(t *testing.T) {
	for _, session := range []struct {
		name, previousID, initialMode, wantSessionID, wantMethod string
	}{
		{"new", "", "ask", "vibe-new", acpsdk.AgentMethodSessionNew},
		{"restored-permissive", "vibe-saved", "auto-approve", "vibe-saved", acpsdk.AgentMethodSessionLoad},
	} {
		for _, mode := range []struct{ sam, native string }{
			{"nil-settings", "ask"},
			{"", "ask"},
			{"default", "ask"},
			{"plan", "plan"},
			{"acceptEdits", "accept-edits"},
			// No native deny-unless-preapproved mode: conservatively ask,
			// retaining SAM's existing conditional permission routing.
			{"dontAsk", "ask"},
			{"bypassPermissions", "auto-approve"},
			{"unknown-mode", "ask"},
			{"auto-approve", "ask"}, // Native IDs cannot bypass SAM's enum.
		} {
			t.Run(session.name+"/"+mode.sam, func(t *testing.T) {
				settings := &agentSettingsPayload{PermissionMode: mode.sam}
				if mode.sam == "nil-settings" {
					settings = nil
				}
				fake := &fakeVibeModes{currentMode: session.initialMode}
				_, err := startVibeModeAgent(t, fake, settings, session.previousID)
				if err != nil {
					t.Fatalf("startup: %v", err)
				}
				fake.mu.Lock()
				defer fake.mu.Unlock()
				if !slices.Equal(fake.sessionCalls, []string{session.wantMethod}) {
					t.Fatalf("session calls = %v, want [%s]", fake.sessionCalls, session.wantMethod)
				}
				if len(fake.modeRequests) != 1 {
					t.Fatalf("mode RPCs = %v, want one explicit %s reset (current mode %s)", fake.modeRequests, mode.native, fake.currentMode)
				}
				request := fake.modeRequests[0]
				if string(request.SessionId) != session.wantSessionID || string(request.ModeId) != mode.native {
					t.Errorf("mode RPC = %+v, want session %s mode %s", request, session.wantSessionID, mode.native)
				}
				if fake.currentMode != mode.native {
					t.Errorf("effective Vibe mode = %s, want %s", fake.currentMode, mode.native)
				}
			})
		}
	}
}

// startVibeModeAgent drives production credential/config construction, process
// attachment, SDK initialize and new/load before session settings are sent.
func startVibeModeAgent(t *testing.T, fake *fakeVibeModes, settings *agentSettingsPayload, previousID string) (*fakeAgentProcess, error) {
	t.Helper()
	return startModeTestAgent(t, "mistral-vibe", fake, settings, previousID)
}

func startModeTestAgent(t *testing.T, agentType string, fake *fakeVibeModes, settings *agentSettingsPayload, previousID string) (*fakeAgentProcess, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	process, stdin, stdout := newFakeAgentProcess(time.Now(), true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		fake.serve(stdin, stdout)
	}()
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{ContainerWorkDir: t.TempDir(), InitTimeoutMs: 2000},
		StartProcess:  func(*agentStartup) (agentProcess, error) { return process, nil },
	})
	t.Cleanup(func() {
		host.Stop()
		_ = stdin.Close()
		_ = stdout.Close()
		<-done
	})
	host.agentType = agentType
	err := host.startSelectedAgent(context.Background(), agentType,
		&agentCredential{credential: "test-vibe-key", credentialKind: "api-key"},
		settings, previousID, false)
	return process, err
}

func TestVibeStartupRejectsFailedPermissionReset(t *testing.T) {
	for _, previousID := range []string{"", "vibe-saved"} {
		t.Run(previousID, func(t *testing.T) {
			fake := &fakeVibeModes{currentMode: "auto-approve", rejectMode: true}
			process, err := startVibeModeAgent(t, fake, &agentSettingsPayload{PermissionMode: "default"}, previousID)
			if err == nil || !strings.Contains(err.Error(), "cannot apply Vibe session mode") {
				t.Errorf("startup = %v, want fatal mode error", err)
			}
			fake.mu.Lock()
			defer fake.mu.Unlock()
			if len(fake.modeRequests) != 1 || fake.modeRequests[0].ModeId != "ask" || fake.currentMode != "auto-approve" {
				t.Errorf("fake must reject ask and retain prior mode; requests=%v, mode=%s", fake.modeRequests, fake.currentMode)
			}
			if process.stopCount.Load() == 0 {
				t.Error("unsafe process still running after failed permission reset")
			}
		})
	}
}

func TestVibeMappingLeavesOtherAgentsUnchanged(t *testing.T) {
	for _, agent := range []string{"claude-code", "openai-codex", "gemini", "amp", "opencode", "unknown-agent"} {
		for _, mode := range []string{"", "default", "plan", "acceptEdits", "dontAsk", "bypassPermissions", "unknown-mode"} {
			t.Run(agent+"/"+mode, func(t *testing.T) {
				want, wantOK := mode, true
				if mode == "" || mode == "default" {
					want, wantOK = "", false
				}
				if got, ok := acpSessionModeID(agent, mode); got != want || ok != wantOK {
					t.Errorf("mapping = %q, %v; want %q, %v", got, ok, want, wantOK)
				}
			})
		}
	}
	for _, tc := range []struct{ sam, native string }{
		{"", "default"}, {"default", "default"}, {"plan", "default"},
		{"acceptEdits", "auto_edit"}, {"bypassPermissions", "yolo"},
		{"dontAsk", ""}, {"unknown-mode", ""},
	} {
		if got, ok := acpSessionModeID("google-antigravity", tc.sam); got != tc.native || ok != (tc.native != "") {
			t.Errorf("Antigravity %q = %q, %v; want %q", tc.sam, got, ok, tc.native)
		}
	}
}

// The new Vibe nil/error handling must not make other adapters send default
// modes or turn their historically best-effort settings into startup failures.
func TestVibeSettingsLeaveOtherAgentBehaviorUnchanged(t *testing.T) {
	for _, agent := range []string{"claude-code", "gemini"} {
		for _, tc := range []struct {
			name     string
			settings *agentSettingsPayload
			wantRPCs int
		}{
			{"nil-settings", nil, 0},
			{"rejected-mode", &agentSettingsPayload{PermissionMode: "bypassPermissions"}, 1},
		} {
			t.Run(agent+"/"+tc.name, func(t *testing.T) {
				fake := &fakeVibeModes{currentMode: "ask", rejectMode: true}
				process, err := startModeTestAgent(t, agent, fake, tc.settings, "")
				if err != nil {
					t.Fatalf("other-agent startup: %v", err)
				}
				fake.mu.Lock()
				defer fake.mu.Unlock()
				if len(fake.sessionCalls) != 1 || len(fake.modeRequests) != tc.wantRPCs {
					t.Errorf("startup not exercised or mode handling changed: session calls=%v, mode RPCs=%v", fake.sessionCalls, fake.modeRequests)
				}
				if process.stopCount.Load() != 0 {
					t.Error("other-agent mode error stopped process")
				}
			})
		}
	}
}
