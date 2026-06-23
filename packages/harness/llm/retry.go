package llm

import (
	"context"
	"errors"
	"strings"
	"time"
)

const (
	// DefaultRetryMaxRetries bounds transient provider retries after the initial attempt.
	DefaultRetryMaxRetries = 2
	// DefaultRetryInitialDelay is the first backoff before retrying a transient provider error.
	DefaultRetryInitialDelay = 15 * time.Second
	// DefaultRetryMaxDelay caps exponential backoff for transient provider retries.
	DefaultRetryMaxDelay = 2 * time.Minute
)

var transientProviderStatusCodes = []string{"529", "500", "502", "429", "503", "504"}

var transientProviderTextSignals = []string{
	"overloaded_error",
	"overloaded",
	"rate_limit_error",
	"rate limit",
	"rate-limit",
	"too many requests",
	"service unavailable",
	"bad gateway",
	"gateway timeout",
	"temporarily unavailable",
	"temporarily_unavailable",
	"temporary unavailable",
	"temporary_unavailable",
}

// RetryConfig controls retry behavior for transient LLM provider errors.
type RetryConfig struct {
	// MaxRetries bounds retries after the initial attempt. Zero uses the default; negative disables retries.
	MaxRetries int
	// InitialDelay is the first backoff before retrying. Zero uses the default.
	InitialDelay time.Duration
	// MaxDelay caps exponential backoff. Zero uses the default.
	MaxDelay time.Duration
	// Sleeper is injectable for tests. Nil uses a timer that honors context cancellation.
	Sleeper func(context.Context, time.Duration) error
	// ShouldRetry overrides transient provider error classification when set.
	ShouldRetry func(error) bool
	// OnRetry receives an event before each retry sleep.
	OnRetry func(RetryEvent)
}

// RetryEvent describes a scheduled provider retry.
type RetryEvent struct {
	FailedAttempt int
	RetryAttempt  int
	TotalAttempts int
	MaxRetries    int
	Delay         time.Duration
	Error         string
}

type retryingProvider struct {
	base   Provider
	config RetryConfig
}

// NewRetryingProvider wraps a Provider with bounded exponential backoff for transient provider errors.
func NewRetryingProvider(base Provider, config RetryConfig) Provider {
	return &retryingProvider{base: base, config: config}
}

func (p *retryingProvider) SendMessage(ctx context.Context, messages []Message, tools []ToolDefinition) (*Response, error) {
	if p.base == nil {
		return nil, errors.New("llm retrying provider: nil provider")
	}

	maxRetries, delay, maxDelay := normalizeRetryConfig(p.config)
	totalAttempts := maxRetries + 1
	var resp *Response
	var err error
	for attempt := 1; attempt <= totalAttempts; attempt++ {
		resp, err = p.base.SendMessage(ctx, messages, tools)
		if err == nil {
			return resp, nil
		}
		if !p.shouldRetry(ctx, err, attempt, totalAttempts) {
			return resp, err
		}

		if p.config.OnRetry != nil {
			p.config.OnRetry(RetryEvent{
				FailedAttempt: attempt,
				RetryAttempt:  attempt + 1,
				TotalAttempts: totalAttempts,
				MaxRetries:    maxRetries,
				Delay:         delay,
				Error:         err.Error(),
			})
		}
		if sleepErr := p.sleep(ctx, delay); sleepErr != nil {
			return resp, sleepErr
		}
		delay = nextRetryDelay(delay, maxDelay)
	}
	return resp, err
}

func (p *retryingProvider) shouldRetry(ctx context.Context, err error, attempt, totalAttempts int) bool {
	if attempt >= totalAttempts {
		return false
	}
	if err == nil || ctx.Err() != nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if p.config.ShouldRetry != nil {
		return p.config.ShouldRetry(err)
	}
	return IsTransientProviderError(err)
}

func (p *retryingProvider) sleep(ctx context.Context, delay time.Duration) error {
	if p.config.Sleeper != nil {
		return p.config.Sleeper(ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func normalizeRetryConfig(config RetryConfig) (maxRetries int, delay time.Duration, maxDelay time.Duration) {
	maxRetries = config.MaxRetries
	if maxRetries == 0 {
		maxRetries = DefaultRetryMaxRetries
	}
	if maxRetries < 0 {
		maxRetries = 0
	}
	delay = config.InitialDelay
	if delay <= 0 {
		delay = DefaultRetryInitialDelay
	}
	maxDelay = config.MaxDelay
	if maxDelay <= 0 {
		maxDelay = DefaultRetryMaxDelay
	}
	if maxDelay < delay {
		maxDelay = delay
	}
	return maxRetries, delay, maxDelay
}

func nextRetryDelay(current, maxDelay time.Duration) time.Duration {
	if current <= 0 {
		current = DefaultRetryInitialDelay
	}
	next := current * 2
	if next < current || next > maxDelay {
		return maxDelay
	}
	return next
}

// IsTransientProviderError classifies provider-side failures that are safe to retry.
func IsTransientProviderError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	msg := strings.ToLower(err.Error())
	if hasTransientProviderStatus(msg) {
		return true
	}
	for _, signal := range transientProviderTextSignals {
		if strings.Contains(msg, signal) {
			return true
		}
	}
	return false
}

func hasTransientProviderStatus(msg string) bool {
	for _, code := range transientProviderStatusCodes {
		if containsAnyStatusPattern(msg, code) {
			return true
		}
	}
	return false
}

func containsAnyStatusPattern(msg, code string) bool {
	return strings.Contains(msg, "api error: "+code) ||
		strings.Contains(msg, "http "+code) ||
		strings.Contains(msg, "status "+code) ||
		strings.Contains(msg, "status_code\":"+code) ||
		strings.Contains(msg, "statuscode\":"+code)
}
