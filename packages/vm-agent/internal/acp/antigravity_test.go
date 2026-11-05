package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// fakeAntigravityACP mimics agy-acp-server 1.4.5 as observed against the real
// release (tasks/active/2026-11-05-google-antigravity-agent.md):
//   - session/new and session/load fail with -32000 until an auth method is selected;
//   - an accepted session writes skills/system/run-workflow/SKILL.md into its cwd
//     unless _meta.antigravity.disabledTools contains "run_workflow";
//   - the model is a "model" select config option.
type fakeAntigravityACP struct {
	authMethods []string

	mu            sync.Mutex
	authenticated []string
	fs            map[string]bool
	modelValues   []string
	sessionCalls  []string
	modes         []string
}

func (f *fakeAntigravityACP) serve(reader io.Reader, writer io.Writer) {
	go func() {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			var req struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
				return
			}
			if len(req.ID) == 0 {
				continue
			}
			result, errObj := f.handle(req.Method, req.Params)
			resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
			if errObj != nil {
				resp["error"] = errObj
			} else {
				resp["result"] = result
			}
			data, err := json.Marshal(resp)
			if err != nil {
				return
			}
			if _, err := writer.Write(append(data, '\n')); err != nil {
				return
			}
		}
	}()
}

func (f *fakeAntigravityACP) handle(method string, raw json.RawMessage) (any, map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch method {
	case acpsdk.AgentMethodInitialize:
		var params struct {
			ClientCapabilities struct {
				Fs map[string]bool `json:"fs"`
			} `json:"clientCapabilities"`
		}
		_ = json.Unmarshal(raw, &params)
		f.fs = params.ClientCapabilities.Fs
		methods := make([]map[string]string, 0, len(f.authMethods))
		for _, id := range f.authMethods {
			methods = append(methods, map[string]string{"id": id, "name": id})
		}
		return map[string]any{
			"protocolVersion":   acpsdk.ProtocolVersionNumber,
			"agentCapabilities": map[string]any{"loadSession": true},
			"authMethods":       methods,
		}, nil
	case acpsdk.AgentMethodAuthenticate:
		var params struct {
			MethodID string `json:"methodId"`
		}
		_ = json.Unmarshal(raw, &params)
		if !slices.Contains(f.authMethods, params.MethodID) {
			return nil, map[string]any{"code": -32602, "message": "unknown auth method"}
		}
		f.authenticated = append(f.authenticated, params.MethodID)
		return map[string]any{}, nil
	case acpsdk.AgentMethodSessionNew, acpsdk.AgentMethodSessionLoad:
		f.sessionCalls = append(f.sessionCalls, method)
		if len(f.authenticated) == 0 {
			return nil, map[string]any{"code": -32000, "message": "Authentication required"}
		}
		var params struct {
			Cwd       string `json:"cwd"`
			SessionID string `json:"sessionId"`
			Meta      struct {
				Antigravity struct {
					DisabledTools []string `json:"disabledTools"`
				} `json:"antigravity"`
			} `json:"_meta"`
		}
		_ = json.Unmarshal(raw, &params)
		if !slices.Contains(params.Meta.Antigravity.DisabledTools, "run_workflow") {
			skill := filepath.Join(params.Cwd, "skills", "system", "run-workflow", "SKILL.md")
			_ = os.MkdirAll(filepath.Dir(skill), 0o755)
			_ = os.WriteFile(skill, []byte("run workflow\n"), 0o644)
		}
		result := map[string]any{"configOptions": fakeAntigravityConfigOptions()}
		if method == acpsdk.AgentMethodSessionNew {
			result["sessionId"] = "agy-session"
		}
		return result, nil
	case acpsdk.AgentMethodSessionSetMode:
		var params struct {
			ModeID string `json:"modeId"`
		}
		_ = json.Unmarshal(raw, &params)
		if !slices.Contains([]string{"default", "auto_edit", "yolo"}, params.ModeID) {
			return nil, map[string]any{"code": -32602, "message": "unknown mode"}
		}
		f.modes = append(f.modes, params.ModeID)
		return map[string]any{}, nil
	case acpsdk.AgentMethodSessionSetConfigOption:
		var params struct {
			Value string `json:"value"`
		}
		_ = json.Unmarshal(raw, &params)
		f.modelValues = append(f.modelValues, params.Value)
		return map[string]any{"configOptions": fakeAntigravityConfigOptions()}, nil
	}
	return map[string]any{}, nil
}

