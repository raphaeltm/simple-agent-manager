package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/logreader"
)

func TestLogStreamRejectsPreviewOriginBeforeAuthentication(t *testing.T) {
	sm := auth.NewSessionManager("session", false, time.Hour)
	defer sm.Stop()
	s := &Server{
		config:         &config.Config{AllowedOrigins: []string{"https://app.example.com"}},
		sessionManager: sm,
	}

	previewRecorder := httptest.NewRecorder()
	previewRequest := httptest.NewRequest(http.MethodGet, "/logs/stream", nil)
	previewRequest.Header.Set("Origin", "https://ws-ws001--3000.example.com")
	s.handleLogStream(previewRecorder, previewRequest)
	if previewRecorder.Code != http.StatusForbidden {
		t.Fatalf("preview origin status = %d, want 403", previewRecorder.Code)
	}

	trustedRecorder := httptest.NewRecorder()
	trustedRequest := httptest.NewRequest(http.MethodGet, "/logs/stream", nil)
	trustedRequest.Header.Set("Origin", "https://app.example.com")
	s.handleLogStream(trustedRecorder, trustedRequest)
	if trustedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("trusted unauthenticated status = %d, want 401", trustedRecorder.Code)
	}
}

func TestParseLogFilter(t *testing.T) {
	tests := []struct {
		name   string
		query  string
		want   logreader.LogFilter
	}{
		{
			name:  "defaults",
			query: "",
			want: logreader.LogFilter{
				Source: "all",
				Level:  "info",
			},
		},
		{
			name:  "all params",
			query: "source=agent&level=error&container=my-app&since=2026-01-01T00:00:00Z&until=2026-01-02T00:00:00Z&search=timeout&cursor=abc123&limit=50",
			want: logreader.LogFilter{
				Source:    "agent",
				Level:     "error",
				Container: "my-app",
				Since:     "2026-01-01T00:00:00Z",
				Until:     "2026-01-02T00:00:00Z",
				Search:    "timeout",
				Cursor:    "abc123",
				Limit:     50,
			},
		},
		{
			name:  "case insensitive source and level",
			query: "source=Docker&level=WARN",
			want: logreader.LogFilter{
				Source: "docker",
				Level:  "warn",
			},
		},
		{
			name:  "invalid limit uses default",
			query: "limit=notanumber",
			want: logreader.LogFilter{
				Source: "all",
				Level:  "info",
				Limit:  0, // 0 means use default in clampLimit
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, _ := url.Parse("/logs?" + tt.query)
			r := &http.Request{URL: u}
			got := parseLogFilter(r)

			if got.Source != tt.want.Source {
				t.Errorf("Source = %q, want %q", got.Source, tt.want.Source)
			}
			if got.Level != tt.want.Level {
				t.Errorf("Level = %q, want %q", got.Level, tt.want.Level)
			}
			if got.Container != tt.want.Container {
				t.Errorf("Container = %q, want %q", got.Container, tt.want.Container)
			}
			if got.Since != tt.want.Since {
				t.Errorf("Since = %q, want %q", got.Since, tt.want.Since)
			}
			if got.Until != tt.want.Until {
				t.Errorf("Until = %q, want %q", got.Until, tt.want.Until)
			}
			if got.Search != tt.want.Search {
				t.Errorf("Search = %q, want %q", got.Search, tt.want.Search)
			}
			if got.Cursor != tt.want.Cursor {
				t.Errorf("Cursor = %q, want %q", got.Cursor, tt.want.Cursor)
			}
			if got.Limit != tt.want.Limit {
				t.Errorf("Limit = %d, want %d", got.Limit, tt.want.Limit)
			}
		})
	}
}
