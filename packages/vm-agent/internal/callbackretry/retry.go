// Package callbackretry provides exponential backoff retry logic for VM agent
// callbacks to the control plane.
package callbackretry

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"time"
)

// Config configures the retry behavior.
type Config struct {
	// InitialDelay is the base delay before the first retry.
	InitialDelay time.Duration
	// MaxDelay caps the exponential backoff.
	MaxDelay time.Duration
	// MaxElapsed is the total time after which retries stop.
	MaxElapsed time.Duration
	// MaxAttempts limits total attempts (0 = unlimited, use MaxElapsed).
	MaxAttempts int
}

// DefaultConfig returns sensible defaults for control plane callbacks.
func DefaultConfig() Config {
	return Config{
		InitialDelay: 1 * time.Second,
		MaxDelay:     30 * time.Second,
		MaxElapsed:   2 * time.Minute,
		MaxAttempts:  5,
	}
}

// Do executes fn with exponential backoff and jitter.
// It retries on any non-nil error. The caller can wrap fn to skip retries
// on permanent errors by returning nil.
//
// Returns the last error if all retries are exhausted.
func Do(ctx context.Context, cfg Config, operationName string, fn func(ctx context.Context) error) error {
	if cfg.InitialDelay <= 0 {
		cfg.InitialDelay = DefaultConfig().InitialDelay
	}
	if cfg.MaxDelay <= 0 {
		cfg.MaxDelay = DefaultConfig().MaxDelay
	}
	if cfg.MaxElapsed <= 0 {
		cfg.MaxElapsed = DefaultConfig().MaxElapsed
	}

	start := time.Now()
	delay := cfg.InitialDelay
	var lastErr error

	for attempt := 1; ; attempt++ {
		err := fn(ctx)
		if err == nil {
			if attempt > 1 {
				slog.Info("Callback succeeded after retry",
					"operation", operationName,
					"attempt", attempt,
					"elapsed", time.Since(start).Round(time.Millisecond),
				)
			}
			return nil
		}

		lastErr = err

		// Check max attempts
		if cfg.MaxAttempts > 0 && attempt >= cfg.MaxAttempts {
			slog.Warn("Callback retries exhausted (max attempts)",
				"operation", operationName,
				"attempts", attempt,
				"elapsed", time.Since(start).Round(time.Millisecond),
				"lastError", err,
			)
			return fmt.Errorf("%s: retries exhausted after %d attempts: %w", operationName, attempt, lastErr)
		}

		// Check max elapsed
		if time.Since(start) >= cfg.MaxElapsed {
			slog.Warn("Callback retries exhausted (max elapsed)",
				"operation", operationName,
				"attempts", attempt,
				"elapsed", time.Since(start).Round(time.Millisecond),
				"lastError", err,
			)
			return fmt.Errorf("%s: retries exhausted after %v: %w", operationName, time.Since(start).Round(time.Millisecond), lastErr)
		}

		// Compute jittered delay
		jitter := time.Duration(rand.Int63n(int64(delay) / 2))
		sleepDur := delay + jitter

		slog.Info("Callback failed, retrying",
			"operation", operationName,
			"attempt", attempt,
			"delay", sleepDur.Round(time.Millisecond),
			"error", err,
		)

		// Sleep with context cancellation support
		timer := time.NewTimer(sleepDur)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("%s: context cancelled during retry: %w", operationName, ctx.Err())
		case <-timer.C:
		}

		// Exponential increase capped at MaxDelay
		delay = time.Duration(math.Min(float64(delay*2), float64(cfg.MaxDelay)))
	}
}
