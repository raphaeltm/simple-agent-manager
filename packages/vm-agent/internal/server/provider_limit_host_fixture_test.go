package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/persistence"
)

// Compiled only into Go test binaries: no production flag enables this peer.
func TestProviderLimitACPFixtureProcess(t *testing.T) {
	encoded := os.Getenv("SAM_TEST_PROVIDER_LIMIT_ACP_WIRE")
	if encoded == "" {
		return
	}
	wire, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		os.Exit(2)
	}
	decoder, encoder := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := decoder.Decode(&request); err != nil {
			if err == io.EOF {
				os.Exit(0)
			}
			os.Exit(2)
		}
		if len(request.ID) == 0 {
			continue
		}
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		switch request.Method {
		case "initialize":
			response["result"] = map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}}
		case "session/new":
			response["result"] = map[string]any{"sessionId": "fixture-provider-session"}
		case "session/prompt":
			if string(wire) == "success" {
				response["result"] = map[string]any{"stopReason": "end_turn"}
			} else {
				response["error"] = json.RawMessage(wire)
			}
		default:
			response["result"] = map[string]any{}
		}
		if encoder.Encode(response) != nil {
			os.Exit(2)
		}
	}
}

type providerLimitFixtureLauncher struct{ wire json.RawMessage }

func (l providerLimitFixtureLauncher) Start(cfg acp.ProcessConfig) (*acp.AgentProcess, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cfg.AcpCommand = executable
	cfg.AcpArgs = []string{"-test.run=^TestProviderLimitACPFixtureProcess$"}
	cfg.EnvVars = append(cfg.EnvVars, "SAM_TEST_PROVIDER_LIMIT_ACP_WIRE="+base64.StdEncoding.EncodeToString(l.wire))
	return (acp.LocalLauncher{}).Start(cfg)
}

