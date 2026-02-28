package callbackretry

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDoSucceedsOnFirstAttempt(t *testing.T) {
	t.Parallel()

	var attempts int32
	err := Do(context.Background(), DefaultConfig(), "test-op", func(_ context.Context) error {
		atomic.AddInt32(&attempts, 1)
		return nil
	})

	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if atomic.LoadInt32(&attempts) != 1 {
		t.Fatalf("expected 1 attempt, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestDoRetriesOnTransientError(t *testing.T) {
	t.Parallel()

	var attempts int32
	cfg := Config{
		InitialDelay: 10 * time.Millisecond,
		MaxDelay:     50 * time.Millisecond,
		MaxElapsed:   5 * time.Second,
		MaxAttempts:  5,
	}

	err := Do(context.Background(), cfg, "test-retry", func(_ context.Context) error {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			return errors.New("transient error")
		}
		return nil // succeed on 3rd attempt
	})

	if err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("expected 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestDoExhaustsMaxAttempts(t *testing.T) {
	t.Parallel()

	var attempts int32
	cfg := Config{
		InitialDelay: 5 * time.Millisecond,
		MaxDelay:     10 * time.Millisecond,
		MaxElapsed:   10 * time.Second,
		MaxAttempts:  3,
	}

	err := Do(context.Background(), cfg, "test-exhaust", func(_ context.Context) error {
		atomic.AddInt32(&attempts, 1)
		return errors.New("persistent failure")
	})

	if err == nil {
		t.Fatal("expected error when retries exhausted")
	}
	if !strings.Contains(err.Error(), "retries exhausted") {
		t.Fatalf("expected 'retries exhausted' in error, got %v", err)
	}
	if !strings.Contains(err.Error(), "3 attempts") {
		t.Fatalf("expected '3 attempts' in error, got %v", err)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("expected 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestDoRespectsContextCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	var attempts int32
	cfg := Config{
		InitialDelay: 100 * time.Millisecond,
		MaxDelay:     200 * time.Millisecond,
		MaxElapsed:   10 * time.Second,
		MaxAttempts:  10,
	}

	// Cancel after first attempt
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	err := Do(ctx, cfg, "test-cancel", func(_ context.Context) error {
		atomic.AddInt32(&attempts, 1)
		return errors.New("always fail")
	})

	if err == nil {
		t.Fatal("expected error on context cancellation")
	}
	if !strings.Contains(err.Error(), "context cancelled") {
		t.Fatalf("expected 'context cancelled' in error, got %v", err)
	}
}

func TestDoExhaustsMaxElapsed(t *testing.T) {
	t.Parallel()

	cfg := Config{
		InitialDelay: 5 * time.Millisecond,
		MaxDelay:     10 * time.Millisecond,
		MaxElapsed:   30 * time.Millisecond,
		MaxAttempts:  0, // unlimited attempts
	}

	start := time.Now()
	err := Do(context.Background(), cfg, "test-elapsed", func(_ context.Context) error {
		return errors.New("keep failing")
	})

	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected error when max elapsed reached")
	}
	if !strings.Contains(err.Error(), "retries exhausted") {
		t.Fatalf("expected 'retries exhausted' in error, got %v", err)
	}
	// Should have stopped within reasonable bounds
	if elapsed > 5*time.Second {
		t.Fatalf("retry took too long: %v", elapsed)
	}
}

func TestDoWrapsOriginalError(t *testing.T) {
	t.Parallel()

	originalErr := errors.New("the original problem")
	cfg := Config{
		InitialDelay: 5 * time.Millisecond,
		MaxDelay:     10 * time.Millisecond,
		MaxElapsed:   10 * time.Second,
		MaxAttempts:  1,
	}

	err := Do(context.Background(), cfg, "test-wrap", func(_ context.Context) error {
		return originalErr
	})

	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, originalErr) {
		t.Fatalf("expected wrapped error to contain original error, got %v", err)
	}
}

func TestDoAppliesDefaultsForZeroConfig(t *testing.T) {
	t.Parallel()

	var attempts int32
	cfg := Config{} // all zero values

	err := Do(context.Background(), cfg, "test-defaults", func(_ context.Context) error {
		n := atomic.AddInt32(&attempts, 1)
		if n < 2 {
			return errors.New("fail once")
		}
		return nil
	})

	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if atomic.LoadInt32(&attempts) != 2 {
		t.Fatalf("expected 2 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestDoIncludesOperationNameInError(t *testing.T) {
	t.Parallel()

	cfg := Config{
		InitialDelay: 5 * time.Millisecond,
		MaxDelay:     10 * time.Millisecond,
		MaxElapsed:   10 * time.Second,
		MaxAttempts:  1,
	}

	err := Do(context.Background(), cfg, "my-special-operation", func(_ context.Context) error {
		return errors.New("fail")
	})

	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "my-special-operation") {
		t.Fatalf("expected operation name in error, got %v", err)
	}
}
