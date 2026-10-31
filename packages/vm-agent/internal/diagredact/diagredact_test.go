package diagredact

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sharedCanaries(t *testing.T) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "diagnostic-secret-canaries.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name      string   `json:"name"`
		Fragments []string `json:"fragments"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	canaries := make(map[string]string, len(fixtures))
	for _, fixture := range fixtures {
		canaries[fixture.Name] = strings.Join(fixture.Fragments, "")
	}
	if len(canaries) < 12 {
		t.Fatalf("loaded %d canaries; the shared fixture did not parse", len(canaries))
	}
	return canaries
}

// secretPart is the portion of a canary that must not survive. Most canaries
// end in their secret; the credential URL's secret is its userinfo.
func secretPart(name, canary string) string {
	if name == "credential-url" {
		return "operator:password"
	}
	if len(canary) <= 12 {
		return canary
	}
	return canary[len(canary)-12:]
}

func TestTextStripsEverySharedCanary(t *testing.T) {
	t.Parallel()

	for name, canary := range sharedCanaries(t) {
		t.Run(name, func(t *testing.T) {
			got := Text("provider error: " + canary + " (retry later)")
			if strings.Contains(got, secretPart(name, canary)) {
				t.Fatalf("Text leaked %s: %q", name, got)
			}
			if !strings.Contains(got, "provider error:") || !strings.Contains(got, "(retry later)") {
				t.Fatalf("Text removed surrounding text: %q", got)
			}
		})
	}
}

func TestTextStripsTokensJoinedByUnderscore(t *testing.T) {
	t.Parallel()

	canaries := sharedCanaries(t)
	for _, name := range []string{"openai-legacy-key", "opencode-api-key", "github-fine-grained-pat", "aws-access-key", "google-api-key", "sam-personal-access-token"} {
		t.Run(name, func(t *testing.T) {
			// \b does not fire between "_" and a letter, so a \b-anchored shape misses this.
			got := Text("CONFIG_" + canaries[name])
			if got != "CONFIG_[REDACTED]" {
				t.Fatalf("Text(CONFIG_<%s>) = %q, want CONFIG_[REDACTED]", name, got)
			}
		})
	}
}

func TestTextLeavesWordsThatContainTokenPrefixes(t *testing.T) {
	t.Parallel()

	for _, text := range []string{
		"task-runner-1234567890 failed",
		"disk-usage-report-2026 written",
		"see https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling",
		"package github.com/workspace/vm-agent/internal/acp",
	} {
		if got := Text(text); got != text {
			t.Fatalf("Text(%q) = %q, want unchanged", text, got)
		}
	}
}

func TestTextKeepsPrefixesAndRedactsPrivateKeyBlocks(t *testing.T) {
	t.Parallel()

	for input, want := range map[string]string{
		"sent Bearer abcdefghijklmnop1234 upstream":                                   "sent Bearer [REDACTED] upstream",
		"api_key=abc123 next":                                                         "api_key=[REDACTED] next",
		"webhook sam_wh_Zk3Lq9Xv7Rt2Mn5Bp8 rejected":                                  "webhook [REDACTED] rejected",
		`{"authorization":"Basic b3BlcmF0b3I6c2VjcmV0"}`:                              `{"authorization":"Basic [REDACTED]"}`,
		"GET /x?X-Amz-Signature=deadbeef&y=1":                                         "GET /x?X-Amz-Signature=[REDACTED]&y=1",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- tail": "[REDACTED] tail",
	} {
		if got := Text(input); got != want {
			t.Fatalf("Text(%q) = %q, want %q", input, got, want)
		}
	}
}
