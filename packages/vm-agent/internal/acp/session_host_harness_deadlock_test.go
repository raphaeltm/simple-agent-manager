package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestHarnessNotificationDuringHandshakeDoesNotDeadlock is the regression test
// for a genuine self-deadlock between the ACP SDK's single notification-
// processing goroutine and the SessionHost's own handshake goroutine.
//
// Mechanism: the acp-go-sdk processes notifications (no `id`) on ONE serialized
// goroutine, and blocks every RPC response on `waitNotificationsUpTo` — i.e. the
// RPC caller waits for the notification worker to drain. `startAgent` holds
// `h.mu` for its entire duration, including the NewSession/LoadSession RPC. So
// if `HandleExtensionMethod` (a notification handler) took `h.mu.RLock()`, a
// `_claude/sdkMessage` arriving just before the `session/new` response would
// deadlock: the worker waits for `h.mu`, and `h.mu`'s holder waits for the
// worker.
//
// This matters in production precisely for the feature's flagship case —
// resuming a session that already has active background work, where the harness
// re-announces its tasks as soon as it sees the resume request.
//
// DISCRIMINATING: reverting `matchesHarnessSession`/`activityForHarnessWork` to
// take `h.mu.RLock()` makes this test fail (the handshake stalls to its
// timeout) while the control below still passes.
func TestHarnessNotificationDuringHandshakeDoesNotDeadlock(t *testing.T) {
	elapsed, sessionID, err := runHandshakeWithAgentScript(t, true)
	if err != nil {
		t.Fatalf("handshake failed with a harness notification in flight: %v (elapsed %s)", err, elapsed)
	}
	if sessionID == "" {
		t.Fatal("handshake produced no session ID")
	}
	// The handshake budget is 2s below; a deadlock consumes all of it. A healthy
	// handshake over in-memory pipes completes in single-digit milliseconds.
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("handshake took %s — notification worker was blocked on h.mu", elapsed)
	}
}

// Control: the identical handshake WITHOUT the interleaved notification. If this
// ever fails, the harness above is broken rather than the code under test.
func TestHandshakeWithoutHarnessNotificationSucceeds(t *testing.T) {
	elapsed, sessionID, err := runHandshakeWithAgentScript(t, false)
	if err != nil {
		t.Fatalf("control handshake failed: %v (elapsed %s)", err, elapsed)
	}
	if sessionID == "" {
		t.Fatal("control handshake produced no session ID")
	}
	_ = elapsed
}

// runHandshakeWithAgentScript drives a real ACP connection over in-memory pipes.
// The fake agent answers `initialize` and `session/new`; when
// emitHarnessNotification is set it writes a `_claude/sdkMessage` notification
// immediately BEFORE the `session/new` response, reproducing the ordering that
// triggers the deadlock.
func runHandshakeWithAgentScript(
	t *testing.T,
	emitHarnessNotification bool,
) (time.Duration, string, error) {
	t.Helper()

	process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
	t.Cleanup(func() { _ = process.Stop() })

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			InitTimeoutMs:       2000,
			NewSessionTimeoutMs: 2000,
		},
		StartProcess: func(*agentStartup) (agentProcess, error) { return process, nil },
	})

	// Fake agent: read requests, reply, and optionally slip a harness lifecycle
	// notification in front of the session/new response.
	go func() {
		scanner := bufio.NewScanner(agentStdin)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if err := json.Unmarshal([]byte(line), &msg); err != nil || len(msg.ID) == 0 {
				continue // notification from client; nothing to answer
			}
			switch msg.Method {
			case "initialize":
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`)
			case "session/new":
				if emitHarnessNotification {
					// A notification enqueued BEFORE the response: the SDK will make
					// the session/new caller wait for the notification worker.
					writeAgentLine(agentStdout, `{"jsonrpc":"2.0","method":"_claude/sdkMessage",`+
						`"params":{"sessionId":"sdk-session-1","message":{"type":"task_started",`+
						`"task_id":"bg-1","session_id":"sdk-session-1"}}}`)
				}
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"sessionId":"sdk-session-1"}}`)
			default:
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+`,"result":{}}`)
			}
		}
	}()

	// Mirror production: startAgent is called with h.mu held for write.
	start := time.Now()
	host.mu.Lock()
	err := host.startAgentWithSessionMode(
		context.Background(),
		"claude-code",
		&agentCredential{credential: "test-key", credentialKind: "api-key"},
		nil,
		"",
		false,
	)
	sessionID := string(host.sessionID)
	host.mu.Unlock()
	return time.Since(start), sessionID, err
}

func writeAgentLine(w interface{ Write([]byte) (int, error) }, line string) {
	_, _ = w.Write([]byte(line + "\n"))
}

