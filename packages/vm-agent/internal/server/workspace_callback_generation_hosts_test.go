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

// restartObservation records one restartSessionAgentForCredentialRotation call:
// which host, and the credentials that host would hand its replacement agent at
// that moment.
type restartObservation struct {
	host                 *acp.SessionHost
	rotatedMcpToken      bool
	deliveredCallback    bool
	registeredAtRestart  bool
	statusBeforeRestart  acp.SessionHostStatus
	hadRunningAgentProcs bool
}

// observeAgentRestarts wraps the restart seam for one test: each call is
// recorded, then the real SessionHost method runs.
func observeAgentRestarts(t *testing.T, s *Server, hostKeyOf map[*acp.SessionHost]string, rotatedMcpToken, delivered string) func() []restartObservation {
	t.Helper()
	var mu sync.Mutex
	var calls []restartObservation
	original := restartSessionAgentForCredentialRotation
	restartSessionAgentForCredentialRotation = func(host *acp.SessionHost) bool {
		obs := restartObservation{
			host:                host,
			rotatedMcpToken:     host.UsesMcpServerToken(acp.SamMcpServerName, rotatedMcpToken),
			deliveredCallback:   host.UsesCallbackToken(delivered),
			registeredAtRestart: s.sessionHostFor(hostKeyOf[host]) == host,
			statusBeforeRestart: host.Status(),
		}
		obs.hadRunningAgentProcs = original(host)
		mu.Lock()
		calls = append(calls, obs)
		mu.Unlock()
		return obs.hadRunningAgentProcs
	}
	t.Cleanup(func() { restartSessionAgentForCredentialRotation = original })
	return func() []restartObservation {
		mu.Lock()
		defer mu.Unlock()
		return append([]restartObservation(nil), calls...)
	}
}

// A restart or rebuild that delivers a new callback generation's token replaces
// every agent process started with the previous generation WITHOUT stopping or
// removing its SessionHost: the control plane's task-liveness probe fails a task
// whose agent host is stopped (task_agent_host_stopped), which on staging failed
// a live chat and then its next follow-up. The host stays registered and
// running, ends with the new callback token and the rotated sam-mcp token, and
// its agent restart is requested only AFTER the rotation installed that token,
// so the replacement process starts with generation-B credentials. The
// session's MCP list, profile override and task context survive. Another
// workspace is untouched. (Process-level restart behaviour is pinned in
// internal/acp/session_host_credential_rotation_test.go: SessionHost cannot be
// given a fake agent process from this package.)
func TestWorkspaceReprovisionWithDeliveredTokenRestartsAgentsInPlace(t *testing.T) {
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

			host := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{
				CallbackToken: current, McpServers: []acp.McpServerEntry{samMcpEntry("old-a")},
			}})
			otherHost := acp.NewSessionHost(acp.SessionHostConfig{GatewayConfig: acp.GatewayConfig{
				McpServers: []acp.McpServerEntry{samMcpEntry("old-other")},
			}})
			t.Cleanup(host.Stop)
			t.Cleanup(otherHost.Stop)
			s.sessionHosts[hostKey] = host
			s.sessionHosts[otherKey] = otherHost
			restarts := observeAgentRestarts(t, s, map[*acp.SessionHost]string{host: hostKey, otherHost: otherKey}, "new-a", delivered)

			restartedBeforeRotation := false
			cp.respond = func(int, string) (int, string) {
				restartedBeforeRotation = len(restarts()) > 0
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
			if !host.UsesCallbackToken(delivered) {
				t.Fatal("the claim did not propagate the delivered callback token to the live host")
			}
			waitFor(t, func() bool { return cp.heldRotations() > 0 }, "the sam-mcp rotation never started")

			// A reconnect while the rotation is in flight, through the real
			// host-creation path, attaches to the SAME host: nothing removed it.
			if reconnect := s.getOrCreateSessionHost(hostKey, generationTestWorkspace, "sess-a", agentsessions.Session{}, nil, ""); reconnect != host {
				t.Fatal("a reconnect during rotation got a different SessionHost; the host was removed")
			}
			if host.Status() == acp.HostStopped {
				t.Fatal("the SessionHost was stopped before the sam-mcp rotation")
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
			restartedFirst := restartedBeforeRotation
			cp.mu.Unlock()
			if restartedFirst {
				t.Fatal("an agent restart ran before the sam-mcp rotation; the replacement would start with the revoked token")
			}
			calls := restarts()
			if len(calls) != 1 || calls[0].host != host {
				t.Fatalf("agent restarts = %d (want exactly one, for this workspace's host)", len(calls))
			}
			if !calls[0].rotatedMcpToken || !calls[0].deliveredCallback {
				t.Fatalf("at restart the host had rotated sam-mcp=%v, delivered callback=%v; the replacement agent must start with both",
					calls[0].rotatedMcpToken, calls[0].deliveredCallback)
			}
			if !calls[0].registeredAtRestart || calls[0].statusBeforeRestart == acp.HostStopped {
				t.Fatal("the host was removed or stopped before its agent restart")
			}

			if s.sessionHostFor(hostKey) != host {
				t.Fatal("the SessionHost was removed from the server; task liveness would see the agent host stopped")
			}
			if status := host.Status(); status == acp.HostStopped || status == acp.HostError {
				t.Fatalf("SessionHost status = %s after the rotation, want it live", status)
			}
			if !host.UsesCallbackToken(delivered) || !host.UsesMcpServerToken(acp.SamMcpServerName, "new-a") {
				t.Fatal("the kept host would start its next agent with the previous generation's credentials")
			}
			if s.sessionHostFor(otherKey) != otherHost || otherHost.Status() == acp.HostStopped {
				t.Fatal("another workspace's SessionHost was stopped or removed")
			}
			if !otherHost.UsesMcpServerToken(acp.SamMcpServerName, "old-other") {
				t.Fatal("another workspace's SessionHost had its MCP list replaced")
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
				t.Fatal("restarting the agent processes dropped the session's profile override or task context")
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
	restarts := observeAgentRestarts(t, s, map[*acp.SessionHost]string{host: hostKey}, "new-a", "")
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
	if calls := restarts(); len(calls) != 0 {
		t.Fatalf("a rebuild without a delivered token restarted %d agent process(es)", len(calls))
	}
}
