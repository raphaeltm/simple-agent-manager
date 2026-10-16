package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func retryTestServer(endpoint string) *Server {
	return &Server{config: &config.Config{ControlPlaneURL: endpoint, WorkspaceID: "ws-retry", CallbackToken: "private-callback", GitTokenTimeout: time.Second, GitTokenAttemptTimeout: 200 * time.Millisecond, GitTokenMaxAttempts: 3, GitTokenRetryDelay: time.Millisecond}}
}
func TestProvisioningGitTokenRetries(t *testing.T) {
	original := prepareWorkspaceForRuntime
	defer func() { prepareWorkspaceForRuntime = original }()
	for _, tc := range []struct {
		name                         string
		status, failCount, wantCalls int
		wantPrepare                  bool
	}{
		{"transient", 503, 1, 2, true}, {"exhausted", 502, 9, 3, false}, {"unauthorized", 401, 9, 1, false}, {"revoked", 403, 9, 1, false}, {"not_found", 404, 9, 1, false}, {"rate_limited", 429, 1, 2, true}, {"timeout", 408, 1, 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/git-token") {
					if int(calls.Add(1)) <= tc.failCount {
						w.WriteHeader(tc.status)
						fmt.Fprint(w, "private-remote-body")
						return
					}
					fmt.Fprint(w, `{"token":"private-git-token"}`)
					return
				}
				fmt.Fprint(w, `{"envVars":[],"files":[]}`)
			}))
			defer upstream.Close()
			prepared := false
			prepareWorkspaceForRuntime = func(_ context.Context, _ *config.Config, state bootstrap.ProvisionState, _ *bootlog.Reporter) (bool, error) {
				prepared = true
				if state.GitHubToken != "private-git-token" {
					t.Error("token not forwarded")
				}
				return false, errors.New("bootstrap boundary")
			}
			s := retryTestServer(upstream.URL)
			_, err := s.provisionWorkspaceRuntime(context.Background(), &WorkspaceRuntime{ID: "ws-retry", Repository: "acme/private", CallbackToken: "private-callback"})
			if err == nil {
				t.Fatal("expected boundary/fetch error")
			}
			if prepared != tc.wantPrepare || int(calls.Load()) != tc.wantCalls {
				t.Fatalf("prepared=%v calls=%d", prepared, calls.Load())
			}
			for _, secret := range []string{"private-remote-body", "private-callback", "private-git-token"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("secret leaked: %s", secret)
				}
			}
		})
	}
}
func TestGitCredentialHelperScriptRetriesSlowResponse(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		time.Sleep(5100 * time.Millisecond)
		fmt.Fprint(w, `{"token":"helper-result"}`)
	}))
	defer upstream.Close()
	s := retryTestServer(upstream.URL)
	s.config.GitTokenAttemptTimeout = 6 * time.Second
	s.config.GitTokenTimeout = 10 * time.Second
	local := httptest.NewServer(http.HandlerFunc(s.handleGitCredential))
	defer local.Close()
	script, err := renderStandaloneGitCredentialHelperScript(config.DefaultGitCredentialTimeout)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", script)
	cmd.Env = append(cmd.Environ(), "SAM_WORKSPACE_ID=ws-retry", "SAM_GIT_CREDENTIAL_ENDPOINT="+local.URL)
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "password=helper-result") || calls.Load() != 2 {
		t.Fatalf("helper: calls=%d err=%v output=%s", calls.Load(), err, output)
	}
}
func TestGitTokenCancellationAndTotalBudget(t *testing.T) {
	for _, early := range []bool{true, false} {
		t.Run(fmt.Sprint(early), func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				<-r.Context().Done()
			}))
			defer upstream.Close()
			s := retryTestServer(upstream.URL)
			s.config.GitTokenTimeout = 50 * time.Millisecond
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if early {
				cancel()
			}
			start := time.Now()
			_, err := s.fetchGitTokenForWorkspace(ctx, "ws-retry", "")
			want := context.DeadlineExceeded
			if early {
				want = context.Canceled
			}
			if !errors.Is(err, want) || time.Since(start) > 500*time.Millisecond {
				t.Fatalf("cancellation/budget: %v", err)
			}
			if early && calls.Load() != 0 {
				t.Fatal("called upstream after cancellation")
			}
		})
	}
}

func TestGitTokenAttemptTimeoutRecovery(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			_, _ = io.Copy(io.Discard, r.Body)
			<-r.Context().Done()
			return
		}
		fmt.Fprint(w, `{"token":"recovered"}`)
	}))
	defer upstream.Close()
	s := retryTestServer(upstream.URL)
	s.config.GitTokenAttemptTimeout = 20 * time.Millisecond
	token, err := s.fetchGitToken(context.Background())
	if err != nil || token != "recovered" || calls.Load() != 2 {
		t.Fatalf("token=%q calls=%d err=%v", token, calls.Load(), err)
	}
}
func TestGitTokenCancelDuringBackoff(t *testing.T) {
	attempted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); close(attempted) }))
	defer upstream.Close()
	s := retryTestServer(upstream.URL)
	s.config.GitTokenRetryDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.fetchGitToken(ctx); done <- err }()
	<-attempted
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("backoff ignored cancellation")
	}
}
func TestGitTokenRedirectAndInvalidPayloadFailFast(t *testing.T) {
	for _, body := range []string{"redirect", "{}", "broken"} {
		t.Run(body, func(t *testing.T) {
			var sourceCalls, destinationCalls atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				destinationCalls.Add(1)
				fmt.Fprint(w, `{"token":"should-never-arrive"}`)
			}))
			defer destination.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sourceCalls.Add(1)
				if body == "redirect" {
					w.Header().Set("Location", destination.URL)
					w.WriteHeader(307)
					return
				}
				fmt.Fprint(w, body)
			}))
			defer upstream.Close()
			s := retryTestServer(upstream.URL)
			_, err := s.fetchGitToken(context.Background())
			if err == nil || sourceCalls.Load() != 1 || destinationCalls.Load() != 0 {
				t.Fatalf("source=%d destination=%d err=%v", sourceCalls.Load(), destinationCalls.Load(), err)
			}
		})
	}
}