func runProviderWireThroughProductionHost(t *testing.T, name string, wire json.RawMessage, now time.Time, mode string) map[string]any {
	t.Helper()
	bin := t.TempDir()
	store, err := persistence.Open(filepath.Join(bin, "fixture.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	source, err := os.ReadFile(filepath.Join("..", "acp", "gateway.go"))
	if err != nil {
		t.Fatal(err)
	}
	constant := func(name string) string {
		found := regexp.MustCompile(`const ` + name + ` = "([^"]+)"`).FindSubmatch(source)
		if len(found) != 2 {
			t.Fatalf("missing pinned test setup constant %s", name)
		}
		value := string(found[1])
		if at := strings.LastIndex(value, "@"); at >= 0 {
			value = value[at+1:]
		}
		return value
	}
	for command, version := range map[string]string{"claude-agent-acp": constant("claudeACPInstallPackage"), "claude": constant("claudeCodeMinVersion") + " (Claude Code)", "codex-acp": "@agentclientprotocol/codex-acp " + constant("codexACPInstallPackage"), "codex": "codex-cli " + constant("codexCLIInstallPackage")} {
		if err := os.WriteFile(filepath.Join(bin, command), []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	// Fail closed if install checks drift; this test never downloads an adapter.
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nexit 97\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	received := make(chan map[string]any, 1)
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/agent-key"):
			provider := "anthropic"
			if strings.HasPrefix(name, "Codex") {
				provider = "openai"
			}
			json.NewEncoder(w).Encode(map[string]any{"apiKey": "test-only", "credentialKind": "api-key", "credentialSource": "user", "credentialReference": "cc_credentials:provider-1", "credentialGeneration": 1, "credentialProvider": provider, "providerMode": "direct"})
		case strings.HasSuffix(r.URL.Path, "/status/callback"):
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			received <- body
			io.WriteString(w, `{}`)
		default:
			io.WriteString(w, `{}`)
		}
	}))
	defer control.Close()
	const key = "workspace-1/agent-1"
	s := &Server{workspaceEvents: make(map[string][]EventRecord), store: store, config: &config.Config{ControlPlaneURL: control.URL, CallbackToken: "test-token"},
		acpConfig:    acp.GatewayConfig{ControlPlaneURL: control.URL, CallbackToken: "test-token", NodeID: "node-1", ProcessLauncher: providerLimitFixtureLauncher{wire}, ContainerWorkDir: bin, Now: func() time.Time { return now }, SettingsResolved: true, TerminalActivityReportAttempts: 1, ActivityReportTimeout: time.Second},
		sessionHosts: make(map[string]*acp.SessionHost), sessionTaskCtx: map[string]taskCallbackContext{key: {ProjectID: "project-1", TaskID: "task-1", WorkspaceID: "workspace-1", TaskMode: mode}}, sessionMcpServers: make(map[string][]acp.McpServerEntry), sessionProfileOvr: make(map[string]profileOverrides), agentSessions: agentsessions.NewManager(), workspaces: make(map[string]*WorkspaceRuntime)}
	host := s.getOrCreateSessionHost(key, "workspace-1", "agent-1", agentsessions.Session{ID: "agent-1", WorkspaceID: "workspace-1"}, nil, "")
	defer host.Stop()
	agentType := "claude-code"
	if strings.HasPrefix(name, "Codex") {
		agentType = "openai-codex"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	host.SelectAgent(ctx, agentType)
	if host.Status() != acp.HostReady {
		t.Fatalf("fixture agent did not initialize: %s", host.Status())
	}
	params := json.RawMessage(`{"sessionId":"fixture-provider-session","prompt":[{"type":"text","text":"test-only limit path"}]}`)
	accepted, ok := host.AcceptPrompt(ctx, json.RawMessage(`1`), params, "fixture-viewer", true, "", nil)
	if !ok {
		t.Fatal("fixture prompt was not accepted")
	}
	go accepted.Run()
	select {
	case body := <-received:
		return body
	case <-ctx.Done():
		t.Fatal("production completion callback missing")
		return nil
	}
}

func TestProviderLimitProductionHostSuccessIdentity(t *testing.T) {
	now := time.Now()
	body := runProviderWireThroughProductionHost(t, "success", json.RawMessage(`success`), now, config.TaskModeConversation)
	if body["promptSucceeded"] != true || body["providerLimitAgentSessionId"] != "agent-1" || body["providerLimitCredentialGeneration"] != float64(1) || body["providerLimitPromptAttemptId"] != float64(1) || body["promptStartedAt"] != float64(now.UnixMilli()) {
		t.Fatalf("completion identity not propagated: %v", body)
	}
}

func TestProviderLimitProductionHostNegativeControls(t *testing.T) {
	for _, test := range []struct{ name, wire, want string }{
		{"ordinary", `{"code":-32603,"message":"Internal error","data":{"message":"You've hit your usage limit sk-secret-canary"}}`, "agent_prompt_failed"},
		{"transient", `{"code":-32603,"message":"Internal error","data":{"errorKind":"rate_limit"}}`, "provider_overloaded"},
		{"auth", `{"code":-32603,"message":"Internal error","data":{"codexErrorInfo":"unauthorized","message":"You've hit your usage limit sk-secret-canary"}}`, "model_provider_credential_rejected"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := runProviderWireThroughProductionHost(t, test.name, json.RawMessage(test.wire), time.Now(), config.TaskModeTask)
			if body["toStatus"] != "failed" || body["errorMessage"] != test.want {
				t.Fatalf("control callback=%v", body)
			}
			encoded, _ := json.Marshal(body)
			if strings.Contains(string(encoded), "sk-secret-canary") || body["providerLimitResetsAt"] != nil {
				t.Fatalf("unsafe control callback=%v", body)
			}
		})
	}
}

func TestProviderLimitBlockedConversationFailureKeepsAcceptedSource(t *testing.T) {
	now := time.Now()
	body := runProviderWireThroughProductionHost(t, "blocked-conversation", json.RawMessage(`{"code":-32603,"message":"Internal error","data":{"message":"ordinary provider failure"}}`), now, config.TaskModeConversation)
	if body["executionStep"] != "awaiting_followup" || body["errorMessage"] != "agent_prompt_failed" || body["toStatus"] != nil {
		t.Fatal("conversation error behavior changed")
	}
	if body["providerLimitAgentSessionId"] != "agent-1" || body["providerLimitCredentialGeneration"] != float64(1) || body["providerLimitPromptAttemptId"] != float64(1) {
		t.Fatal("conversation callback omitted immutable accepted prompt source")
	}
}
