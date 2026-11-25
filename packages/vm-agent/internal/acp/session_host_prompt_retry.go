package acp

import (
	"context"
	"log/slog"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// Prompt retry policy for transient provider errors, split from
// session_host_prompt.go (file size limit, .claude/rules/18).

func (h *SessionHost) shouldRetryPromptError(promptCtx context.Context, err error, attempt, totalAttempts int, accepted ...credentialAttribution) bool {
	if attempt >= totalAttempts {
		return false
	}
	if err == nil || promptCtx.Err() != nil {
		return false
	}
	if isCrashPromptError(err) {
		return false
	}
	if h.promptProviderLimit(err, accepted...) != nil {
		return false
	}
	// SAM's own AI usage limit is a 429 too, but no retry can succeed until the limit resets
	// or an administrator changes it (sam_usage_limit.go).
	if ClassifyPromptError(err) == samUsageLimitReason {
		return false
	}
	return isTransientProviderPromptError(err)
}

func (h *SessionHost) sleepBeforePromptRetry(ctx context.Context, delay time.Duration) error {
	if h.config.PromptRetrySleeper != nil {
		return h.config.PromptRetrySleeper(ctx, delay)
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

func (h *SessionHost) reportPromptRetry(
	sessionID acpsdk.SessionId,
	attempt, totalAttempts int,
	delay time.Duration,
	startedAt time.Time,
	err error,
) {
	errText := redactAgentDiagnosticText(err.Error())
	retryAttempt := attempt + 1
	maxRetries := totalAttempts - 1
	detail := map[string]interface{}{
		"acpSessionId":  string(sessionID),
		"failedAttempt": attempt,
		"retryAttempt":  retryAttempt,
		"totalAttempts": totalAttempts,
		"maxRetries":    maxRetries,
		"delay":         delay.String(),
		"duration":      time.Since(startedAt).String(),
		"error":         errText,
	}
	slog.Warn("ACP Prompt transient provider error; retrying",
		"attempt", attempt,
		"retryAttempt", retryAttempt,
		"totalAttempts", totalAttempts,
		"delay", delay,
		"error", errText,
	)
	h.reportLifecycle("warn", "ACP Prompt transient provider error; retrying", detail)
	h.reportEvent("warn", "agent_session.prompt_retry", "Retrying ACP prompt after transient provider error", detail)
}

func nextPromptRetryDelay(current, maxDelay time.Duration) time.Duration {
	if current <= 0 {
		current = DefaultPromptRetryInitialDelay
	}
	next := current * 2
	if next < current || next > maxDelay {
		return maxDelay
	}
	return next
}
