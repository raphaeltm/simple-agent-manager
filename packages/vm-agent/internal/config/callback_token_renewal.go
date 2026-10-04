package config

import (
	"math"
	"time"
)

// Workspace callback token renewal defaults. Workspace-scoped callback tokens are
// minted by the control plane with a fixed lifetime (CALLBACK_TOKEN_EXPIRY_MS,
// default 24h); the agent renews each one through
// POST /api/workspaces/:id/callback-token/renew once it has used up
// WorkspaceCallbackTokenRefreshRatio of that lifetime.
const (
	// DefaultWorkspaceCallbackTokenRefreshRatio renews halfway through a token's
	// lifetime, matching the control plane's CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO
	// default, so a renewal outage has the second half of the lifetime to recover.
	// Override via WORKSPACE_CALLBACK_TOKEN_REFRESH_RATIO.
	DefaultWorkspaceCallbackTokenRefreshRatio = 0.5
	// MinWorkspaceCallbackTokenRefreshRatio and MaxWorkspaceCallbackTokenRefreshRatio
	// bound the ratio the same way the control plane clamps its own.
	MinWorkspaceCallbackTokenRefreshRatio = 0.1
	MaxWorkspaceCallbackTokenRefreshRatio = 0.9

	// DefaultWorkspaceCallbackTokenRenewalTimeout bounds one renewal request.
	// Override via WORKSPACE_CALLBACK_TOKEN_RENEWAL_TIMEOUT.
	DefaultWorkspaceCallbackTokenRenewalTimeout = 15 * time.Second
	// DefaultWorkspaceCallbackTokenRenewalRetryInitial is the first backoff after a
	// transient renewal failure. Override via WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_INITIAL.
	DefaultWorkspaceCallbackTokenRenewalRetryInitial = time.Minute
	// DefaultWorkspaceCallbackTokenRenewalRetryMax caps the backoff, and is also the
	// wait before asking again when the control plane says a token is not yet due.
	// Override via WORKSPACE_CALLBACK_TOKEN_RENEWAL_RETRY_MAX.
	DefaultWorkspaceCallbackTokenRenewalRetryMax = 30 * time.Minute
)

// clampWorkspaceCallbackTokenRefreshRatio handles a configured ratio exactly as
// the control plane handles CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO
// (shouldRefreshCallbackToken in apps/api/src/services/jwt.ts): a non-finite value
// means the default, and every finite value is clamped to the supported range.
func clampWorkspaceCallbackTokenRefreshRatio(ratio float64) float64 {
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) {
		return DefaultWorkspaceCallbackTokenRefreshRatio
	}
	return math.Max(MinWorkspaceCallbackTokenRefreshRatio, math.Min(MaxWorkspaceCallbackTokenRefreshRatio, ratio))
}

// positiveDurationOr returns value when positive, else fallback.
func positiveDurationOr(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
