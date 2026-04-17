package server

import "testing"

func TestIsValidContainerID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		id    string
		valid bool
	}{
		// Valid Docker hex IDs
		{"abcdef123456", true},                                                         // 12-char short ID
		{"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd", true},  // 64-char full ID
		// Valid Docker container names
		{"container-123", true},
		{"my_container.name", true},
		{"devcontainer-ws-1", true},
		// Invalid
		{"", false},
		{"; rm -rf /", false},
		{"$(whoami)", false},
		{"`whoami`", false},
		{"container\nname", false},
		{"container name", false}, // spaces not allowed
	}

	for _, tc := range tests {
		got := isValidContainerID(tc.id)
		if got != tc.valid {
			t.Errorf("isValidContainerID(%q) = %v, want %v", tc.id, got, tc.valid)
		}
	}
}

func TestClampTerminalDimension(t *testing.T) {
	t.Parallel()

	tests := []struct {
		value    int
		fallback int
		want     int
	}{
		{0, 24, 24},     // too small -> fallback
		{-1, 24, 24},    // negative -> fallback
		{1, 24, 1},      // minimum valid
		{500, 24, 500},  // maximum valid
		{501, 24, 24},   // too large -> fallback
		{80, 80, 80},    // normal value
		{9999, 80, 80},  // way too large -> fallback
	}

	for _, tc := range tests {
		got := clampTerminalDimension(tc.value, tc.fallback)
		if got != tc.want {
			t.Errorf("clampTerminalDimension(%d, %d) = %d, want %d", tc.value, tc.fallback, got, tc.want)
		}
	}
}
