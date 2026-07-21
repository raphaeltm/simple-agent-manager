package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// fakeACPServer serves a configurable ACP handshake for RestoreAgent tests. It
// records LoadSession/NewSession call counts and the exact session id passed to
// LoadSession so tests can assert restore routes through LoadSession with the
// captured identity and never silently falls back to NewSession.
type fakeACPServer struct {
	loadSessionCapability bool
	loadSessionErr        bool
	loadSessionCalls      atomic.Int32
	newSessionCalls       atomic.Int32
	loadSessionIDs        chan string
}

func newFakeACPServer(loadSessionCapability, loadSessionErr bool) *fakeACPServer {
	return &fakeACPServer{
		loadSessionCapability: loadSessionCapability,
		loadSessionErr:        loadSessionErr,
		loadSessionIDs:        make(chan string, 8),
	}
}

func (f *fakeACPServer) serve(reader *io.PipeReader, writer *io.PipeWriter) {
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
				continue // notification, no response expected
			}
			var result map[string]any
			var errObj map[string]any
			switch req.Method {
			case acpsdk.AgentMethodInitialize:
				result = map[string]any{
					"protocolVersion":   acpsdk.ProtocolVersionNumber,
					"agentCapabilities": map[string]any{"loadSession": f.loadSessionCapability},
					"authMethods":       []any{},
				}
			case acpsdk.AgentMethodSessionLoad:
				f.loadSessionCalls.Add(1)
				var p struct {
					SessionID string `json:"sessionId"`
				}
				_ = json.Unmarshal(req.Params, &p)
				select {
				case f.loadSessionIDs <- p.SessionID:
				default:
				}
				if f.loadSessionErr {
					errObj = map[string]any{"code": -32000, "message": "load failed"}
				} else {
					result = map[string]any{"configOptions": []any{}}
				}
			case acpsdk.AgentMethodSessionNew:
				f.newSessionCalls.Add(1)
				result = map[string]any{"sessionId": "fresh-should-not-happen", "configOptions": []any{}}
			default:
				result = map[string]any{}
			}
			resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID)}
			if errObj != nil {
				resp["error"] = errObj
			} else {
				resp["result"] = result
			}
			data, err := json.Marshal(resp)
			if err != nil {
				return
			}
			_, _ = writer.Write(append(data, '\n'))
		}
	}()
}

// installFakeAgentBinary places a no-op executable named command on PATH so
// installAgentBinaryLocal's exec.LookPath fast-path treats the agent as already
// installed. The binary is never executed — StartProcess supplies the fake
// process — it only needs to resolve on PATH. Uses t.Setenv, so callers must not
// run in parallel.
func installFakeAgentBinary(t *testing.T, command string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, command), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// stubProcessLauncher is a non-nil ProcessLauncher so ensureAgentInstalled routes
// to the local (LookPath) install path. Its Start is never called because the
// StartProcess hook takes precedence in startAgentProcess.
type stubProcessLauncher struct{}

func (stubProcessLauncher) Start(ProcessConfig) (*AgentProcess, error) {
	return nil, io.EOF
}

// newAgentKeyServer serves a valid agent-key for RestoreAgent tests. failFirst,
// when > 0, returns HTTP 500 for that many initial agent-key calls (to simulate
// a transient credential-fetch failure) before succeeding.
func newAgentKeyServer(t *testing.T, failFirst int32) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/agent-key") {
			w.WriteHeader(http.StatusNotFound) // agent-settings → defaults
			return
		}
		if calls.Add(1) <= failFirst {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apiKey":"test-api-key","credentialKind":"api-key"}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newRestoreTestHost(t *testing.T, keyServerURL string, acp *fakeACPServer, onSpawn func(*fakeAgentProcess)) *SessionHost {
	t.Helper()
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			SessionID:            "test-session",
			WorkspaceID:          "test-workspace",
			ControlPlaneURL:      keyServerURL,
			CallbackToken:        "test-token",
			PreviousAcpSessionID: "acp-session-1",
			PreviousAgentType:    "claude-code",
			InitializeTimeoutMs:  500,
			LoadSessionTimeoutMs: 500,
			NewSessionTimeoutMs:  500,
		},
		MessageBufferSize: 100,
		ViewerSendBuffer:  32,
	})
	host.config.ProcessLauncher = stubProcessLauncher{}
	host.config.StartProcess = func(*agentStartup) (agentProcess, error) {
		proc, reader, writer := newFakeAgentProcess(time.Now(), false)
		acp.serve(reader, writer)
		if onSpawn != nil {
			onSpawn(proc)
		}
		return proc, nil
	}
	return host
}

