package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Opt-in process test: the real codex-acp adapter and Codex CLI, started the way SAM starts
// them, with the CODEX_CONFIG that buildCodexACPManagedConfigEnv produces. The repository in
// the session's working directory carries SAM's own Codex hooks (rule delivery and the Stop
// gate) and a canary rule. A synthetic Responses API stands in for the model, so nothing
// leaves the machine. Set SAM_CODEX_ACP_ADAPTER and SAM_CODEX_CLI to run it, e.g. after
// `npm install @openai/codex@0.160.0 @agentclientprotocol/codex-acp@2.1.1`.
//
// The control runs the same session with the CODEX_CONFIG SAM sent before the trust change.
// codex-acp trusts the session's roots as projects either way; without bypass_hook_trust Codex
// skips every unreviewed hook, which is what made repository hooks inert in SAM.
func TestCodexRunsRepositoryHooksWithSAMConfig(t *testing.T) {
	adapter := os.Getenv("SAM_CODEX_ACP_ADAPTER")
	codex := os.Getenv("SAM_CODEX_CLI")
	if adapter == "" || codex == "" {
		t.Skip("set SAM_CODEX_ACP_ADAPTER and SAM_CODEX_CLI for the local Codex repository-hook probe")
	}
	t.Run("SAM config runs the repository hooks", func(t *testing.T) {
		repo := codexHookProbeRepo(t)
		env, err := buildCodexACPManagedConfigEnv(&agentSettingsPayload{Model: "gpt-6.1-sol"})
		if err != nil {
			t.Fatal(err)
		}
		requests := runCodexHookProbe(t, adapter, codex, repo, env, readCommand)
		all := strings.Join(requests, "\n")
		for _, want := range []string{
			"SAM rule delivery is active", // SessionStart
			"PROBE-RULE-CANARY-7731",      // PreToolUse delivered the rule body to the model
			"Test-quality gate",           // Stop continued the turn with its finding
		} {
			if !strings.Contains(all, want) {
				t.Errorf("no model request contained %q (%d requests)", want, len(requests))
			}
		}
		if requests[0] != "" && strings.Contains(requests[0], "PROBE-RULE-CANARY-7731") {
			t.Error("rule text reached the model before any tool call touched src/")
		}
		logs, _ := filepath.Glob(filepath.Join(repo, ".tmp/instruction-loads/codex-*.jsonl"))
		if len(logs) == 0 {
			t.Error("rule-context hook wrote no delivery log")
		}
	})
	t.Run("a write under governed paths is refused once with the rules attached", func(t *testing.T) {
		repo := codexHookProbeRepo(t)
		env, err := buildCodexACPManagedConfigEnv(&agentSettingsPayload{Model: "gpt-6.1-sol"})
		if err != nil {
			t.Fatal(err)
		}
		requests := runCodexHookProbe(t, adapter, codex, repo, env, writeCommand)
		if len(requests) < 2 {
			t.Fatalf("made %d model requests, want the refused call's follow-up", len(requests))
		}
		if !strings.Contains(requests[1], "Not run yet") || !strings.Contains(requests[1], "PROBE-RULE-CANARY-7731") {
			t.Error("the follow-up request did not carry the refusal and the rule text")
		}
		if _, err := os.Stat(filepath.Join(repo, "src/new.txt")); err == nil {
			t.Error("the write ran before the rules were delivered")
		}
	})
	t.Run("control: the pre-change config leaves the hooks inert", func(t *testing.T) {
		repo := codexHookProbeRepo(t)
		env := `CODEX_CONFIG={"sandbox_mode":"danger-full-access","approval_policy":"never","model":"gpt-6.1-sol"}`
		requests := runCodexHookProbe(t, adapter, codex, repo, env, readCommand)
		all := strings.Join(requests, "\n")
		for _, absent := range []string{"SAM rule delivery is active", "PROBE-RULE-CANARY-7731", "Test-quality gate"} {
			if strings.Contains(all, absent) {
				t.Errorf("untrusted session still delivered %q", absent)
			}
		}
		// Liveness: the session ran a tool call, so the hooks had a chance to fire.
		if len(requests) < 2 {
			t.Fatalf("control session made %d model requests, want a tool round trip", len(requests))
		}
	})
}

