package server

import (
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
)

func samMcpEntry(token string) acp.McpServerEntry {
	return acp.McpServerEntry{URL: "https://api.example.com/mcp", Token: token, Name: acp.SamMcpServerName}
}

func (s *Server) sessionHostFor(key string) *acp.SessionHost {
	s.sessionHostMu.Lock()
	defer s.sessionHostMu.Unlock()
	return s.sessionHosts[key]
}

// A restart or rebuild that delivers a new callback generation's token retires
// every agent process started with the previous generation: the SessionHost is
// stopped and removed before the sam-mcp rotation, while the session's MCP list,
// profile override and task context survive (rotated) for the next agent start.
// A host created after that stop, while rotation is in flight, is not stopped and
// receives the rotated list through SetMcpServers. Another workspace is untouched.
func TestWorkspaceReprovisionWithDeliveredTokenStopsPreviousGenerationAgents(t *testing.T) {
	for _, tt := range []struct{ action, status string }{
		{"rebuild", "running"}, // reuses the running devcontainer and its hosts
		{"restart", "error"},   // can find hosts left by a failed rebuild
	} {
		t.Run(tt.action, func(t *testing.T) {
			current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
			delivered := generationTestToken(t, generationTestWorkspace, "workspace", "gen-b", time.Hour)
			s, nodeToken, finish, cp := newGenerationServer(t, tt.status, current)
			defer finish(errors.New("test complete"))

			hostKey := generationTestWorkspace + ":sess-a"
			otherKey := "ws-other:sess-x"
			s.registerSessionMcpServers(generationTestWorkspace, "sess-a", []acp.McpServerEntry{samMcpEntry("old-a")})
			s.registerSessionMcpServers("ws-other", "sess-x", []acp.McpServerEntry{samMcpEntry("old-other")})
			s.sessionHostMu.Lock()
			if s.sessionProfileOvr == nil {
				s.sessionProfileOvr = map[string]profileOverrides{}
			}
			if s.sessionTaskCtx == nil {
				s.sessionTaskCtx = map[string]taskCallbackContext{}
			}
			s.sessionProfileOvr[hostKey] = profileOverrides{Model: "model-a"}
			s.sessionTaskCtx[hostKey] = taskCallbackContext{ProjectID: "proj-1", TaskID: "task-1", WorkspaceID: generationTestWorkspace}
			s.sessionHostMu.Unlock()

			oldHost := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{
				CallbackToken: current, McpServers: []acp.McpServerEntry{samMcpEntry("old-a")},
			}})
			otherHost := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{
				McpServers: []acp.McpServerEntry{samMcpEntry("old-other")},
			}})
			t.Cleanup(oldHost.Stop)
			t.Cleanup(otherHost.Stop)
			s.sessionHosts[hostKey] = oldHost
			s.sessionHosts[otherKey] = otherHost

			stoppedAtRotation := false
			cp.respond = func(int, string) (int, string) {
				stoppedAtRotation = oldHost.Status() == acp.HostStopped && s.sessionHostFor(hostKey) != oldHost
				return http.StatusOK, `{"token":"new-a"}`
			}
			cp.hold = make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(cp.hold) }) }
			t.Cleanup(release) // a failed assertion must not leave rotation blocked
			prepared := make(chan struct{}, 1)
			stubPrepare(t, func() { prepared <- struct{}{} })

			rec := postWorkspaceReprovision(t, s, nodeToken, tt.action, restartBody(t, false, delivered))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("%s: %d %s", tt.action, rec.Code, rec.Body.String())
			}
			waitFor(t, func() bool {
				return oldHost.Status() == acp.HostStopped && s.sessionHostFor(hostKey) == nil
			}, "the previous generation's SessionHost was not stopped and removed")

			// A reconnect after the stop and before the rotation lands, through the
			// real host-creation path: it reads the not-yet-rotated list.
			concurrent := s.getOrCreateSessionHost(hostKey, generationTestWorkspace, "sess-a", agentsessions.Session{}, nil, "")
			if concurrent == nil || concurrent == oldHost {
				t.Fatal("no new SessionHost was created after the stop")
			}
			t.Cleanup(concurrent.Stop)
			if !concurrent.UsesCallbackToken(delivered) || !concurrent.UsesMcpServerToken(acp.SamMcpServerName, "old-a") {
				t.Fatal("setup: the concurrent host should start from the new callback token and the old MCP list")
			}

			release()
			finish(nil)
			select {
			case <-prepared:
			case <-time.After(5 * time.Second):
				t.Fatal("provisioning never reached the bootstrap boundary")
			}
			waitForRestartProvisionFailure(t, s)

			cp.mu.Lock()
			stoppedFirst := stoppedAtRotation
			cp.mu.Unlock()
			if !stoppedFirst {
				t.Fatal("sam-mcp rotation ran before the previous generation's agent was stopped")
			}
			if s.sessionHostFor(hostKey) != concurrent || concurrent.Status() == acp.HostStopped {
				t.Fatal("the host created after the stop was stopped or replaced")
			}
			if !concurrent.UsesMcpServerToken(acp.SamMcpServerName, "new-a") {
				t.Fatal("the host created during rotation would start its agent with the revoked sam-mcp token")
			}
			if s.sessionHostFor(otherKey) != otherHost || otherHost.Status() == acp.HostStopped {
				t.Fatal("another workspace's SessionHost was stopped")
			}

			s.sessionHostMu.Lock()
			memoryToken := s.sessionMcpServers[hostKey][0].Token
			otherToken := s.sessionMcpServers[otherKey][0].Token
			ovr, hasOvr := s.sessionProfileOvr[hostKey]
			taskCtx, hasTask := s.sessionTaskCtx[hostKey]
			s.sessionHostMu.Unlock()
			if memoryToken != "new-a" {
				t.Fatalf("in-memory sam-mcp token = %q, want the rotated token", memoryToken)
			}
			if otherToken != "old-other" {
				t.Fatalf("another workspace's sam-mcp token changed to %q", otherToken)
			}
			if !hasOvr || ovr.Model != "model-a" || !hasTask || taskCtx.TaskID != "task-1" {
				t.Fatal("stopping the agent processes dropped the session's profile override or task context")
			}
			persisted, err := s.store.GetSessionMcpServers(generationTestWorkspace, "sess-a")
			if err != nil || len(persisted) != 1 || persisted[0].Token != "new-a" {
				t.Fatalf("persisted MCP list was not kept and rotated: %#v %v", persisted, err)
			}
		})
	}
}

