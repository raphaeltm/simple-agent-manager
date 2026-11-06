package acp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// acceptCodexRuntime stands in for the C2 release check in tests that start Codex
// through fakes. Runtime selection still runs exactly as in production.
func acceptCodexRuntime(context.Context, agentCommandInfo) error { return nil }

var errStopAtRuntimeCheck = errors.New("stop at runtime check")

// TestSelectAgentCodexVerifiesC2RuntimeInEveryMode drives the real selection entry
// point (the browser's select_agent) for Codex. Before the fix, a task-mode session
// (permission interactions only) or a host with interactions off went to the stock
// npm adapter, which cannot steer; only conversation forms/URLs reached C2.
func TestSelectAgentCodexVerifiesC2RuntimeInEveryMode(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config AcpInteractionRuntimeConfig
	}{
		{"task mode (permissions only)", testInteractionConfig()},
		{"interactions disabled", AcpInteractionRuntimeConfig{}},
		{"conversation forms", testFormConfig()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var verified []agentCommandInfo
			recorder := &selectionErrorRecorder{}
			host := newCodexSelectionHost(t, recorder, nil, func(_ context.Context, info agentCommandInfo) error {
				mu.Lock()
				defer mu.Unlock()
				verified = append(verified, info)
				return errStopAtRuntimeCheck
			})
			host.ConfigureAcpInteractions(tc.config)

			host.SelectAgent(context.Background(), "openai-codex")

			mu.Lock()
			defer mu.Unlock()
			if len(verified) != 1 {
				t.Fatalf("C2 runtime checks = %d, want 1 (selection error %q)", len(verified), recorder.message)
			}
			if verified[0].command != codexC2ReleaseRoot+"/current/bin/codex-acp" || verified[0].validationCmd != codexC2CandidateCheck {
				t.Fatalf("selection verified %+v, want the C2 release", verified[0])
			}
			// The failed check stops selection and the persisted error names the opt-out.
			if !strings.Contains(recorder.message, codexC2CandidateEnv+"=0") {
				t.Fatalf("selection error %q does not name the stock opt-out", recorder.message)
			}
		})
	}
}

// TestSelectAgentCodexProfileOptOutUsesStockAdapter is the control: a profile marker of
// "0" must reach the stock adapter path, never the C2 check.
func TestSelectAgentCodexProfileOptOutUsesStockAdapter(t *testing.T) {
	verifyCalls := 0
	recorder := &selectionErrorRecorder{}
	host := newCodexSelectionHost(t, recorder, func(context.Context) (RuntimeAssets, error) {
		return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: codexC2CandidateEnv, Value: "0"}}}, nil
	}, func(context.Context, agentCommandInfo) error {
		verifyCalls++
		return errStopAtRuntimeCheck
	})

	host.SelectAgent(context.Background(), "openai-codex")

	if verifyCalls != 0 {
		t.Fatalf("opted-out session ran the C2 check %d times", verifyCalls)
	}
	// Liveness: selection did proceed to the stock install, which this host cannot run.
	if !strings.Contains(recorder.message, "Failed to install codex-acp") {
		t.Fatalf("selection error %q, want the stock install attempt", recorder.message)
	}
}

// C2 failing verification must not pin the host to it: the profile's opt-out has to work on
// the next selection without a new session.
func TestSelectAgentCodexOptOutAfterFailedC2Verification(t *testing.T) {
	marker := ""
	verifyCalls := 0
	recorder := &selectionErrorRecorder{}
	host := newCodexSelectionHost(t, recorder, func(context.Context) (RuntimeAssets, error) {
		if marker == "" {
			return RuntimeAssets{}, nil
		}
		return RuntimeAssets{EnvVars: []RuntimeEnvVar{{Key: codexC2CandidateEnv, Value: marker}}}, nil
	}, func(context.Context, agentCommandInfo) error {
		verifyCalls++
		return errStopAtRuntimeCheck
	})

	host.SelectAgent(context.Background(), "openai-codex")
	if verifyCalls != 1 || !strings.Contains(recorder.message, codexC2CandidateEnv+"=0") {
		t.Fatalf("first selection: verify calls %d, error %q", verifyCalls, recorder.message)
	}

	marker = "0"
	host.SelectAgent(context.Background(), "openai-codex")
	if verifyCalls != 1 {
		t.Fatalf("opted-out retry ran the C2 check again (%d calls)", verifyCalls)
	}
	if !strings.Contains(recorder.message, "Failed to install codex-acp") {
		t.Fatalf("opted-out retry error %q, want the stock install attempt", recorder.message)
	}
}

// A host with neither a process launcher nor a container resolver must refuse the
// runtime with a reason, not panic on the nil resolver.
func TestVerifyCodexRuntimeWithoutAgentContainerFailsClosed(t *testing.T) {
	host := NewSessionHost(SessionHostConfig{})
	defer host.Stop()
	err := host.ensureAgentInstalled(context.Background(), agentCommandInfo{
		command: codexC2ReleaseRoot + "/current/bin/codex-acp", validationCmd: codexC2CandidateCheck, verifyOnly: true,
	})
	if err == nil || !strings.Contains(err.Error(), "no agent container") || !strings.Contains(err.Error(), codexC2CandidateEnv+"=0") {
		t.Fatalf("error = %v, want a fail-closed refusal naming the opt-out", err)
	}
}

func newCodexSelectionHost(
	t *testing.T,
	recorder *selectionErrorRecorder,
	assets func(context.Context) (RuntimeAssets, error),
	verify func(context.Context, agentCommandInfo) error,
) *SessionHost {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"apiKey":"test-api-key","credentialKind":"api-key"}`))
	}))
	t.Cleanup(server.Close)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: server.URL, HTTPClient: server.Client(),
			SessionID: "session-1", WorkspaceID: "workspace-1", SessionManager: recorder,
			// No real container: the stock path fails here instead of running npm.
			ContainerResolver: func() (string, error) { return "", errors.New("no container in test") },
		},
		RuntimeAssetsProvider: assets,
		VerifyCodexRuntime:    verify,
	})
	t.Cleanup(host.Stop)
	return host
}
