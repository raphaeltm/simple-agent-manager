package server

import (
	"strings"
	"testing"
)

func TestRedactTaskCallbackDiagnosticTextRedactsBareProviderKeys(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct{ name, key string }{
		{"OpenAI-style key", "sk-" + "secret1234567890"},
		// OpenCode keys moved from sk- to oc_sk_ in October 2026; no key= prefix
		// here, so only the shape pattern can catch it.
		{"OpenCode key", "oc_" + "sk_" + "Z7mQ2xLp9Rk4Tn8Vb3Wc6Hd1Jf5Gs0Ya2Ue7Io4Pr9Ql1Mz"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := redactTaskCallbackDiagnosticText("upstream echoed " + tc.key + " in its error")
			if strings.Contains(got, tc.key) {
				t.Fatalf("redacted text leaked the key: %q", got)
			}
			if got != "upstream echoed [REDACTED] in its error" {
				t.Fatalf("redacted text = %q", got)
			}
		})
	}
}
