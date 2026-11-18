package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

// A wake that fails inside a known restore step reports that step, its timings and the tail of
// its error through the real restore handler (rule 62): only the control-plane transport and the
// host bootstrap boundary are replaced.
func TestFailedWakeReportsTheFailedRestoreStepThroughTheRealHandler(t *testing.T) {
	fixture := newDeletionFixture(t)
	server := fixture.server
	server.sessionProfileOvr = make(map[string]profileOverrides)
	server.config.SessionSnapshotOperationTimeout = 5 * time.Second
	server.config.SessionSnapshotProgressReportTimeout = time.Second
	server.upsertWorkspaceRuntime("workspace-1", "", "main", "running", "fresh", workspaceRuntimeOpts{ProjectID: "project"})
	if _, _, err := server.agentSessions.CreateRouted("workspace-1", "session", "Original", "", "project", "chat"); err != nil {
		t.Fatal(err)
	}
	traces := make(chan map[string]interface{}, 2)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/lifecycle-timings"):
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			traces <- body
			_, _ = w.Write([]byte(`{"accepted":true}`))
		case strings.Contains(r.URL.Path, "session-snapshot/restore-result"):
			_, _ = w.Write([]byte(`{}`))
		case strings.Contains(r.URL.Path, "session-snapshot/restore"):
			_, _ = w.Write([]byte(`{"available":true}`))
		case strings.HasSuffix(r.URL.Path, "git-token"):
			_, _ = w.Write([]byte(`{"token":"test-token"}`))
		case strings.HasSuffix(r.URL.Path, "runtime-assets"):
			_, _ = w.Write([]byte(`{"envVars":[],"files":[]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer controlPlane.Close()
	server.config.ControlPlaneURL = controlPlane.URL
	originalPrepare := prepareWorkspaceForRuntime
	prepareWorkspaceForRuntime = func(context.Context, *config.Config, bootstrap.ProvisionState, *bootlog.Reporter) (bool, error) {
		return false, errors.New("devcontainer up: exit status 1: Error: no space left on device")
	}
	t.Cleanup(func() {
		server.cancelAndWaitSessionRestores()
		prepareWorkspaceForRuntime = originalPrepare
	})

	request := httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/agent-sessions/session/restore",
		strings.NewReader(`{"chatSessionId":"chat","runtime":"vm","agentType":"claude-code","workspaceCallbackToken":"fresh"}`))
	request.SetPathValue("workspaceId", "workspace-1")
	request.SetPathValue("sessionId", "session")
	request.Header.Set("Authorization", "Bearer "+fixture.token)
	request.Header.Set("X-SAM-Workspace-Id", "workspace-1")
	response := httptest.NewRecorder()
	server.handleRestoreAgentSession(response, request)

	select {
	case trace := <-traces:
		if trace["operation"] != "wake" || trace["outcome"] != "error" || trace["chatSessionId"] != "chat" {
			t.Fatalf("wrong trace identity: %+v", trace)
		}
		// Provisioning inside the restore advances the recorder to its own step, so the trace
		// names the precise failing step rather than the coarse `workspace` restore phase.
		if trace["failedPhase"] != "workspace_prepare" {
			t.Fatalf("failed phase = %v, want workspace_prepare", trace["failedPhase"])
		}
		if tail, _ := trace["errorTail"].(string); !strings.Contains(tail, "no space left on device") {
			t.Fatalf("error tail lost the failure reason: %q", tail)
		}
		phases, _ := trace["phases"].([]interface{})
		names := make([]string, 0, len(phases))
		for _, phase := range phases {
			if entry, ok := phase.(map[string]interface{}); ok {
				names = append(names, entry["phase"].(string))
			}
		}
		joined := "," + strings.Join(names, ",") + ","
		if !strings.Contains(joined, ",metadata,") || !strings.Contains(joined, ",workspace_prepare,") {
			t.Fatalf("phase timings = %v, want metadata and workspace_prepare", names)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("no wake trace delivered (restore response %d %s)", response.Code, response.Body.String())
	}
}
