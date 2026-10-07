package config

// DefaultOpenCodeGoUsageURL is the official OpenCode Go usage endpoint. The VM
// agent calls it with the session's OPENCODE_API_KEY after each completed turn
// of an OpenCode session that uses the opencode-go provider, and reports the
// rolling/weekly/monthly windows through the ACP usage callback. Override via
// OPENCODE_GO_USAGE_URL (self-hosters with a proxy or a test double).
//
// OpenCode Zen (pay-per-request credits) has no key-authenticated balance API,
// so Zen sessions are never probed.
const DefaultOpenCodeGoUsageURL = "https://opencode.ai/zen/go/v1/usage"