// TestSessionHost_RestoreAgent_LoadsCapturedSessionNotNewSession is T9/G6 (a):
// the happy path routes through LoadSession with the captured previous ACP
// session id and never calls NewSession.
func TestSessionHost_RestoreAgent_LoadsCapturedSessionNotNewSession(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	keySrv := newAgentKeyServer(t, 0)
	acp := newFakeACPServer(true, false)
	host := newRestoreTestHost(t, keySrv.URL, acp, nil)
	defer host.Stop()

	if err := host.RestoreAgent(context.Background(), "claude-code"); err != nil {
		t.Fatalf("RestoreAgent failed: %v", err)
	}
	if host.Status() != HostReady {
		t.Fatalf("status = %s, want HostReady", host.Status())
	}
	if got := acp.loadSessionCalls.Load(); got != 1 {
		t.Fatalf("LoadSession calls = %d, want 1", got)
	}
	if got := acp.newSessionCalls.Load(); got != 0 {
		t.Fatalf("NewSession calls = %d, want 0 (restore must never NewSession)", got)
	}
	select {
	case id := <-acp.loadSessionIDs:
		if id != "acp-session-1" {
			t.Fatalf("LoadSession target = %q, want captured id acp-session-1", id)
		}
	default:
		t.Fatal("LoadSession was not invoked with a session id")
	}
	host.mu.RLock()
	sid := string(host.sessionID)
	host.mu.RUnlock()
	if sid != "acp-session-1" {
		t.Fatalf("resumed sessionID = %q, want acp-session-1", sid)
	}
}

// TestSessionHost_RestoreAgent_LoadSessionErrorDoesNotFallBackToNewSession is
// T9/G6 (b): a LoadSession RPC error surfaces as an error and never falls back
// to NewSession.
func TestSessionHost_RestoreAgent_LoadSessionErrorDoesNotFallBackToNewSession(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	keySrv := newAgentKeyServer(t, 0)
	acp := newFakeACPServer(true, true)
	host := newRestoreTestHost(t, keySrv.URL, acp, nil)
	defer host.Stop()

	err := host.RestoreAgent(context.Background(), "claude-code")
	if err == nil {
		t.Fatal("RestoreAgent returned nil, want LoadSession error surfaced")
	}
	if got := acp.loadSessionCalls.Load(); got != 1 {
		t.Fatalf("LoadSession calls = %d, want 1", got)
	}
	if got := acp.newSessionCalls.Load(); got != 0 {
		t.Fatalf("NewSession calls = %d, want 0 (restore must not fall back to a fork)", got)
	}
	if host.Status() != HostError {
		t.Fatalf("status = %s, want HostError", host.Status())
	}
}

// TestSessionHost_RestoreAgent_NoLoadSessionCapabilityFails is T9/G6 (c): an
// agent that reports loadSession=false fails restore and never silently starts a
// fresh session.
func TestSessionHost_RestoreAgent_NoLoadSessionCapabilityFails(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	keySrv := newAgentKeyServer(t, 0)
	acp := newFakeACPServer(false, false)
	host := newRestoreTestHost(t, keySrv.URL, acp, nil)
	defer host.Stop()

	err := host.RestoreAgent(context.Background(), "claude-code")
	if err == nil {
		t.Fatal("RestoreAgent returned nil, want failure when agent lacks LoadSession")
	}
	if got := acp.newSessionCalls.Load(); got != 0 {
		t.Fatalf("NewSession calls = %d, want 0 (must not silently start fresh)", got)
	}
	if got := acp.loadSessionCalls.Load(); got != 0 {
		t.Fatalf("LoadSession calls = %d, want 0 (capability absent, RPC not sent)", got)
	}
	if host.Status() != HostError {
		t.Fatalf("status = %s, want HostError", host.Status())
	}
}

