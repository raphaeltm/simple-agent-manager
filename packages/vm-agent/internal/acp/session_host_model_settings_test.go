package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestCodexAstraModelSelectionIsAppliedOrFailsClosed exercises the production
// ACP handshake over in-memory pipes. It is deliberately discriminating in both
// directions: removing the set_config_option call breaks the success assertion,
// while swallowing the adapter's rejection breaks the failure assertion.
func TestCodexAstraModelSelectionIsAppliedOrFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name               string
		reject             bool
		missingModelOption bool
		loadSession        bool
		wantErr            string
	}{
		{name: "supported Astra model is selected"},
		{name: "rejected Astra model stops startup", reject: true, wantErr: `cannot apply requested Codex model "gpt-6-astra"`},
		{name: "rejected Astra model stops restored session", reject: true, loadSession: true, wantErr: `cannot apply requested Codex model "gpt-6-astra"`},
		{name: "missing model option stops startup", missingModelOption: true, wantErr: `cannot apply requested Codex model "gpt-6-astra"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tmpDir := t.TempDir()
			t.Setenv("HOME", tmpDir)
			t.Setenv("CODEX_HOME", "")

			process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
			t.Cleanup(func() {
				_ = process.Stop()
				_ = agentStdin.Close()
				_ = agentStdout.Close()
			})

			setModelRequests := make(chan map[string]any, 1)
			serveCodexModelACP(agentStdin, agentStdout, tc.reject, tc.missingModelOption, setModelRequests)

			host := NewSessionHost(SessionHostConfig{
				GatewayConfig: GatewayConfig{
					ContainerWorkDir:    tmpDir,
					InitTimeoutMs:       2000,
					NewSessionTimeoutMs: 2000,
				},
				StartProcess: func(*agentStartup) (agentProcess, error) { return process, nil },
			})
			host.agentType = "openai-codex"

			previousSessionID := ""
			if tc.loadSession {
				previousSessionID = "codex-astra-session"
			}
			err := host.startSelectedAgent(
				context.Background(),
				"openai-codex",
				&agentCredential{credential: "test-key", credentialKind: "api-key"},
				&agentSettingsPayload{Model: "gpt-6-astra", Effort: "xhigh"},
				previousSessionID,
				false,
			)

			if tc.wantErr == "" && err != nil {
				t.Fatalf("Astra model selection failed: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("startup error=%v, want substring %q", err, tc.wantErr)
			}
			if tc.wantErr != "" {
				if got := process.stopCount.Load(); got == 0 {
					t.Fatal("rejected Codex model left the agent process running")
				}
				host.mu.RLock()
				runningProcess := host.process
				host.mu.RUnlock()
				if runningProcess != nil {
					t.Fatal("rejected Codex model remained attached to the session host")
				}
			}

			if tc.missingModelOption {
				select {
				case params := <-setModelRequests:
					t.Fatalf("model selection request sent without an advertised model option: %v", params)
				default:
				}
				return
			}

			select {
			case params := <-setModelRequests:
				if got := params["sessionId"]; got != "codex-astra-session" {
					t.Fatalf("sessionId=%v, want codex-astra-session", got)
				}
				if got := params["configId"]; got != "model" {
					t.Fatalf("configId=%v, want model", got)
				}
				if got := params["value"]; got != "gpt-6-astra" {
					t.Fatalf("value=%v, want gpt-6-astra", got)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("Codex model selection request was not sent")
			}
		})
	}
}

func TestCodexAstraModelRejectionStopsRestartReplacement(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	t.Setenv("CODEX_HOME", "")

	process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
	t.Cleanup(func() {
		_ = process.Stop()
		_ = agentStdin.Close()
		_ = agentStdout.Close()
	})

	setModelRequests := make(chan map[string]any, 1)
	serveCodexModelACP(agentStdin, agentStdout, true, false, setModelRequests)

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ContainerWorkDir:    tmpDir,
			InitTimeoutMs:       2000,
			NewSessionTimeoutMs: 2000,
		},
		StartProcess: func(*agentStartup) (agentProcess, error) { return process, nil },
	})
	host.agentType = "openai-codex"

	host.mu.Lock()
	restarted := host.restartAgentLocked(
		context.Background(),
		"openai-codex",
		&agentCredential{credential: "test-key", credentialKind: "api-key"},
		&agentSettingsPayload{Model: "gpt-6-astra", Effort: "xhigh"},
		"",
		crashRecoverySnapshot{},
		nil,
	)
	if restarted {
		t.Fatal("restart succeeded after Codex rejected the requested Astra model")
	}

	if got := process.stopCount.Load(); got == 0 {
		t.Fatal("rejected Codex model left the restart replacement process running")
	}
	host.mu.RLock()
	runningProcess := host.process
	status := host.status
	statusErr := host.statusErr
	host.mu.RUnlock()
	if runningProcess != nil {
		t.Fatal("rejected Codex model remained attached after restart failure")
	}
	if status != HostError {
		t.Fatalf("status=%s, want %s", status, HostError)
	}
	if !strings.Contains(statusErr, `cannot apply requested Codex model "gpt-6-astra"`) {
		t.Fatalf("statusErr=%q, want rejected Astra model context", statusErr)
	}
}

func serveCodexModelACP(
	reader interface{ Read([]byte) (int, error) },
	writer interface{ Write([]byte) (int, error) },
	rejectModel bool,
	missingModelOption bool,
	setModelRequests chan<- map[string]any,
) {
	go func() {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var request struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &request); err != nil || len(request.ID) == 0 {
				continue
			}

			switch request.Method {
			case "initialize":
				writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+
					`,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`)
			case "session/new":
				if missingModelOption {
					writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+`,"result":{"sessionId":"codex-astra-session","configOptions":[]}}`)
					continue
				}
				writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+
					`,"result":{"sessionId":"codex-astra-session","configOptions":[`+codexModelConfigOption("gpt-5.6-sol")+`]}}`)
			case "session/load":
				if missingModelOption {
					writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+`,"result":{"configOptions":[]}}`)
					continue
				}
				writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+
					`,"result":{"configOptions":[`+codexModelConfigOption("gpt-5.6-sol")+`]}}`)
			case "session/set_config_option":
				var params map[string]any
				if err := json.Unmarshal(request.Params, &params); err == nil {
					setModelRequests <- params
				}
				if rejectModel {
					writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+
						`,"error":{"code":-32602,"message":"unsupported model"}}`)
					continue
				}
				writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+
					`,"result":{"configOptions":[`+codexModelConfigOption("gpt-6-astra")+`]}}`)
			default:
				writeAgentLine(writer, `{"jsonrpc":"2.0","id":`+string(request.ID)+`,"result":{}}`)
			}
		}
	}()
}

func codexModelConfigOption(currentValue string) string {
	return `{"id":"model","name":"Model","category":"model","type":"select","currentValue":"` + currentValue +
		`","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6 Sol"},{"value":"gpt-6-astra","name":"GPT-6 Astra"}]}`
}