func fakeAntigravityConfigOptions() []any {
	options := []any{}
	for _, value := range []string{"gemini-3.8-flash", "gemini-3.1-pro"} {
		options = append(options, map[string]string{"value": value, "name": value})
	}
	return []any{map[string]any{
		"id": "model", "name": "Model", "category": "model", "type": "select",
		"currentValue": "gemini-3.8-flash", "options": options,
	}}
}

type antigravityStartupResult struct {
	err     error
	workDir string
	fake    *fakeAntigravityACP
	startup *agentStartup
}

// startFakeAntigravity drives the production startup path (startSelectedAgent:
// command resolution, credential env, initialize, authenticate, new/load
// session, model selection) against the fake agent.
func startFakeAntigravity(t *testing.T, agentType string, authMethods []string, previousSessionID string) antigravityStartupResult {
	t.Helper()
	return startFakeAntigravityWithMode(t, agentType, authMethods, previousSessionID, "bypassPermissions")
}

func startFakeAntigravityWithMode(t *testing.T, agentType string, authMethods []string, previousSessionID, permissionMode string) antigravityStartupResult {
	t.Helper()
	workDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())

	process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
	t.Cleanup(func() {
		_ = process.Stop()
		_ = agentStdin.Close()
		_ = agentStdout.Close()
	})
	fake := &fakeAntigravityACP{authMethods: authMethods}
	fake.serve(agentStdin, agentStdout)

	var captured *agentStartup
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ContainerWorkDir:     workDir,
			InitTimeoutMs:        2000,
			NewSessionTimeoutMs:  2000,
			LoadSessionTimeoutMs: 2000,
		},
		StartProcess: func(startup *agentStartup) (agentProcess, error) {
			captured = startup
			return process, nil
		},
	})
	host.agentType = agentType

	err := host.startSelectedAgent(
		context.Background(),
		agentType,
		&agentCredential{credential: "test-gemini-key", credentialKind: "api-key"},
		&agentSettingsPayload{Model: "gemini-3.1-pro", PermissionMode: permissionMode},
		previousSessionID,
		false,
	)
	return antigravityStartupResult{err: err, workDir: workDir, fake: fake, startup: captured}
}

var antigravity145AuthMethods = []string{"oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"}

func TestAntigravityStartupAuthenticatesWithGeminiKeyAndKeepsRepositoryClean(t *testing.T) {
	for _, tc := range []struct {
		name              string
		previousSessionID string
		wantSessionCall   string
	}{
		{name: "new session", wantSessionCall: acpsdk.AgentMethodSessionNew},
		{name: "restored session", previousSessionID: "agy-previous", wantSessionCall: acpsdk.AgentMethodSessionLoad},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := startFakeAntigravity(t, "google-antigravity", antigravity145AuthMethods, tc.previousSessionID)
			if got.err != nil {
				t.Fatalf("Antigravity startup failed: %v", got.err)
			}

			got.fake.mu.Lock()
			defer got.fake.mu.Unlock()
			if !slices.Equal(got.fake.authenticated, []string{"gemini-api-key"}) {
				t.Fatalf("authenticate methods = %v, want [gemini-api-key]", got.fake.authenticated)
			}
			if !slices.Equal(got.fake.sessionCalls, []string{tc.wantSessionCall}) {
				t.Fatalf("session calls = %v, want [%s]", got.fake.sessionCalls, tc.wantSessionCall)
			}
			if !slices.Equal(got.fake.modelValues, []string{"gemini-3.1-pro"}) {
				t.Fatalf("model selections = %v, want [gemini-3.1-pro]", got.fake.modelValues)
			}
			if got.fake.fs["readTextFile"] || got.fake.fs["writeTextFile"] {
				t.Fatalf("client fs capabilities = %v, want reads and writes off", got.fake.fs)
			}
			skill := filepath.Join(got.workDir, "skills", "system", "run-workflow", "SKILL.md")
			if _, err := os.Stat(skill); !os.IsNotExist(err) {
				t.Fatalf("Antigravity wrote %s into the repository (stat err=%v)", skill, err)
			}

			if got.startup == nil {
				t.Fatal("agent process was not started")
			}
			if got.startup.info.command != "agy-acp" || !slices.Equal(got.startup.info.args, []string{"--uid="}) {
				t.Fatalf("launch = %q %v, want agy-acp [--uid=]", got.startup.info.command, got.startup.info.args)
			}
			if !slices.Contains(got.startup.envVars, "GEMINI_API_KEY=test-gemini-key") {
				t.Fatal("GEMINI_API_KEY was not injected into the agent environment")
			}
		})
	}
}

