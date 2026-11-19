package errorreport

import "testing"

// The shared canary test redacts a message holding every canary at once, so any
// one pattern can blank it. These cases isolate each shape added for parity
// with internal/diagredact.
func TestSanitizeStringRedactsEachDiagredactParityShape(t *testing.T) {
	t.Parallel()

	for _, value := range []string{
		"upstream said Authorization: Basic b3BlcmF0b3I6c2VjcmV0",
		`{"authorization":"Basic b3BlcmF0b3I6c2VjcmV0"}`,
		"webhook " + "sam_" + "wh_Zk3Lq9Xv7Rt2Mn5Bp8 rejected",
		"token " + "sam_" + "pat_q7Hk2Zx9Lm4P-w8Rt6Vb3 expired",
	} {
		if got := sanitizeString(value); got != "[REDACTED]" {
			t.Fatalf("sanitizeString(%q) = %q, want [REDACTED]", value, got)
		}
	}
	if got := sanitizeString("basic configuration applied"); got != "basic configuration applied" {
		t.Fatalf("plain use of the word basic was redacted: %q", got)
	}
}
