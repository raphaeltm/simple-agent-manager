package tools

import (
	"context"
	"testing"
)

// stubTool is a minimal tool for testing permission logic.
type stubTool struct {
	name  string
	level DangerLevel
}

func (s *stubTool) Name() string                                          { return s.name }
func (s *stubTool) Description() string                                   { return "stub" }
func (s *stubTool) Schema() map[string]any                                { return nil }
func (s *stubTool) Execute(_ context.Context, _ map[string]any) (string, error) { return "ok", nil }
func (s *stubTool) DangerLevel() DangerLevel                              { return s.level }

func TestParsePermissionMode(t *testing.T) {
	tests := []struct {
		input   string
		want    PermissionMode
		wantErr bool
	}{
		{"allow-all", PermissionAllowAll, false},
		{"deny-dangerous", PermissionDenyDangerous, false},
		{"ask-always", PermissionAskAlways, false},
		{"", PermissionAllowAll, false},
		{"invalid", "", true},
	}
	for _, tt := range tests {
		got, err := ParsePermissionMode(tt.input)
		if (err != nil) != tt.wantErr {
			t.Errorf("ParsePermissionMode(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			continue
		}
		if got != tt.want {
			t.Errorf("ParsePermissionMode(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestDangerLevelString(t *testing.T) {
	if Safe.String() != "safe" {
		t.Errorf("Safe.String() = %q", Safe.String())
	}
	if Write.String() != "write" {
		t.Errorf("Write.String() = %q", Write.String())
	}
	if Dangerous.String() != "dangerous" {
		t.Errorf("Dangerous.String() = %q", Dangerous.String())
	}
}

func TestGetDangerLevel_Interface(t *testing.T) {
	tool := &stubTool{name: "custom", level: Write}
	if got := GetDangerLevel(tool); got != Write {
		t.Errorf("GetDangerLevel(DangerLeveler) = %v, want Write", got)
	}
}

func TestGetDangerLevel_DefaultMap(t *testing.T) {
	// ReadFile doesn't implement DangerLeveler, but is in the default map.
	rf := &ReadFile{WorkDir: "."}
	if got := GetDangerLevel(rf); got != Safe {
		t.Errorf("GetDangerLevel(ReadFile) = %v, want Safe", got)
	}
	wf := &WriteFile{WorkDir: "."}
	if got := GetDangerLevel(wf); got != Write {
		t.Errorf("GetDangerLevel(WriteFile) = %v, want Write", got)
	}
	b := &Bash{WorkDir: "."}
	if got := GetDangerLevel(b); got != Dangerous {
		t.Errorf("GetDangerLevel(Bash) = %v, want Dangerous", got)
	}
}

func TestGetDangerLevel_UnknownDefaultsDangerous(t *testing.T) {
	unknown := &echoTool{} // name="echo", not in default map, no DangerLeveler
	if got := GetDangerLevel(unknown); got != Dangerous {
		t.Errorf("GetDangerLevel(unknown) = %v, want Dangerous", got)
	}
}

func TestNeedsPermission(t *testing.T) {
	tests := []struct {
		mode  PermissionMode
		level DangerLevel
		want  bool
	}{
		{PermissionAllowAll, Safe, false},
		{PermissionAllowAll, Write, false},
		{PermissionAllowAll, Dangerous, false},
		{PermissionAskAlways, Safe, true},
		{PermissionAskAlways, Write, true},
		{PermissionAskAlways, Dangerous, true},
		{PermissionDenyDangerous, Safe, false},
		{PermissionDenyDangerous, Write, false},
		{PermissionDenyDangerous, Dangerous, true},
	}
	for _, tt := range tests {
		got := NeedsPermission(tt.mode, tt.level)
		if got != tt.want {
			t.Errorf("NeedsPermission(%q, %v) = %v, want %v", tt.mode, tt.level, got, tt.want)
		}
	}
}

func TestAutoApproveChecker(t *testing.T) {
	c := AutoApproveChecker{}
	allowed, err := c.CheckPermission("bash", nil, Dangerous)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !allowed {
		t.Error("AutoApproveChecker should always return true")
	}
}

// denyChecker always denies.
type denyChecker struct{}

func (denyChecker) CheckPermission(string, map[string]any, DangerLevel) (bool, error) {
	return false, nil
}

func TestRegistryGet(t *testing.T) {
	r := NewRegistry()
	tool := &stubTool{name: "test_tool", level: Safe}
	if err := r.Register(tool); err != nil {
		t.Fatal(err)
	}
	if got := r.Get("test_tool"); got == nil {
		t.Error("Get returned nil for registered tool")
	}
	if got := r.Get("nonexistent"); got != nil {
		t.Error("Get returned non-nil for unregistered tool")
	}
}
