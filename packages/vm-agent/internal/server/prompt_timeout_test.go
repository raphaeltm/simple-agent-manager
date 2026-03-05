package server

import (
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestEffectivePromptTimeout(t *testing.T) {
	tests := []struct {
		name     string
		taskID   string
		prompt   time.Duration
		task     time.Duration
		expected time.Duration
	}{
		{
			name:     "workspace session uses ACPPromptTimeout (0 = no limit)",
			taskID:   "",
			prompt:   0,
			task:     6 * time.Hour,
			expected: 0,
		},
		{
			name:     "workspace session with custom timeout",
			taskID:   "",
			prompt:   2 * time.Hour,
			task:     6 * time.Hour,
			expected: 2 * time.Hour,
		},
		{
			name:     "task session uses ACPTaskPromptTimeout",
			taskID:   "task-123",
			prompt:   0,
			task:     6 * time.Hour,
			expected: 6 * time.Hour,
		},
		{
			name:     "task session with custom task timeout",
			taskID:   "task-456",
			prompt:   0,
			task:     3 * time.Hour,
			expected: 3 * time.Hour,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &config.Config{
				TaskID:               tt.taskID,
				ACPPromptTimeout:     tt.prompt,
				ACPTaskPromptTimeout: tt.task,
			}
			got := effectivePromptTimeout(cfg)
			if got != tt.expected {
				t.Errorf("effectivePromptTimeout() = %v, want %v", got, tt.expected)
			}
		})
	}
}