func TestAntigravityStartupMapsSAMPermissionModes(t *testing.T) {
	for _, tc := range []struct {
		permissionMode string
		want           []string
	}{
		{permissionMode: "bypassPermissions", want: []string{"yolo"}},
		{permissionMode: "acceptEdits", want: []string{"auto_edit"}},
		{permissionMode: "default", want: nil},
	} {
		t.Run(tc.permissionMode, func(t *testing.T) {
			got := startFakeAntigravityWithMode(t, "google-antigravity", antigravity145AuthMethods, "", tc.permissionMode)
			if got.err != nil {
				t.Fatalf("Antigravity startup failed: %v", got.err)
			}
			got.fake.mu.Lock()
			defer got.fake.mu.Unlock()
			if !slices.Equal(got.fake.modes, tc.want) {
				t.Fatalf("session modes = %v, want %v", got.fake.modes, tc.want)
			}
			if len(got.fake.modelValues) != 1 {
				t.Fatalf("model selections = %v, want one (startup reached settings)", got.fake.modelValues)
			}
		})
	}
}

func TestAntigravityStartupFailsWhenGeminiKeyAuthIsNotOffered(t *testing.T) {
	got := startFakeAntigravity(t, "google-antigravity", []string{"oauth-personal"}, "")
	if got.err == nil || !strings.Contains(got.err.Error(), `ACP auth method "gemini-api-key"`) {
		t.Fatalf("startup error = %v, want missing gemini-api-key auth method", got.err)
	}
	got.fake.mu.Lock()
	defer got.fake.mu.Unlock()
	if len(got.fake.authenticated) != 0 {
		t.Fatalf("authenticate was called with %v", got.fake.authenticated)
	}
}

// Other agents keep SAM's client file access and never receive authenticate.
func TestNonAntigravityStartupKeepsClientFsAndSkipsAuthenticate(t *testing.T) {
	got := startFakeAntigravity(t, "google-gemini", antigravity145AuthMethods, "")
	// The fake refuses unauthenticated sessions, so startup must fail here:
	// that proves SAM did not call authenticate for Gemini CLI.
	if got.err == nil {
		t.Fatal("google-gemini startup authenticated against the fake")
	}
	got.fake.mu.Lock()
	defer got.fake.mu.Unlock()
	if len(got.fake.authenticated) != 0 {
		t.Fatalf("authenticate was called with %v for google-gemini", got.fake.authenticated)
	}
	if !got.fake.fs["readTextFile"] || !got.fake.fs["writeTextFile"] {
		t.Fatalf("client fs capabilities = %v, want reads and writes on", got.fake.fs)
	}
}

func TestGetAgentCommandInfoGoogleAntigravity(t *testing.T) {
	t.Parallel()

	info := getAgentCommandInfo("google-antigravity", "api-key")
	if info.command != "agy-acp" || info.envVarName != "GEMINI_API_KEY" {
		t.Fatalf("command=%q envVarName=%q", info.command, info.envVarName)
	}
	if info.installCmd != antigravityInstallScript || info.isNpmBased {
		t.Fatal("Antigravity must install through the embedded release installer")
	}
	if !strings.Contains(info.installCmd, "version="+antigravityVersion+"\n") {
		t.Fatalf("installer does not pin version %s", antigravityVersion)
	}
}
