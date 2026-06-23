package llm

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRetryingProviderRetriesTransientErrorThenSucceeds(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`Internal error: API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}`)},
		scriptedProviderStep{resp: &Response{Content: "done"}},
	)
	var events []RetryEvent
	config := testRetryConfig(2)
	config.OnRetry = func(event RetryEvent) {
		events = append(events, event)
	}
	retrying := NewRetryingProvider(provider, config)

	resp, err := retrying.SendMessage(context.Background(), []Message{{Role: RoleUser, Content: "work"}}, nil)
	if err != nil {
		t.Fatalf("SendMessage() error = %v, want nil", err)
	}
	if resp == nil || resp.Content != "done" {
		t.Fatalf("response = %#v, want content done", resp)
	}
	if got := provider.CallCount(); got != 2 {
		t.Fatalf("call count = %d, want 2", got)
	}
	if len(events) != 1 {
		t.Fatalf("retry events = %d, want 1", len(events))
	}
	if events[0].FailedAttempt != 1 || events[0].RetryAttempt != 2 || events[0].TotalAttempts != 3 {
		t.Fatalf("retry event = %#v, want failed=1 retry=2 total=3", events[0])
	}
}

func TestRetryingProviderExhaustsTransientRetries(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`API Error: 502 bad gateway`)},
		scriptedProviderStep{err: errors.New(`API Error: 502 bad gateway`)},
		scriptedProviderStep{err: errors.New(`API Error: 502 bad gateway`)},
	)
	retrying := NewRetryingProvider(provider, testRetryConfig(2))

	_, err := retrying.SendMessage(context.Background(), nil, nil)
	if err == nil {
		t.Fatal("SendMessage() error = nil, want final transient error")
	}
	if !strings.Contains(err.Error(), "bad gateway") {
		t.Fatalf("error = %v, want final provider error", err)
	}
	if got := provider.CallCount(); got != 3 {
		t.Fatalf("call count = %d, want 3", got)
	}
}

func TestRetryingProviderUsesExponentialBackoffWithCap(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`API Error: 503 service unavailable`)},
		scriptedProviderStep{err: errors.New(`API Error: 503 service unavailable`)},
		scriptedProviderStep{err: errors.New(`API Error: 503 service unavailable`)},
		scriptedProviderStep{resp: &Response{Content: "done"}},
	)
	var delays []time.Duration
	config := testRetryConfig(3)
	config.InitialDelay = 10 * time.Millisecond
	config.MaxDelay = 25 * time.Millisecond
	config.Sleeper = func(ctx context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return immediateRetrySleeper(ctx, delay)
	}
	retrying := NewRetryingProvider(provider, config)

	resp, err := retrying.SendMessage(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("SendMessage() error = %v, want nil", err)
	}
	if resp == nil || resp.Content != "done" {
		t.Fatalf("response = %#v, want content done", resp)
	}
	want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 25 * time.Millisecond}
	if len(delays) != len(want) {
		t.Fatalf("delays = %v, want %v", delays, want)
	}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("delays = %v, want %v", delays, want)
		}
	}
}

func TestRetryingProviderDoesNotRetryNonRetryableError(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`Internal error: invalid tool call payload`)},
		scriptedProviderStep{resp: &Response{Content: "unexpected"}},
	)
	retrying := NewRetryingProvider(provider, testRetryConfig(2))

	_, err := retrying.SendMessage(context.Background(), nil, nil)
	if err == nil {
		t.Fatal("SendMessage() error = nil, want non-retryable error")
	}
	if got := provider.CallCount(); got != 1 {
		t.Fatalf("call count = %d, want 1", got)
	}
}

func TestRetryingProviderNegativeMaxRetriesDisablesRetries(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`API Error: 503 service unavailable`)},
		scriptedProviderStep{resp: &Response{Content: "unexpected"}},
	)
	retrying := NewRetryingProvider(provider, testRetryConfig(-1))

	_, err := retrying.SendMessage(context.Background(), nil, nil)
	if err == nil {
		t.Fatal("SendMessage() error = nil, want initial transient error")
	}
	if got := provider.CallCount(); got != 1 {
		t.Fatalf("call count = %d, want 1", got)
	}
}

func TestRetryingProviderStopsWhenContextCancelsDuringBackoff(t *testing.T) {
	t.Parallel()

	provider := newScriptedProvider(
		scriptedProviderStep{err: errors.New(`API Error: 503 service unavailable`)},
		scriptedProviderStep{resp: &Response{Content: "unexpected"}},
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	config := testRetryConfig(2)
	config.Sleeper = func(ctx context.Context, _ time.Duration) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}
	retrying := NewRetryingProvider(provider, config)

	_, err := retrying.SendMessage(ctx, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("SendMessage() error = %v, want context.Canceled", err)
	}
	if got := provider.CallCount(); got != 1 {
		t.Fatalf("call count = %d, want 1", got)
	}
}

func testRetryConfig(maxRetries int) RetryConfig {
	return RetryConfig{
		MaxRetries:   maxRetries,
		InitialDelay: time.Millisecond,
		MaxDelay:     time.Millisecond,
		Sleeper:      immediateRetrySleeper,
	}
}

func immediateRetrySleeper(ctx context.Context, _ time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

type scriptedProviderStep struct {
	resp *Response
	err  error
}

type scriptedProvider struct {
	mu    sync.Mutex
	steps []scriptedProviderStep
	calls int
}

func newScriptedProvider(steps ...scriptedProviderStep) *scriptedProvider {
	return &scriptedProvider{steps: steps}
}

func (p *scriptedProvider) SendMessage(_ context.Context, _ []Message, _ []ToolDefinition) (*Response, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	index := p.calls
	p.calls++
	if index >= len(p.steps) {
		return nil, errors.New("scripted provider exhausted")
	}
	step := p.steps[index]
	return step.resp, step.err
}

func (p *scriptedProvider) CallCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}
