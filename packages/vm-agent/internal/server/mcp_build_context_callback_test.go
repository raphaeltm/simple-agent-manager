package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type contextCallbackTransport func(*http.Request) (*http.Response, error)

func (f contextCallbackTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestContextCallbackRetriesTransientFailures(t *testing.T) {
	for _, operation := range []string{"init", "complete"} {
		for _, first := range []int{0, 502, 503, 504, 200} {
			if operation == "complete" && first == 200 {
				continue
			}
			t.Run(operation+fmt.Sprint(first), func(t *testing.T) {
				s, _ := mcpBuildTestServer(t)
				s.config.ControlPlaneURL = "https://control.invalid"
				s.config.BuildContextCallbackMaxAttempts = 3
				s.config.BuildContextCallbackRetryDelay = time.Millisecond
				s.config.HTTPCallbackTimeout = time.Second
				s.config.DeployBuildPublishTimeout = time.Second
				calls := 0
				s.httpClient = &http.Client{Timeout: time.Second, Transport: contextCallbackTransport(func(r *http.Request) (*http.Response, error) {
					calls++
					data, _ := io.ReadAll(r.Body)
					if string(data) != "{\"attempt\":1}" {
						t.Errorf("request data changed: %s", data)
					}
					if calls == 1 && first == 0 {
						return nil, fmt.Errorf("lost response")
					}
					status := 200
					body := "{\"uploadUrl\":\"https://upload.invalid\"}"
					if calls == 1 {
						status = first
						if first == 200 {
							body = "{\"uploadUrl\":"
						}
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
				var slot struct {
					UploadURL string `json:"uploadUrl"`
				}
				var out any = &slot
				if operation == "complete" {
					out = nil
				}
				err := s.contextCallback(context.Background(), "ws-001", "/"+operation, map[string]int{"attempt": 1}, out)
				if err != nil || calls != 2 || (operation == "init" && slot.UploadURL == "") {
					t.Fatalf("err=%v calls=%d slot=%+v", err, calls, slot)
				}
			})
		}
	}
}
func TestContextCallbackStopsAtPermanentOrExhaustedFailure(t *testing.T) {
	for _, status := range []int{400, 401, 403, 409, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, _ := mcpBuildTestServer(t)
			s.config.ControlPlaneURL = "https://control.invalid"
			s.config.BuildContextCallbackMaxAttempts = 3
			s.config.BuildContextCallbackRetryDelay = time.Millisecond
			s.config.HTTPCallbackTimeout = time.Second
			s.config.DeployBuildPublishTimeout = time.Second
			calls := 0
			s.httpClient = &http.Client{Timeout: time.Second, Transport: contextCallbackTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("private body must not be logged"))}, nil
			})}
			err := s.contextCallback(context.Background(), "ws-001", "/complete", nil, nil)
			want := 1
			if status == 503 {
				want = 3
			}
			if err == nil || calls != want || strings.Contains(err.Error(), "private body") {
				t.Fatalf("err=%v calls=%d want=%d", err, calls, want)
			}
		})
	}
}
func TestContextCallbackCancellationInterruptsBackoff(t *testing.T) {
	s, _ := mcpBuildTestServer(t)
	s.config.ControlPlaneURL = "https://control.invalid"
	s.config.BuildContextCallbackMaxAttempts = 3
	s.config.BuildContextCallbackRetryDelay = time.Hour
	s.config.HTTPCallbackTimeout = time.Second
	s.config.DeployBuildPublishTimeout = time.Second
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	s.httpClient = &http.Client{Timeout: time.Second, Transport: contextCallbackTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		cancel()
		return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	started := time.Now()
	err := s.contextCallback(ctx, "ws-001", "/complete", nil, nil)
	if err == nil || calls != 1 || time.Since(started) > time.Second {
		t.Fatalf("err=%v calls=%d cancellation slow", err, calls)
	}
}

func TestContextCallbackBoundsEachAttempt(t *testing.T) {
	s, _ := mcpBuildTestServer(t)
	s.config.ControlPlaneURL = "https://control.invalid"
	s.config.BuildContextCallbackMaxAttempts = 2
	s.config.BuildContextCallbackRetryDelay = time.Millisecond
	s.config.HTTPCallbackTimeout = 20 * time.Millisecond
	calls := 0
	s.httpClient = &http.Client{Timeout: s.config.HTTPCallbackTimeout, Transport: contextCallbackTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > s.config.HTTPCallbackTimeout {
			t.Error("attempt lacks callback deadline")
		}
		if calls == 1 {
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.contextCallback(ctx, "ws-001", "/complete", nil, nil); err != nil || calls != 2 {
		t.Fatalf("err=%v attempts=%d", err, calls)
	}
}
