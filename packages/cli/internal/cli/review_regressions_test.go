package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestReviewRejectedInputsNeverRequestOrExposePrompt(t *testing.T) {
	for _, args := range [][]string{
		{"tasks", "submit", "PRIVATE_SYNTHETIC_PROMPT", "--bogus", "--json"},
		{"tasks", "submit", "prompt", "--project", "one", "--project=two"},
		{"tasks", "submit", "prompt", "--agent-profile", "one", "--agent-profile-id", "two"},
		{"ideas", "execute", "idea", "--prompt-file", "unused"},
		{"chat", "fork", "session", "--prompt", "PRIVATE_SYNTHETIC_PROMPT"},
	} {
		calls := 0
		h := roundTripFunc(func(req *http.Request) (*http.Response, error) { calls++; return jsonResponse(`{}`, 200), nil })
		r, _, stderr := testRuntime(t, args, h, nil)
		if code := Run(context.Background(), r); code != 1 || calls != 0 || strings.Contains(stderr.String(), "PRIVATE_SYNTHETIC_PROMPT") {
			t.Fatalf("code=%d calls=%d stderr=%s", code, calls, stderr.String())
		}
	}
}

func TestWaitDeadlineDuringRequestReturnsTimeout(t *testing.T) {
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	r, out, stderr := testRuntime(t, []string{"tasks", "wait", "task", "--project", workflowProject, "--timeout", "1ms", "--json"}, h, nil)
	if code := Run(context.Background(), r); code != 3 || !strings.Contains(out.String(), "wait_timeout") || stderr.Len() != 0 {
		t.Fatalf("code=%d out=%s stderr=%s", code, out.String(), stderr.String())
	}
}

type failingReviewBody struct{}

func (failingReviewBody) Read([]byte) (int, error) { return 0, errors.New("PRIVATE_READER_ERROR") }
func (failingReviewBody) Close() error             { return nil }
func TestAcceptedUnparseableWritesHaveUnknownOutcome(t *testing.T) {
	for _, body := range []io.ReadCloser{io.NopCloser(strings.NewReader("")), failingReviewBody{}, io.NopCloser(strings.NewReader("not-json")), io.NopCloser(strings.NewReader(strings.Repeat("x", 100)))} {
		h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 202, Body: body, Header: http.Header{}}, nil
		})
		var value any
		err := doJSONWithLimit(context.Background(), h, "POST", "https://example.com/api/tasks", "", map[string]any{"message": "synthetic"}, &value, 16)
		var apiErr APIError
		if !errors.As(err, &apiErr) || apiErr.Code != "OUTCOME_UNKNOWN" || strings.Contains(err.Error(), "PRIVATE_READER_ERROR") {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestInformationalDiagnosticRetainsRedactionWithoutError(t *testing.T) {
	var output bytes.Buffer
	writer := redactingWriter{destination: structuredErrorWriter{destination: &output}, secrets: []string{"PRIVATE_TOKEN"}}
	writeDiagnostic(writer, []byte(`{"authorizationRequired":true,"token":"PRIVATE_TOKEN"}`))
	if strings.Contains(output.String(), "CLI_ERROR") || strings.Contains(output.String(), "PRIVATE_TOKEN") || !strings.Contains(output.String(), `"authorizationRequired":true`) {
		t.Fatal(output.String())
	}
}

func TestLegacyTaskStatusPreservesCompleteJSON(t *testing.T) {
	h, _ := captureJSONRequest(t, `{"id":"task","status":"running","description":"synthetic","placement":{"runtime":"vm"},"skillId":"skill"}`, 200)
	r, out, stderr := testRuntime(t, []string{"task", "status", "task", "--project", workflowProject, "--json"}, h, nil)
	if code := Run(context.Background(), r); code != 0 || stderr.Len() != 0 || !strings.Contains(out.String(), `"placement"`) || !strings.Contains(out.String(), `"skillId"`) {
		t.Fatalf("code=%d out=%s err=%s", code, out.String(), stderr.String())
	}
}

func TestWaitCallerCancellationDoesNotClaimTimeoutOrCancelTask(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		cancel()
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	r, out, stderr := testRuntime(t, []string{"tasks", "wait", "task", "--project", workflowProject, "--json"}, h, nil)
	if code := Run(ctx, r); code != 130 || !strings.Contains(out.String(), "wait_cancelled") || strings.Contains(out.String(), "wait_timeout") || stderr.Len() != 0 {
		t.Fatalf("code=%d out=%s err=%s", code, out.String(), stderr.String())
	}
}
