// Package diagredact strips credentials from agent, git and provider diagnostic
// text before it is logged or sent to the control plane. It replaces only the
// matched span, so the surrounding text stays readable.
//
// errorreport keeps its own whole-value redactor (sensitiveValuePatterns). The
// shared canary fixture tests/fixtures/diagnostic-secret-canaries.json holds
// both, and the API's credential-token-redaction.ts, to the same token shapes.
package diagredact

import (
	"regexp"
	"strings"
)

// tokenPrefix requires the start of the text or a non-alphanumeric byte before
// a prefix-identified token. RE2 has no lookbehind, and \b is no substitute:
// "_" is a word character, so \b misses KEY_sk-…. The captured byte is kept.
const tokenPrefix = `(^|[^A-Za-z0-9])`

func token(shape string) *regexp.Regexp {
	return regexp.MustCompile(tokenPrefix + `(` + shape + `)`)
}

var patterns = []*regexp.Regexp{
	// Before the keyword rule below, which would redact only the scheme word and
	// leave a Basic credential behind it.
	regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*["']?(?:basic|bearer)\s+)[A-Za-z0-9._~+/=-]+`),
	regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{16,}`),
	regexp.MustCompile(`(?i)((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)`),
	regexp.MustCompile(`(?i)(https?://)([^/\s@]+)@`),
	regexp.MustCompile(`(?i)([?&](?:access[_-]?token|api[_-]?key|token|secret|password|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token)=)([^&\s]+)`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`),
	// OpenAI/Anthropic/OpenRouter keys, and OpenCode keys since October 2026.
	token(`sk-[A-Za-z0-9_-]{8,}`),
	token(`oc_sk_[A-Za-z0-9_-]{8,}`),
	token(`(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`),
	token(`gh[pousr]_[A-Za-z0-9_]{8,}`),
	token(`github_pat_[A-Za-z0-9_]{8,}`),
	token(`sam_(?:pat|wh|test)_[A-Za-z0-9_-]{8,}`),
	token(`(?:AKIA|ASIA)[A-Z0-9]{16}`),
	token(`AIza[0-9A-Za-z_-]{20,}`),
	token(`ya29\.[0-9A-Za-z_-]{20,}`),
	token(`xox[baprs]-[A-Za-z0-9-]{10,}`),
	token(`npm_[A-Za-z0-9]{20,}`),
	token(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
}

// Text returns text with every recognised credential replaced by [REDACTED].
// A pattern's leading capture group, when it has two, is a prefix that stays.
func Text(text string) string {
	redacted := text
	for _, pattern := range patterns {
		redacted = pattern.ReplaceAllStringFunc(redacted, func(match string) string {
			submatches := pattern.FindStringSubmatch(match)
			if len(submatches) >= 3 {
				return submatches[1] + "[REDACTED]"
			}
			if len(submatches) >= 2 && strings.HasSuffix(strings.ToLower(submatches[1]), " ") {
				return submatches[1] + "[REDACTED]"
			}
			return "[REDACTED]"
		})
	}
	return redacted
}
