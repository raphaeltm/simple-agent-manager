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
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The API integration test drives the shipped adapter/CLI with a local model.
// Only the model's tool request is a fixture; command execution and every
// lifecycle notification and activity callback come from the real runtime.
func TestPinnedQuietCommandSleepProbe(t *testing.T) {
	callback := os.Getenv("SAM_SLEEP_PROBE_CALLBACK_URL")
	if callback == "" {
		t.Skip("run through the API pinned-command integration test")
	}
	adapter, cli := os.Getenv("SAM_PINNED_CODEX_ADAPTER"), os.Getenv("SAM_PINNED_CODEX_CLI")
	if adapter == "" || cli == "" {
		t.Fatal("pinned adapter and CLI paths required")
	}
	start, err := strconv.ParseInt(os.Getenv("SAM_SLEEP_PROBE_START_MS"), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	release := os.Getenv("SAM_SLEEP_PROBE_RELEASE_FILE")
	if callback == "self" {
		release = filepath.Join(t.TempDir(), "release")
		local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var message struct {
				ProbePhase string `json:"probePhase"`
			}
			_ = json.NewDecoder(r.Body).Decode(&message)
			if message.ProbePhase == "cleanup_complete" {
				_ = os.WriteFile(release, nil, 0600)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
		defer local.Close()
		callback = local.URL
	}
	started := release + ".started"
	quotedStart, _ := json.Marshal(started)
	quoted, _ := json.Marshal(release)
	command := "touch " + string(quotedStart) + "; while [ ! -f " + string(quoted) + " ]; do sleep 0.05; done"
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		call := calls.Add(1)
		item := map[string]any{"type": "message", "role": "assistant", "id": fmt.Sprintf("msg-%d", call), "content": []any{map[string]any{"type": "output_text", "text": "Done"}}}
		if call == 1 {
			item = map[string]any{"type": "function_call", "call_id": "quiet-command", "name": "exec_command", "arguments": mustJSON(t, map[string]any{"cmd": command, "yield_time_ms": 30000})}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range []map[string]any{
			{"type": "response.created", "response": map[string]any{"id": fmt.Sprintf("response-%d", call)}},
			{"type": "response.output_item.done", "item": item},
			{"type": "response.completed", "response": map[string]any{"id": fmt.Sprintf("response-%d", call), "usage": map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
		} {
			b, _ := json.Marshal(event)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], b)
		}
	}))
	defer model.Close()
	home := t.TempDir()
	cfg := fmt.Sprintf("model = \"gpt-6.1-sol\"\napproval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\nmodel_provider = \"mock_provider\"\n[model_providers.mock_provider]\nname = \"Mock\"\nbase_url = \"%s/v1\"\nwire_api = \"responses\"\nenv_key = \"PROBE_API_KEY\"\nrequest_max_retries = 0\nstream_max_retries = 0\n", model.URL)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0600); err != nil {
		t.Fatal(err)
	}
	proc, err := (LocalLauncher{}).Start(ProcessConfig{AcpCommand: adapter, WorkDir: home, EnvVars: []string{"CODEX_PATH=" + cli, "CODEX_HOME=" + home, "PROBE_API_KEY=probe-only", "CODEX_API_KEY=probe-only"}})
	if err != nil {
		t.Fatal(err)
	}
	defer stopSleepProbeProcess(t, proc)
	if path := os.Getenv("SAM_SLEEP_PROBE_PID_FILE"); path != "" {
		if err := os.WriteFile(path, []byte(strconv.Itoa(proc.cmd.Process.Pid)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	go func() { _, _ = io.Copy(io.Discard, proc.Stderr()) }()
	host := NewSessionHost(SessionHostConfig{GatewayConfig: GatewayConfig{
		ProjectID: "project-1", WorkspaceID: "workspace-1", SessionID: "agent-1", NodeID: "node-1",
		ControlPlaneURL: callback, CallbackToken: "probe-only", ActivityRereportInterval: 20 * time.Millisecond,
		Now: func() time.Time { return time.UnixMilli(start) },
	}})
	defer host.Stop()
	host.process = proc
	host.agentType = "openai-codex"
	host.attachACPConnection(proc, "openai-codex")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := host.initializeACP(ctx, "openai-codex", 3*time.Second); err != nil {
		t.Fatal(err)
	}
	session, err := host.acpConn.NewSession(ctx, acpsdk.NewSessionRequest{Cwd: home, McpServers: []acpsdk.McpServer{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.acpConn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{SessionId: session.SessionId, ModeId: "agent-full-access"}); err != nil {
		t.Fatal(err)
	}
	host.setSessionIDLocked(session.SessionId)
	host.setStatus(HostReady, "")
	params := mustJSON(t, map[string]any{"sessionId": string(session.SessionId), "prompt": []any{map[string]any{"type": "text", "text": "Run the quiet command"}}})
	cleanupDone := make(chan error, 1)
	go func() {
		for {
			if _, err := os.Stat(started); err == nil {
				break
			}
			select {
			case <-ctx.Done():
				cleanupDone <- ctx.Err()
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
		// Exercise the validation cleanup while the real command is held. Before
		// its parent-PID fence, this test killed the Codex running validation.
		cleanup := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCodexC2CandidateProcessCleanupSignalsActualArgv$", "-test.timeout=10s")
		if output, err := cleanup.CombinedOutput(); err != nil {
			cleanupDone <- fmt.Errorf("validation cleanup: %w: %s", err, output)
			return
		}
		response, err := http.Post(callback+"/probe", "application/json", strings.NewReader(`{"probePhase":"cleanup_complete"}`))
		if err == nil {
			_ = response.Body.Close()
		}
		cleanupDone <- err
	}()
	host.HandlePrompt(ctx, json.RawMessage(`"quiet-probe"`), json.RawMessage(params), "control-plane", true)
	if err := <-cleanupDone; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(release); err != nil {
		t.Fatal("command returned before API test released it")
	}
	if calls.Load() < 2 {
		t.Fatal("command result did not reach the model")
	}
}

// The adapter can exit before its CLI child finishes writing CODEX_HOME.
// Stop and reap the owned process group before testing removes that directory.
func stopSleepProbeProcess(t *testing.T, proc *AgentProcess) {
	t.Helper()
	_ = proc.Stop()
	pgid := proc.cmd.Process.Pid // LocalLauncher starts a dedicated process group.
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		t.Errorf("kill probe process group: %v", err)
	}
	_ = proc.Wait()
	deadline := time.Now().Add(3 * time.Second)
	for {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			t.Errorf("inspect probe cleanup: %v", err)
			return
		}
		live := false
		for _, entry := range entries {
			if _, err := strconv.Atoi(entry.Name()); err != nil {
				continue
			}
			stat, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
			if err != nil {
				continue
			} // Exited while reading.
			end := strings.LastIndexByte(string(stat), ')')
			if end < 0 {
				continue
			}
			fields := strings.Fields(string(stat)[end+1:])
			if len(fields) < 3 {
				continue
			}
			group, _ := strconv.Atoi(fields[2])
			// Zombies cannot write files and may await an unrelated init's reap.
			if group == pgid && fields[0] != "Z" && fields[0] != "X" {
				live = true
				break
			}
		}
		if !live {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("probe process group %d did not stop", pgid)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
