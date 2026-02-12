package server

import (
	"reflect"
	"testing"
)

func TestContainerLabelCandidates(t *testing.T) {
	t.Parallel()

	got := containerLabelCandidates(
		" /workspace/ws-123 ",
		"",
		"/workspace/ws-123",
		"/workspace/legacy-repo",
		"/workspace",
		"/workspace",
	)

	want := []string{
		"/workspace/ws-123",
		"/workspace/legacy-repo",
		"/workspace",
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("containerLabelCandidates() = %#v, want %#v", got, want)
	}
}