// TestHarnessNotificationDuringSessionSettingsDoesNotDeadlock closes the gap the
// sibling test above cannot reach.
//
// TestHarnessNotificationDuringHandshakeDoesNotDeadlock fires its notification
// before the session/new RESPONSE, so the session mirror is still empty:
// matchesHarnessSession short-circuits on `expected == ""` and the handler never
// reaches applyClaudeHarnessLifecycle/reportActivity at all. It also leaves the
// identity config blank, which would independently short-circuit reportActivity
// before its lock. So it proves nothing about the call path that actually runs
// in production.
//
// This test reproduces the production ordering instead:
//   - setSessionIDLocked populates the mirror when session/new returns, THEN
//   - applySessionSettings issues SetSessionMode while startSelectedAgent still
//     holds h.mu for WRITE,
//   - and the harness re-announces its background tasks in that window.
//
// At that point matchesHarnessSession matches, so the handler proceeds to report
// activity. reportActivity takes h.mu.RLock to snapshot
// agentType/restartCount/statusErr — the exact block the lock-free mirrors exist
// to prevent — so calling it inline deadlocks the notification worker against
// the handshake until the session-settings timeout fires.
//
// DISCRIMINATING: replacing nudgeHarnessActivityReport() in HandleExtensionMethod
// with the original inline `c.host.reportActivity(c.host.activityForHarnessWork())`
// makes this test fail — the handshake stalls to the full NewSessionTimeoutMs
// budget instead of completing promptly. Verified before relying on it.
func TestHarnessNotificationDuringSessionSettingsDoesNotDeadlock(t *testing.T) {
	process, agentStdin, agentStdout := newFakeAgentProcess(time.Now(), true)
	t.Cleanup(func() { _ = process.Stop() })

	const settingsBudget = 2000 * time.Millisecond

	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			InitTimeoutMs:       2000,
			NewSessionTimeoutMs: int(settingsBudget / time.Millisecond),
			// Production-like identity: without these, reportActivity returns at
			// its "missing config" guard and never reaches h.mu.RLock, which
			// would make this test silently non-discriminating.
			ProjectID:       "proj-harness-deadlock",
			NodeID:          "node-harness-deadlock",
			WorkspaceID:     "ws-harness-deadlock",
			SessionID:       "chat-harness-deadlock",
			CallbackToken:   "test-callback-token",
			ControlPlaneURL: "http://127.0.0.1:1", // refused instantly; POST runs off-goroutine
		},
		StartProcess: func(*agentStartup) (agentProcess, error) { return process, nil },
	})

	go func() {
		scanner := bufio.NewScanner(agentStdin)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			if err := json.Unmarshal([]byte(line), &msg); err != nil || len(msg.ID) == 0 {
				continue
			}
			switch msg.Method {
			case "initialize":
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`)
			case "session/new":
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+
					`,"result":{"sessionId":"sdk-session-1"}}`)
			case "session/set_mode":
				// The mirror now holds sdk-session-1, so this notification passes
				// matchesHarnessSession and reaches the reporting path — while
				// h.mu is held for write by startSelectedAgent.
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","method":"_claude/sdkMessage",`+
					`"params":{"sessionId":"sdk-session-1","message":{"type":"system",`+
					`"subtype":"task_started","task_id":"bg-1","session_id":"sdk-session-1"}}}`)
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+`,"result":{}}`)
			default:
				writeAgentLine(agentStdout, `{"jsonrpc":"2.0","id":`+string(msg.ID)+`,"result":{}}`)
			}
		}
	}()

	start := time.Now()
	host.mu.Lock()
	err := host.startAgentWithSessionMode(
		context.Background(),
		"claude-code",
		&agentCredential{credential: "test-key", credentialKind: "api-key"},
		&agentSettingsPayload{PermissionMode: "acceptEdits"},
		"",
		false,
	)
	sessionID := string(host.sessionID)
	host.mu.Unlock()
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("handshake failed with a harness notification during session settings: %v (elapsed %s)", err, elapsed)
	}
	if sessionID == "" {
		t.Fatal("handshake produced no session ID")
	}
	// A deadlock consumes the whole settings budget before the timeout frees it.
	// A healthy run is milliseconds; half the budget is a generous ceiling that
	// still fails loudly on the regression.
	// Self-validation: if the payload shape ever drifts, applyClaudeHarnessLifecycle
	// returns false, the report is never attempted, and the timing assertion below
	// would pass vacuously. Assert the harness path actually executed.
	if snap := host.harnessWorkSnapshot(); snap.Count != 1 || snap.State != harnessWorkActive {
		t.Fatalf("harness lifecycle never registered the background task (state=%q count=%d); "+
			"the timing assertion below would be vacuous", snap.State, snap.Count)
	}
	if elapsed >= settingsBudget/2 {
		t.Fatalf("handshake took %s (>= %s): the notification worker blocked on h.mu, "+
			"which means the harness report is being made inline again", elapsed, settingsBudget/2)
	}
}
