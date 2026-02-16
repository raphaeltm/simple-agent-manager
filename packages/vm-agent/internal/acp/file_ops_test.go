package acp

import (
	"fmt"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

func intPtr(n int) *int {
	return &n
}

func TestApplyLineLimit(t *testing.T) {
	content := "line1\nline2\nline3\nline4\nline5"

	tests := []struct {
		name     string
		content  string
		line     *int
		limit    *int
		expected string
	}{
		{
			name:     "no line or limit returns full content",
			content:  content,
			line:     nil,
			limit:    nil,
			expected: content,
		},
		{
			name:     "line=1 returns from beginning",
			content:  content,
			line:     intPtr(1),
			limit:    nil,
			expected: content,
		},
		{
			name:     "line=3 returns from third line",
			content:  content,
			line:     intPtr(3),
			limit:    nil,
			expected: "line3\nline4\nline5",
		},
		{
			name:     "limit=2 returns first two lines",
			content:  content,
			line:     nil,
			limit:    intPtr(2),
			expected: "line1\nline2",
		},
		{
			name:     "line=2 limit=2 returns lines 2-3",
			content:  content,
			line:     intPtr(2),
			limit:    intPtr(2),
			expected: "line2\nline3",
		},
		{
			name:     "line beyond content returns empty",
			content:  content,
			line:     intPtr(100),
			limit:    nil,
			expected: "",
		},
		{
			name:     "limit=0 returns all lines",
			content:  content,
			line:     nil,
			limit:    intPtr(0),
			expected: content,
		},
		{
			name:     "limit larger than content returns all",
			content:  content,
			line:     nil,
			limit:    intPtr(100),
			expected: content,
		},
		{
			name:     "empty content",
			content:  "",
			line:     intPtr(1),
			limit:    intPtr(5),
			expected: "",
		},
		{
			name:     "single line with line=1 limit=1",
			content:  "only line",
			line:     intPtr(1),
			limit:    intPtr(1),
			expected: "only line",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := applyLineLimit(tt.content, tt.line, tt.limit)
			if result != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, result)
			}
		})
	}
}

func TestReadTextFileValidation(t *testing.T) {
	client := &sessionHostClient{
		host: &SessionHost{
			config: SessionHostConfig{
				GatewayConfig: GatewayConfig{
					ContainerResolver: func() (string, error) {
						return "test-container", nil
					},
				},
			},
		},
	}

	t.Run("empty path returns error", func(t *testing.T) {
		_, err := client.ReadTextFile(t.Context(), acpsdk.ReadTextFileRequest{
			Path: "",
		})
		if err == nil {
			t.Fatal("expected error for empty path")
		}
		if !strings.Contains(err.Error(), "file path is required") {
			t.Errorf("expected 'file path is required' error, got: %v", err)
		}
	})
}

func TestWriteTextFileValidation(t *testing.T) {
	client := &sessionHostClient{
		host: &SessionHost{
			config: SessionHostConfig{
				GatewayConfig: GatewayConfig{
					ContainerResolver: func() (string, error) {
						return "test-container", nil
					},
				},
			},
		},
	}

	t.Run("empty path returns error", func(t *testing.T) {
		_, err := client.WriteTextFile(t.Context(), acpsdk.WriteTextFileRequest{
			Path:    "",
			Content: "hello",
		})
		if err == nil {
			t.Fatal("expected error for empty path")
		}
		if !strings.Contains(err.Error(), "file path is required") {
			t.Errorf("expected 'file path is required' error, got: %v", err)
		}
	})
}

func TestContainerResolverFailure(t *testing.T) {
	client := &sessionHostClient{
		host: &SessionHost{
			config: SessionHostConfig{
				GatewayConfig: GatewayConfig{
					ContainerResolver: func() (string, error) {
						return "", fmt.Errorf("no container available")
					},
				},
			},
		},
	}

	t.Run("ReadTextFile fails on container resolver error", func(t *testing.T) {
		_, err := client.ReadTextFile(t.Context(), acpsdk.ReadTextFileRequest{
			Path: "/tmp/test.txt",
		})
		if err == nil {
			t.Fatal("expected error when container resolver fails")
		}
		if !strings.Contains(err.Error(), "failed to resolve container") {
			t.Errorf("expected container resolve error, got: %v", err)
		}
	})

	t.Run("WriteTextFile fails on container resolver error", func(t *testing.T) {
		_, err := client.WriteTextFile(t.Context(), acpsdk.WriteTextFileRequest{
			Path:    "/tmp/test.txt",
			Content: "hello",
		})
		if err == nil {
			t.Fatal("expected error when container resolver fails")
		}
		if !strings.Contains(err.Error(), "failed to resolve container") {
			t.Errorf("expected container resolve error, got: %v", err)
		}
	})
}
