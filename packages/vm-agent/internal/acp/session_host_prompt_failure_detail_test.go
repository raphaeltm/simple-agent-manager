package acp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	acpsdk "github.com/coder/acp-go-sdk"
)

// syntheticOpenCodeKeyForRedactionTest is assembled from fragments so the
// repository never holds a literal key. It has no "key=" prefix, so only the
// oc_sk_ shape pattern can redact it.
func syntheticOpenCodeKeyForRedactionTest() string {
	return "oc_" + "sk_" + "Z7mQ2xLp9Rk4Tn8Vb3Wc6Hd1Jf5Gs0Ya2Ue7Io4Pr9Ql1Mz"
}

// openCodeSchemaRejectionWire is OpenCode 1.18.32's session/prompt error from
// the 2026-10-31 node debug package (vm-agent.log "Agent stderr"), with a key
// appended to prove the detail is redacted.
func openCodeSchemaRejectionWire(t *testing.T) *acpsdk.RequestError {
	t.Helper()
	message := "Internal error: Upstream request failed: [400] Unable to submit request because " +
		"`sam-mcp_create_agent_profile` functionDeclaration `parameters.runtime` schema specified " +
		"other fields alongside any_of. When using any_of, it must be the only field set. echoed " +
		syntheticOpenCodeKeyForRedactionTest()
	wire, err := json.Marshal(map[string]any{
		"code":    -32603,
		"message": message,
		"data":    map[string]any{"service": "session", "errorName": "APIError"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var requestError acpsdk.RequestError
	if err := json.Unmarshal(wire, &requestError); err != nil {
		t.Fatal(err)
	}
	return &requestError
}

func promptFailedReport(t *testing.T, reporter *recordingErrorReporter) map[string]interface{} {
	t.Helper()
	for _, report := range reporter.reports {
		if report.message == "ACP Prompt failed" {
			if report.level != "warn" {
				t.Fatalf("ACP Prompt failed level = %q, want warn", report.level)
			}
			return report.context
		}
	}
	t.Fatalf("no ACP Prompt failed report among %d reports", len(reporter.reports))
	return nil
}

func failPrompt(t *testing.T, err error) *recordingErrorReporter {
	t.Helper()
	reporter := &recordingErrorReporter{}
	host := newTestSessionHost(t)
	defer host.Stop()
	host.config.ErrorReporter = reporter
	host.finishPromptWithError(context.Background(), json.RawMessage(`"req-detail"`),
		promptStartInfo{startedAt: time.Now(), viewerID: "viewer-1"}, err)
	return reporter
}

func TestUnclassifiedPromptFailureReportsRedactedDetail(t *testing.T) {
	rejection := openCodeSchemaRejectionWire(t)
	if got := ClassifyPromptError(rejection); got != "" {
		t.Fatalf("schema rejection classified as %q; this test needs an unclassified failure", got)
	}

	fields := promptFailedReport(t, failPrompt(t, rejection))

	if fields["error"] != "agent_prompt_failed" {
		t.Fatalf("error = %v, want agent_prompt_failed", fields["error"])
	}
	detail, ok := fields["detail"].(string)
	if !ok {
		t.Fatalf("detail missing from unclassified failure report: %#v", fields)
	}
	if !strings.Contains(detail, "functionDeclaration `parameters.runtime` schema specified other fields alongside any_of") {
		t.Fatalf("detail does not explain the failure: %q", detail)
	}
	if strings.Contains(detail, syntheticOpenCodeKeyForRedactionTest()) || strings.Contains(detail, "oc_sk_") {
		t.Fatalf("detail leaked an OpenCode key: %q", detail)
	}
	if !strings.Contains(detail, "[REDACTED]") {
		t.Fatalf("detail shows no redaction marker: %q", detail)
	}
}

func TestClassifiedPromptFailureReportsCodeWithoutDetail(t *testing.T) {
	const canary = "sk-secret-canary-123456789"
	fields := promptFailedReport(t, failPrompt(t, acpsdk.NewInternalError(map[string]any{
		"errorKind": "authentication_failed",
		"error":     "untrusted wrapper text " + canary,
	})))

	if fields["error"] != "model_provider_credential_rejected" {
		t.Fatalf("error = %v, want model_provider_credential_rejected", fields["error"])
	}
	if _, ok := fields["detail"]; ok {
		t.Fatalf("classified failure carried raw detail: %#v", fields)
	}
}

func TestPromptFailureDetailIsBoundedAndValidUTF8(t *testing.T) {
	// Multi-byte runes straddle the byte budget, so a naive slice would split one.
	long := "a" + strings.Repeat("é", diagnosticErrorMaxBytes) + " " + syntheticOpenCodeKeyForRedactionTest()
	detail := promptFailureDetail(errors.New(long))

	if len(detail) > diagnosticErrorMaxBytes {
		t.Fatalf("detail is %d bytes, budget %d", len(detail), diagnosticErrorMaxBytes)
	}
	if !utf8.ValidString(detail) {
		t.Fatal("detail was cut inside a UTF-8 sequence")
	}
}

func TestPromptFailureDetailRedactsBeforeTruncating(t *testing.T) {
	// The key starts just before the budget. Truncating first would leave a
	// prefix too short for the shape pattern, so part of the key would ship.
	key := syntheticOpenCodeKeyForRedactionTest()
	padding := strings.Repeat("x", diagnosticErrorMaxBytes-len("oc_sk_Z7mQ2xL")-1)
	detail := promptFailureDetail(errors.New(padding + " " + key))

	if strings.Contains(detail, "oc_sk_") {
		t.Fatalf("truncation exposed a key prefix: %q", detail[len(detail)-40:])
	}
}