// TestSessionHost_RestoreAgent_RetainsRestoreIdentityAfterTransientFailure is the
// G1 regression: a transient first RestoreAgent failure must NOT strip the
// restore identity from the cached host. A retry must still resolve the captured
// loadSessionID and reach LoadSession (rule 49).
func TestSessionHost_RestoreAgent_RetainsRestoreIdentityAfterTransientFailure(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	keySrv := newAgentKeyServer(t, 1) // first agent-key call fails, second succeeds
	acp := newFakeACPServer(true, false)
	host := newRestoreTestHost(t, keySrv.URL, acp, nil)
	defer host.Stop()

	if err := host.RestoreAgent(context.Background(), "claude-code"); err == nil {
		t.Fatal("first RestoreAgent should fail transiently at credential fetch")
	}
	host.mu.RLock()
	prevID := host.config.PreviousAcpSessionID
	host.mu.RUnlock()
	if prevID != "acp-session-1" {
		t.Fatalf("PreviousAcpSessionID = %q after transient failure, want acp-session-1 retained", prevID)
	}

	if err := host.RestoreAgent(context.Background(), "claude-code"); err != nil {
		t.Fatalf("retry RestoreAgent failed: %v", err)
	}
	if got := acp.loadSessionCalls.Load(); got != 1 {
		t.Fatalf("LoadSession calls = %d, want 1 on retry", got)
	}
	if got := acp.newSessionCalls.Load(); got != 0 {
		t.Fatalf("NewSession calls = %d, want 0 on retry", got)
	}
	select {
	case id := <-acp.loadSessionIDs:
		if id != "acp-session-1" {
			t.Fatalf("retry LoadSession target = %q, want acp-session-1", id)
		}
	default:
		t.Fatal("retry did not invoke LoadSession")
	}
}

// TestSessionHost_RestoreAgent_ConcurrentCallsSpawnOnce is the G2 regression: two
// concurrent RestoreAgent calls for one session must spawn exactly one process,
// even during the fresh-host window where h.process is still nil during the
// credential fetch. Run with -race.
func TestSessionHost_RestoreAgent_ConcurrentCallsSpawnOnce(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	// Delay the agent-key response to widen the fresh-host window so the second
	// call reaches beginAgentSelection while the first is still fetching.
	var calls atomic.Int32
	keySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/agent-key") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if calls.Add(1) == 1 {
			time.Sleep(75 * time.Millisecond)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apiKey":"test-api-key","credentialKind":"api-key"}`))
	}))
	defer keySrv.Close()

	acp := newFakeACPServer(true, false)
	var spawnCount atomic.Int32
	host := newRestoreTestHost(t, keySrv.URL, acp, func(*fakeAgentProcess) { spawnCount.Add(1) })
	defer host.Stop()

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = host.RestoreAgent(context.Background(), "claude-code")
		}()
	}
	wg.Wait()

	if got := spawnCount.Load(); got != 1 {
		t.Fatalf("process spawns = %d, want 1 (concurrent restore must not double-spawn)", got)
	}
}

// TestSessionHost_RestoreAgent_StopsProcessWhenLoadSessionFails is the G3
// regression: when establishACPSession fails AFTER the process spawned
// (LoadSession rejected, process still alive), the spawned process must be
// stopped so no orphaned agent binary leaks.
func TestSessionHost_RestoreAgent_StopsProcessWhenLoadSessionFails(t *testing.T) {
	installFakeAgentBinary(t, "claude-agent-acp")
	keySrv := newAgentKeyServer(t, 0)
	acp := newFakeACPServer(true, true) // LoadSession rejected after spawn
	var mu sync.Mutex
	var spawned *fakeAgentProcess
	host := newRestoreTestHost(t, keySrv.URL, acp, func(p *fakeAgentProcess) {
		mu.Lock()
		spawned = p
		mu.Unlock()
	})
	defer host.Stop()

	if err := host.RestoreAgent(context.Background(), "claude-code"); err == nil {
		t.Fatal("RestoreAgent returned nil, want failure after LoadSession rejection")
	}
	mu.Lock()
	proc := spawned
	mu.Unlock()
	if proc == nil {
		t.Fatal("process was never spawned; cannot verify orphan cleanup")
	}
	if got := proc.stopCount.Load(); got != 1 {
		t.Fatalf("spawned process Stop count = %d, want 1 (orphan must be stopped on selection failure)", got)
	}
}
