package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// This optional file bridge is test-only. It passes actual HTTP callback bytes
// from the Go producer into the real Worker callback/sleep/schedule tests.
func TestProviderLimitRecordedFixtureCallbacks(t *testing.T) {
	var fixtures struct {
		Now   string `json:"now"`
		Cases []struct {
			Name     string                 `json:"name"`
			Wire     json.RawMessage        `json:"wire"`
			Callback map[string]interface{} `json:"callback"`
		} `json:"cases"`
	}
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures", "provider-limit-rejections.json")
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, fixtures.Now)
	if err != nil {
		t.Fatal(err)
	}
	type produced struct {
		Name     string                 `json:"name"`
		Callback map[string]interface{} `json:"callback"`
	}
	callbacks := []produced{}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			body := runProviderWireThroughProductionHost(t, fixture.Name, fixture.Wire, now, config.TaskModeTask)
			if !reflect.DeepEqual(body, fixture.Callback) {
				t.Fatalf("HTTP callback=%v want=%v", body, fixture.Callback)
			}
			callbacks = append(callbacks, produced{fixture.Name, body})
		})
	}
	if output := os.Getenv("TEST_PROVIDER_LIMIT_CALLBACK_OUTPUT"); output != "" {
		if t.Failed() {
			return
		}
		encoded, err := json.Marshal(callbacks)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(output, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
