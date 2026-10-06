package acp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Cross-boundary contract test (.claude/rules/23).
//
// This reads the SAME fixture the Worker-side validator test reads
// (apps/api/tests/unit/schemas/acp-activity-report-contract.test.ts), so a
// rename of a json tag here — or of a field in AcpSessionActivityReportSchema
// there — fails a test instead of silently dropping the field on the wire and
// quietly disabling harness-work sleep deferral.
type activityReportFixture struct {
	Cases []struct {
		Name    string          `json:"name"`
		Comment string          `json:"comment"`
		Payload json.RawMessage `json:"payload"`
	} `json:"cases"`
}

func loadActivityReportFixture(t *testing.T) activityReportFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "acp-activity-report-v1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared contract fixture %s: %v", path, err)
	}
	var fixture activityReportFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode shared contract fixture: %v", err)
	}
	if len(fixture.Cases) < 4 {
		t.Fatalf("fixture cases = %d, want at least 4", len(fixture.Cases))
	}
	return fixture
}

// TestActivityPayloadMatchesSharedContractFixture proves every field the Worker
// schema accepts decodes into activityPayload, and that re-encoding it produces
// the same JSON keys the Worker expects.
func TestActivityPayloadMatchesSharedContractFixture(t *testing.T) {
	fixture := loadActivityReportFixture(t)

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			var payload activityPayload
			if err := json.Unmarshal(testCase.Payload, &payload); err != nil {
				t.Fatalf("decode payload into activityPayload: %v", err)
			}

			// Round-trip back to JSON and compare key sets against the fixture.
			// A renamed json tag drops the key here and fails the comparison.
			encoded, err := json.Marshal(payload)
			if err != nil {
				t.Fatalf("re-encode activityPayload: %v", err)
			}
			var got map[string]any
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatalf("decode re-encoded payload: %v", err)
			}
			var want map[string]any
			if err := json.Unmarshal(testCase.Payload, &want); err != nil {
				t.Fatalf("decode fixture payload: %v", err)
			}

			for key, wantValue := range want {
				gotValue, ok := got[key]
				if !ok {
					t.Fatalf("field %q from the shared fixture is not produced by activityPayload "+
						"(json tag renamed or missing?)", key)
				}
				if !jsonValuesEqual(gotValue, wantValue) {
					t.Fatalf("field %q = %v, want %v", key, gotValue, wantValue)
				}
			}
		})
	}
}

// TestActivityPayloadHarnessFieldsAreOmittedWhenUnset pins the backward-compat
// contract: an agent with no harness support must not emit runtimeWork* keys at
// all, so an older/newer control plane sees the legacy shape.
func TestActivityPayloadHarnessFieldsAreOmittedWhenUnset(t *testing.T) {
	encoded, err := json.Marshal(activityPayload{Activity: "prompting", NodeID: "node-1"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{
		"runtimeWorkState", "runtimeWorkCount", "runtimeWorkSource", "runtimeWorkProgressAt",
	} {
		if _, present := got[key]; present {
			t.Fatalf("field %q must be omitted when unset, got %v", key, got[key])
		}
	}
}

func jsonValuesEqual(got any, want any) bool {
	gotNumber, gotIsNumber := got.(float64)
	wantNumber, wantIsNumber := want.(float64)
	if gotIsNumber && wantIsNumber {
		return gotNumber == wantNumber
	}
	return got == want
}