type gitTokenTestTransport func(*http.Request) (*http.Response, error)

func (f gitTokenTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestGitTokenTransportRetryAndLogRedaction(t *testing.T) {
	var logs bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(original)
	s := retryTestServer("https://api.example.com/private-url-secret")
	calls := 0
	s.httpClient = &http.Client{Transport: gitTokenTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return nil, fmt.Errorf("private-transport-secret %s %s", r.URL, r.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("private-body-secret")), Header: make(http.Header)}, nil
	})}
	_, err := s.fetchGitToken(context.Background())
	if err == nil || calls != 3 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	output := logs.String() + err.Error()
	for _, secret := range []string{"private-url-secret", "private-transport-secret", "private-callback", "private-body-secret"} {
		if strings.Contains(output, secret) {
			t.Fatalf("secret leaked: %s", secret)
		}
	}
	if !strings.Contains(output, "category=transport") || !strings.Contains(output, "category=upstream_unavailable") {
		t.Fatalf("missing actionable categories: %s", output)
	}
}
func TestStandaloneHelperDefaultBudget(t *testing.T) {
	script, err := renderStandaloneGitCredentialHelperScript(config.DefaultGitCredentialTimeout)
	if err != nil || !strings.Contains(script, "--max-time 30") || config.DefaultGitCredentialTimeout <= config.DefaultGitTokenTimeout {
		t.Fatalf("helper budget: %v", err)
	}
}

func TestGeneratedHelperFailurePaths(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		cancel    bool
		wantCalls int
	}{
		{"exhaustion", 503, false, 3}, {"auth", 401, false, 1}, {"revocation", 403, false, 1}, {"cancelled_helper", 0, true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			cancelled := make(chan struct{}, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if tc.cancel {
					_, _ = io.Copy(io.Discard, r.Body)
					<-r.Context().Done()
					cancelled <- struct{}{}
					return
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, "private-remote-body")
			}))
			defer upstream.Close()
			s := retryTestServer(upstream.URL)
			local := httptest.NewServer(http.HandlerFunc(s.handleGitCredential))
			defer local.Close()
			helperTimeout := time.Second
			if tc.cancel {
				helperTimeout = 50 * time.Millisecond
			}
			script, err := renderStandaloneGitCredentialHelperScript(helperTimeout)
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("sh", "-c", script)
			cmd.Env = append(cmd.Environ(), "SAM_WORKSPACE_ID=ws-retry", "SAM_GIT_CREDENTIAL_ENDPOINT="+local.URL)
			cmd.Stdin = strings.NewReader("host=github.com\n\n")
			output, err := cmd.CombinedOutput()
			if err != nil || len(output) != 0 {
				t.Fatalf("failure helper emitted credentials/details: %s err=%v", output, err)
			}
			if tc.cancel {
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("helper cancellation did not reach upstream")
				}
			}
			if int(calls.Load()) != tc.wantCalls {
				t.Fatalf("calls=%d", calls.Load())
			}
		})
	}
}

type interruptedGitTokenBody struct{}

func (interruptedGitTokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (interruptedGitTokenBody) Close() error             { return nil }
func TestGitTokenInterruptedBodyRecoveryAndAuthFailFast(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s := retryTestServer("https://api.example.com")
			calls := 0
			s.httpClient = &http.Client{Transport: gitTokenTestTransport(func(_ *http.Request) (*http.Response, error) {
				calls++
				body := io.ReadCloser(interruptedGitTokenBody{})
				if calls > 1 {
					body = io.NopCloser(strings.NewReader(`{"token":"recovered"}`))
				}
				return &http.Response{StatusCode: status, Body: body, Header: make(http.Header)}, nil
			})}
			token, err := s.fetchGitToken(context.Background())
			if status == http.StatusOK {
				if err != nil || token != "recovered" || calls != 2 {
					t.Fatalf("interruption recovery: calls=%d err=%v", calls, err)
				}
			} else if err == nil || calls != 1 {
				t.Fatalf("auth must fail fast even with a broken body: calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestProvisioningGitTokenCancellation(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/git-token") {
			t.Error("provisioning advanced beyond cancelled credential exchange")
			return
		}
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer upstream.Close()
	s := retryTestServer(upstream.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := s.provisionWorkspaceRuntime(ctx, &WorkspaceRuntime{ID: "ws-retry", Repository: "acme/private", CallbackToken: "private-callback"})
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("provisioning did not preserve cancellation: calls=%d err=%v", calls.Load(), err)
	}
}
