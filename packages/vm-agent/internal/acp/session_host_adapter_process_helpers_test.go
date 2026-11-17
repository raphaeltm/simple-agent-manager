package acp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// adapterCommand runs a .js adapter through node and anything else directly.
func adapterCommand(adapter string) (string, []string) {
	if filepath.Ext(adapter) == ".js" {
		return "node", []string{adapter}
	}
	return adapter, []string{}
}

// startACPAdapterProcess starts an ACP adapter in its own process group with piped stdio,
// as the opt-in real-adapter tests need. The returned stop kills the whole group (Codex
// spawns children) and reaps it; callers defer it.
func startACPAdapterProcess(ctx context.Context, t *testing.T, dir string, env []string, command string, args ...string) (io.WriteCloser, io.ReadCloser, func()) {
	t.Helper()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), env...)
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
	return stdin, stdout, func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}
}

// writeResponsesTurn streams one synthetic Responses API turn whose only output is item.
func writeResponsesTurn(w http.ResponseWriter, call int, item map[string]any) {
	id := fmt.Sprintf("response-%d", call)
	sseEvents(w,
		map[string]any{"type": "response.created", "response": map[string]any{"id": id}},
		map[string]any{"type": "response.output_item.done", "item": item},
		map[string]any{"type": "response.completed", "response": map[string]any{"id": id,
			"usage": map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
	)
}