// codexHookProbeRepo builds a git repository with SAM's Codex hook entries (taken from this
// repository's .codex/config.toml), the real hook scripts, a canary rule scoped to src/, and
// an untracked boundary file for the Stop gate to report.
func codexHookProbeRepo(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	write := func(rel, content string) {
		path := filepath.Join(repo, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(rel string) string {
		data, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		return string(data)
	}
	config := read(".codex/config.toml")
	start := strings.Index(config, "[[hooks.SessionStart]]")
	end := strings.Index(config, "[projects.")
	if start < 0 || end < start {
		t.Fatal(".codex/config.toml has no hook entries to copy")
	}
	write(".codex/config.toml", config[start:end])
	write(".codex/hooks/rule-context.mjs", read(".codex/hooks/rule-context.mjs"))
	write(".claude/hooks/verify-test-quality.mjs", read(".claude/hooks/verify-test-quality.mjs"))
	write(".claude/rules/10-probe.md", "---\npaths:\n  - 'src/**'\n---\n\n# Probe Rule\n\nPROBE-RULE-CANARY-7731: files under src/ follow this probe rule.\n")
	write(".codex/hooks/rule-scopes.json", `{"rules":[{"path":".claude/rules/10-probe.md","title":"Probe Rule","patterns":[{"pattern":"src/**","regex":"^src\\/.*$","literal":4}]}]}`)
	write("src/existing.txt", "hello\n")
	write(".gitignore", ".tmp/\n")
	gitEnv := append(os.Environ(), "GIT_AUTHOR_NAME=probe", "GIT_AUTHOR_EMAIL=probe@example.com",
		"GIT_COMMITTER_NAME=probe", "GIT_COMMITTER_EMAIL=probe@example.com", "GIT_CONFIG_GLOBAL=/dev/null")
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"add", "-A"}, {"commit", "-qm", "probe"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = gitEnv
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write("apps/api/src/services/probe.ts", "export const probe = 1;\n")
	return repo
}

// runCodexHookProbe runs one prompt through the real adapter and returns every model request
// body. The first model turn asks to read src/existing.txt through whichever shell tool the
// request offers; every later turn answers "Done".
const (
	readCommand  = "sed -n 1,2p src/existing.txt"
	writeCommand = "printf 'x\\n' > src/new.txt"
)

func runCodexHookProbe(t *testing.T, adapter, codex, repo, codexConfigEnv, command string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var mu sync.Mutex
	var requests []string
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		mu.Lock()
		requests = append(requests, string(body))
		call := len(requests)
		mu.Unlock()
		if dir := os.Getenv("SAM_CODEX_PROBE_DUMP"); dir != "" {
			_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("request-%d.json", call)), body, 0o600)
		}
		item := map[string]any{"type": "message", "role": "assistant", "id": fmt.Sprintf("msg-%d", call),
			"content": []any{map[string]any{"type": "output_text", "text": "Done"}}}
		if call == 1 {
			// The synthetic model id has no catalog entry, so the request lists no tools;
			// Codex still routes a call to its unified exec tool by name.
			tool := os.Getenv("SAM_CODEX_PROBE_SHELL_TOOL")
			if tool == "" {
				tool = "exec_command"
			}
			encoded, _ := json.Marshal(command)
			arguments := `{"cmd":` + string(encoded) + `}`
			if tool == "shell" {
				arguments = `{"command":["bash","-lc",` + string(encoded) + `]}`
			}
			item = map[string]any{"type": "function_call", "call_id": "read-call", "name": tool, "arguments": arguments}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range []map[string]any{
			{"type": "response.created", "response": map[string]any{"id": fmt.Sprintf("response-%d", call)}},
			{"type": "response.output_item.done", "item": item},
			{"type": "response.completed", "response": map[string]any{"id": fmt.Sprintf("response-%d", call),
				"usage": map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
		} {
			data, _ := json.Marshal(event)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], data)
		}
	}))
	defer model.Close()

	home := t.TempDir()
	userConfig := fmt.Sprintf("model = \"gpt-6.1-sol\"\nmodel_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Mock\"\nbase_url = \"%s/v1\"\nwire_api = \"responses\"\nenv_key = \"PROBE_API_KEY\"\nrequest_max_retries = 0\nstream_max_retries = 0\n", model.URL)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(userConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	host, _ := newInteractionHost(newInteractionRecorder(t, http.StatusCreated))
	defer host.Stop()
	adapterCommand, adapterArgs := adapter, []string{}
	if filepath.Ext(adapter) == ".js" {
		adapterCommand, adapterArgs = "node", []string{adapter}
	}
	cmd := exec.CommandContext(ctx, adapterCommand, adapterArgs...)
	cmd.Dir = repo
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), "CODEX_PATH="+codex, "CODEX_HOME="+home, "PROBE_API_KEY=probe-only",
		"CODEX_API_KEY=probe-only", codexConfigEnv, codexACPManagedAgentModeEnv)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()
	client := acpsdk.NewClientSideConnection(&sessionHostClient{host: host, interactionGeneration: host.interactionGeneration}, stdin, stdout)
	host.acpConn = client
	if _, err := host.initializeACP(ctx, "openai-codex", 10*time.Second); err != nil {
		t.Fatalf("ACP initialize: %v", err)
	}
	session, err := client.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: repo, McpServers: []acpsdk.McpServer{}})
	if err != nil {
		t.Fatalf("ACP new session: %v", err)
	}
	if _, err := client.Prompt(ctx, acpsdk.PromptRequest{SessionId: session.SessionId,
		Prompt: []acpsdk.ContentBlock{acpsdk.TextBlock("Read src/existing.txt")}}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	return append([]string(nil), requests...)
}