// Absent field: a rebuild from an older control plane does not retire anything,
// so live agent processes keep running exactly as before (rule 73).
func TestWorkspaceRebuildWithoutCallbackTokenKeepsAgentProcesses(t *testing.T) {
	current := generationTestToken(t, generationTestWorkspace, "workspace", "gen-a", time.Hour)
	s, nodeToken, finish, cp := newGenerationServer(t, "running", current)
	hostKey := generationTestWorkspace + ":sess-a"
	s.registerSessionMcpServers(generationTestWorkspace, "sess-a", []acp.McpServerEntry{samMcpEntry("old-a")})
	host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{
		CallbackToken: current, McpServers: []acp.McpServerEntry{samMcpEntry("old-a")},
	}})
	t.Cleanup(host.Stop)
	s.sessionHosts[hostKey] = host
	prepared := make(chan struct{}, 1)
	stubPrepare(t, func() { prepared <- struct{}{} })

	rec := postWorkspaceReprovision(t, s, nodeToken, "rebuild", restartBody(t, false, ""))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("rebuild: %d %s", rec.Code, rec.Body.String())
	}
	finish(nil)
	select {
	case <-prepared: // liveness: the rebuild did run provisioning
	case <-time.After(5 * time.Second):
		t.Fatal("provisioning never reached the bootstrap boundary")
	}
	waitForRestartProvisionFailure(t, s)
	if s.sessionHostFor(hostKey) != host || host.Status() == acp.HostStopped {
		t.Fatal("a rebuild without a delivered token stopped a live agent")
	}
	if !host.UsesMcpServerToken(acp.SamMcpServerName, "old-a") || len(cp.rotationRequests()) != 0 {
		t.Fatal("a rebuild without a delivered token rotated MCP tokens")
	}
}
