package acp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestProviderLimitProductionEnvelopes(t *testing.T) {
	encoded, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "fixtures", "provider-limit-rejections.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now   string `json:"now"`
		Cases []struct {
			Name     string              `json:"name"`
			Wire     acpsdk.RequestError `json:"wire"`
			Callback struct {
				ResetsAt *int64 `json:"providerLimitResetsAt"`
			} `json:"callback"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, tc := range fixture.Cases {
		if !strings.Contains(tc.Name, "production envelope") {
			continue
		}
		count++
		t.Run(tc.Name, func(t *testing.T) {
			limit := ClassifyProviderLimit(&tc.Wire, now)
			if limit == nil {
				t.Fatal("production envelope did not classify")
			}
			if (limit.ResetsAt == nil) != (tc.Callback.ResetsAt == nil) {
				t.Fatal("reset presence differs")
			}
			if limit.ResetsAt != nil && *limit.ResetsAt != *tc.Callback.ResetsAt {
				t.Fatal("reset timestamp differs")
			}
		})
	}
	if count != 5 {
		t.Fatalf("production fixture count=%d, want 5", count)
	}
}

func TestCodexProductionClockBounds(t *testing.T) {
	message := "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at "
	cases := []struct{ name, now, clock, expected string }{
		{"same day", "2026-09-25T05:00:00Z", "12:02 PM.", "2026-09-25T12:02:00Z"},
		{"UTC despite caller offset", "2026-09-25T20:00:00+09:00", "12:02 PM.", "2026-09-25T12:02:00Z"},
		{"next day", "2026-09-25T13:00:00Z", "12:02 PM.", "2026-09-26T12:02:00Z"},
		{"ordinal exact", "2026-09-25T05:00:00Z", "Sep 26th, 2026 12:02 PM.", "2026-09-26T12:02:00Z"},
		{"past date", "2026-09-27T05:00:00Z", "Sep 26th, 2026 12:02 PM.", ""},
		{"beyond week", "2026-08-14T05:00:00Z", "Sep 26th, 2026 12:02 PM.", ""},
		{"invalid day", "2026-09-25T05:00:00Z", "Sep 31st, 2026 12:02 PM.", ""},
		{"invalid hour", "2026-09-25T05:00:00Z", "25:02 PM.", ""},
		{"invalid minute", "2026-09-25T05:00:00Z", "12:72 PM.", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now, _ := time.Parse(time.RFC3339, tc.now)
			got := ClassifyProviderLimit(&acpsdk.RequestError{Code: -32603, Message: "Internal error", Data: map[string]any{"codexErrorInfo": "usageLimitExceeded", "message": message + tc.clock}}, now)
			if got == nil {
				t.Fatal("categorical quota lost")
			}
			if tc.expected == "" {
				if got.ResetsAt != nil {
					t.Fatal("invalid/out-of-bound reset became known")
				}
				return
			}
			expected, _ := time.Parse(time.RFC3339, tc.expected)
			if got.ResetsAt == nil || *got.ResetsAt != expected.UnixMilli() {
				t.Fatal("wrong Codex reset")
			}
		})
	}
	now := time.Date(2026, 9, 25, 5, 0, 0, 0, time.UTC)
	for _, category := range []string{"", "unauthorized"} {
		data := map[string]any{"message": message + "12:02 PM."}
		if category != "" {
			data["codexErrorInfo"] = category
		}
		if ClassifyProviderLimit(&acpsdk.RequestError{Code: -32603, Message: "Internal error", Data: data}, now) != nil {
			t.Fatal("untrusted/auth clock classified")
		}
	}
	for _, text := range []string{"Provider HTTP 429 rate limit", "Internal error: MCP tool said resets 8am (UTC)"} {
		if ClassifyProviderLimit(&acpsdk.RequestError{Code: -32603, Message: text, Data: map[string]any{"errorKind": "rate_limit"}}, now) != nil {
			t.Fatal("transient/tool text classified")
		}
	}
}
