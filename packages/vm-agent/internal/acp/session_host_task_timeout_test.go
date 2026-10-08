package acp

import (
	"context"
	"encoding/json"
	"testing"
	"testing/synctest"
	"time"
)

// Drive the real ACP prompt, context deadline and watchdog. The fake agent keeps
// producing transcript updates past the former deadline, then hands control back.
func TestTaskPromptProgressSurvivesDurationDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		progressDone := make(chan struct{})
		host, server := newPromptRetryTestHost(t, promptRetryScript{responses: []promptRetryResponse{{
			stopReason: "end_turn",
			beforeReply: func(agent *promptRetryFakeAgent) {
				defer close(progressDone)
				for range 9 {
					time.Sleep(time.Hour)
					agent.writeJSON(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
						"sessionId": "acp-session-retry", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Still making progress."}},
					}})
				}
			},
		}}})
		host.config.TaskManaged = true
		host.config.PromptTimeout = 8 * time.Hour
		completed := make(chan string, 2)
		host.config.OnPromptComplete = func(reason string, err error) {
			if err != nil {
				t.Errorf("healthy task failed: %v", err)
			}
			completed <- reason
		}
		host.HandlePrompt(context.Background(), json.RawMessage(`1`), promptRetryParams(), "viewer-1", false)
		<-progressDone
		synctest.Wait()
		if got := <-completed; got != "end_turn" {
			t.Fatalf("completion = %s", got)
		}
		if server.RequestCount() != 1 {
			t.Fatal("prompt was replayed")
		}
		if host.Status() != HostReady {
			t.Fatalf("status = %s", host.Status())
		}
		if len(host.config.MessageReporter.(*mockMessageReporter).Messages()) < 10 {
			t.Fatal("transcript progress was not delivered")
		}
	})
}

func TestTaskPromptStillHonorsControlPlaneContextDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		progressDone := make(chan struct{})
		host, _ := newPromptRetryTestHost(t, promptRetryScript{responses: []promptRetryResponse{{
			stopReason: "end_turn", beforeReply: func(_ *promptRetryFakeAgent) {
				defer close(progressDone)
				time.Sleep(2 * time.Hour)
			},
		}}})
		host.config.TaskManaged = true
		completed := make(chan string, 2)
		host.config.OnPromptComplete = func(reason string, err error) {
			if err == nil {
				t.Error("caller deadline did not fail the prompt")
			}
			completed <- reason
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
		defer cancel()
		host.HandlePrompt(ctx, json.RawMessage(`1`), promptRetryParams(), "control-plane", true)
		<-progressDone
		synctest.Wait()
		if got := <-completed; got != fatalErrorStopReason {
			t.Fatalf("completion = %s", got)
		}
		if host.Status() != HostError {
			t.Fatalf("status = %s", host.Status())
		}
	})
}
