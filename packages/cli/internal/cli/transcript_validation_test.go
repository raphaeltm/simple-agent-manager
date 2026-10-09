package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranscriptRejectsInvalidMiddleIdentityBeforePublication(t *testing.T) {
	for _, test := range []struct {
		name string
		id   any
	}{
		{"missing", nil}, {"number", 7}, {"empty", ""}, {"whitespace", " \t"},
	} {
		for _, hydrate := range []bool{false, true} {
			mode := "plain"
			if hydrate {
				mode = "hydrate"
			}
			t.Run(test.name+"/"+mode, func(t *testing.T) {
				checkInvalidMiddleTranscript(t, test.id, hydrate)
			})
		}
	}
}

func checkInvalidMiddleTranscript(t *testing.T, id any, hydrate bool) {
	t.Helper()

	rows := []any{
		map[string]any{"id": "first", "createdAt": 1, "sequence": 1},
		map[string]any{"id": id, "createdAt": 1, "sequence": 2, "role": "tool"},
		map[string]any{"id": "last", "createdAt": 1, "sequence": 3},
	}
	body, err := json.Marshal(map[string]any{"messages": rows, "hasMore": false})
	if err != nil {
		t.Fatal(err)
	}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "tool-content") {
			t.Fatal("invalid transcript must fail before hydration")
		}
		return jsonResponse(string(body), 200), nil
	})
	output := filepath.Join(t.TempDir(), "transcript.json")
	args := []string{"chat", "export", "session", "--project", workflowProject, "--output", output}
	if hydrate {
		args = append(args, "--hydrate-tools")
	}
	runtime, stdout, stderr := testRuntime(t, args, transport, nil)
	if Run(context.Background(), runtime) == 0 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "missing ID") {
		t.Fatalf("export did not fail closed: stdout=%s stderr=%s", stdout, stderr)
	}
	if _, err = os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("incomplete transcript published: %v", err)
	}
}
