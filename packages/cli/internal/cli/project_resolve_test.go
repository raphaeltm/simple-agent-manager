package cli

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestResolveProjectByFullULID(t *testing.T) {
	// Full ULID (26 chars, base32) should be used as-is without API call
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatal("should not make API call for full ULID")
		return nil, nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	id, name, err := ResolveProject(context.Background(), client, "01ABCDEFGHIJKLMNOPQRSTUVWX", nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != "01ABCDEFGHIJKLMNOPQRSTUVWX" {
		t.Fatalf("id = %s", id)
	}
	if name != "" {
		t.Fatalf("name should be empty for direct ULID, got %s", name)
	}
}

func TestResolveProjectByPrefix(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"My App"},{"id":"01ZYXWVUTSRQPONMLKJIHGFEDC","name":"Other"}]}`, http.StatusOK), nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	id, name, err := ResolveProject(context.Background(), client, "01ABC", nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != "01ABCDEFGHIJKLMNOPQRSTUVWX" || name != "My App" {
		t.Fatalf("id=%s name=%s", id, name)
	}
}

func TestResolveProjectByName(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"My App"},{"id":"01ZYXWVUTSRQPONMLKJIHGFEDC","name":"Other"}]}`, http.StatusOK), nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	id, name, err := ResolveProject(context.Background(), client, "my app", nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != "01ABCDEFGHIJKLMNOPQRSTUVWX" || name != "My App" {
		t.Fatalf("id=%s name=%s", id, name)
	}
}

func TestResolveProjectFromConfig(t *testing.T) {
	config := &CLIConfig{ActiveProjectID: "proj_123", ActiveProjectName: "Saved"}
	id, name, err := ResolveProject(context.Background(), APIClient{}, "", config)
	if err != nil {
		t.Fatal(err)
	}
	if id != "proj_123" || name != "Saved" {
		t.Fatalf("id=%s name=%s", id, name)
	}
}

func TestResolveProjectEmptyWithNoConfig(t *testing.T) {
	_, _, err := ResolveProject(context.Background(), APIClient{}, "", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "no project specified") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveProjectAmbiguousPrefix(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"First"},{"id":"01ABCZZZZZZZZZZZZZZZZZZZZZ","name":"Second"}]}`, http.StatusOK), nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	_, _, err := ResolveProject(context.Background(), client, "01ABC", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "multiple projects match") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveProjectNameNotFound(t *testing.T) {
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"My App"}]}`, http.StatusOK), nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	_, _, err := ResolveProject(context.Background(), client, "Nonexistent", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "no project found") {
		t.Fatalf("err = %v", err)
	}
}

func TestIsULID(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"01ABCDEFGHIJKLMNOPQRSTUVWX", true},
		{"01234567890123456789012345", true},
		{"01abc", false},                         // lowercase
		{"01ABCDEFGHIJKLMNOPQRSTUV", false},      // too short
		{"01ABCDEFGHIJKLMNOPQRSTUVWXY", false},   // too long
		{"01ABCDEFGHIJKLMNOPQRSTUVW!", false},     // invalid char
	}
	for _, tt := range tests {
		if got := isULID(tt.input); got != tt.want {
			t.Errorf("isULID(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestIsULIDPrefix(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"01ABC", true},
		{"01ABCDEF", true},
		{"01AB", false},    // too short (< 5)
		{"hello", false},   // lowercase
		{"01ab!", false},   // invalid char
		{"MYAPP", false},   // uppercase name, but starts with letter not digit
		{"DEMO1", false},   // starts with letter
		{"01ABCDEFGHIJKLMNOPQRSTUVWX", false}, // full ULID length (26 chars)
	}
	for _, tt := range tests {
		if got := isULIDPrefix(tt.input); got != tt.want {
			t.Errorf("isULIDPrefix(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestResolveProjectUppercaseNameNotMistaken(t *testing.T) {
	// A project named "MYAPP" (all uppercase, looks like base32) should resolve by name
	doer := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(`{"projects":[{"id":"01ABCDEFGHIJKLMNOPQRSTUVWX","name":"MYAPP"}]}`, http.StatusOK), nil
	})
	runtime, _, _ := testRuntime(t, nil, doer, nil)
	client, _, _ := authenticatedClientWithConfig(context.Background(), runtime)

	id, name, err := ResolveProject(context.Background(), client, "MYAPP", nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != "01ABCDEFGHIJKLMNOPQRSTUVWX" || name != "MYAPP" {
		t.Fatalf("expected name match, got id=%s name=%s", id, name)
	}
}
