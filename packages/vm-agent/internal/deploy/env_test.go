package deploy

import (
	"errors"
	"sort"
	"strings"
	"testing"
)

// envToMap parses a "KEY=VALUE" slice back into a map so order-independent
// assertions can be made about merged environments.
func envToMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	out := make(map[string]string, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			t.Fatalf("malformed env entry %q (no '=')", item)
		}
		if _, dup := out[key]; dup {
			t.Fatalf("duplicate key %q in merged env %v", key, env)
		}
		out[key] = value
	}
	return out
}

func TestMergeEnv_NoOverridesReturnsBaseUnchanged(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/root"}
	got := mergeEnv(base, nil)
	// The function returns the base slice directly when there are no overrides.
	if len(got) != len(base) {
		t.Fatalf("expected base returned unchanged, got %v", got)
	}
	got = mergeEnv(base, map[string]string{})
	if len(got) != len(base) {
		t.Fatalf("expected base returned unchanged for empty map, got %v", got)
	}
}

func TestMergeEnv_OverridesExistingKeyInPlace(t *testing.T) {
	base := []string{"PATH=/usr/bin", "DATABASE_URL=postgres://old", "HOME=/root"}
	overrides := map[string]string{"DATABASE_URL": "postgres://new"}

	merged := envToMap(t, mergeEnv(base, overrides))

	if merged["DATABASE_URL"] != "postgres://new" {
		t.Fatalf("expected override to replace existing value, got %q", merged["DATABASE_URL"])
	}
	// Untouched base entries survive.
	if merged["PATH"] != "/usr/bin" || merged["HOME"] != "/root" {
		t.Fatalf("base entries were not preserved: %v", merged)
	}
}

func TestMergeEnv_AppendsNewKeys(t *testing.T) {
	base := []string{"PATH=/usr/bin"}
	overrides := map[string]string{"STRIPE_KEY": "sk_live_xyz", "PUBLIC_DOMAIN": "app.example.com"}

	merged := envToMap(t, mergeEnv(base, overrides))

	if merged["STRIPE_KEY"] != "sk_live_xyz" {
		t.Fatalf("new override key missing/wrong: %v", merged)
	}
	if merged["PUBLIC_DOMAIN"] != "app.example.com" {
		t.Fatalf("new override key missing/wrong: %v", merged)
	}
	if merged["PATH"] != "/usr/bin" {
		t.Fatalf("base entry lost when appending: %v", merged)
	}
}

func TestMergeEnv_NoDuplicateRowsWhenOverridingAndAppending(t *testing.T) {
	// A base entry with no '=' (rare but possible in os.Environ) must not crash
	// and an overridden key must appear exactly once.
	base := []string{"DATABASE_URL=old", "WEIRD_NO_EQUALS", "KEEP=1"}
	overrides := map[string]string{"DATABASE_URL": "new", "EXTRA": "2"}

	got := mergeEnv(base, overrides)

	// Count DATABASE_URL occurrences — must be exactly one (override in place).
	count := 0
	for _, item := range got {
		if strings.HasPrefix(item, "DATABASE_URL=") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected DATABASE_URL exactly once, got %d in %v", count, got)
	}
	// The malformed base entry is preserved verbatim (no '=' to cut on).
	foundWeird := false
	for _, item := range got {
		if item == "WEIRD_NO_EQUALS" {
			foundWeird = true
		}
	}
	if !foundWeird {
		t.Fatalf("malformed base entry was dropped: %v", got)
	}
}

func TestEnvRedactor_RedactsSecretValues(t *testing.T) {
	redactor := newEnvRedactor(map[string]string{
		"DATABASE_URL": "postgres://user:topsecretvalue@db/app",
		"STRIPE_KEY":   "sk_live_anotherbigsecret",
	})

	in := "connecting with postgres://user:topsecretvalue@db/app and sk_live_anotherbigsecret"
	out := redactor.redact(in)

	if strings.Contains(out, "topsecretvalue") {
		t.Fatalf("secret value leaked through redaction: %q", out)
	}
	if strings.Contains(out, "anotherbigsecret") {
		t.Fatalf("secret value leaked through redaction: %q", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] marker in output: %q", out)
	}
}

func TestEnvRedactor_DoesNotRedactShortValues(t *testing.T) {
	// Values shorter than 6 bytes are intentionally NOT collected for redaction
	// to avoid mangling unrelated text. This documents that boundary contract.
	redactor := newEnvRedactor(map[string]string{
		"SHORT":  "abc",    // 3 bytes — not redacted
		"EXACT5": "12345",  // 5 bytes — not redacted (len >= 6 required)
		"SIX":    "abcdef", // 6 bytes — redacted
	})

	if got := redactor.redact("value abc here"); got != "value abc here" {
		t.Fatalf("expected 3-byte value left intact, got %q", got)
	}
	if got := redactor.redact("value 12345 here"); got != "value 12345 here" {
		t.Fatalf("expected 5-byte value left intact, got %q", got)
	}
	if got := redactor.redact("value abcdef here"); !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("expected 6-byte value redacted, got %q", got)
	}
}

func TestEnvRedactor_RedactErrorWrapsAndScrubs(t *testing.T) {
	redactor := newEnvRedactor(map[string]string{"TOKEN": "supersecrettoken"})

	if redactor.redactError(nil) != nil {
		t.Fatalf("redactError(nil) must return nil")
	}

	err := errors.New("compose failed using supersecrettoken in env")
	scrubbed := redactor.redactError(err)
	if scrubbed == nil {
		t.Fatalf("redactError must not return nil for a real error")
	}
	if strings.Contains(scrubbed.Error(), "supersecrettoken") {
		t.Fatalf("secret leaked into error: %q", scrubbed.Error())
	}
	if !strings.Contains(scrubbed.Error(), "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in scrubbed error: %q", scrubbed.Error())
	}
}

func TestArgsContainConfig(t *testing.T) {
	if !argsContainConfig([]string{"config", "-q"}) {
		t.Fatalf("expected true when 'config' present")
	}
	if argsContainConfig([]string{"up", "-d", "--remove-orphans"}) {
		t.Fatalf("expected false when 'config' absent")
	}
	if argsContainConfig(nil) {
		t.Fatalf("expected false for nil args")
	}
}

func TestComposeStderrHasMissingVar(t *testing.T) {
	missing := []string{
		`WARN[0000] The "DATABASE_URL" variable is not set. Defaulting to a blank string.`,
		"error while interpolating: required variable DATABASE_URL is missing",
		`The "STRIPE_KEY" variable is not set. defaulting to a blank string`,
	}
	for _, s := range missing {
		if !composeStderrHasMissingVar(s) {
			t.Fatalf("expected missing-var detection for stderr: %q", s)
		}
	}

	notMissing := []string{
		"",
		"service web started",
		"pulling image registry.example.com/web:v1",
	}
	for _, s := range notMissing {
		if composeStderrHasMissingVar(s) {
			t.Fatalf("did not expect missing-var detection for stderr: %q", s)
		}
	}
}

func TestRouteServiceSet(t *testing.T) {
	routes := []RouteTarget{
		{Service: "web"},
		{Service: "  api  "}, // trimmed
		{Service: ""},        // skipped
		{Service: "web"},     // duplicate collapses
	}
	set := routeServiceSet(routes)

	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"api", "web"}
	if len(keys) != len(want) || keys[0] != want[0] || keys[1] != want[1] {
		t.Fatalf("expected %v, got %v", want, keys)
	}
}
