package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// mockExecRunner records and replays command executions for testing.
type mockExecRunner struct {
	calls   []mockExecCall
	outputs map[string]mockExecResult
}

type mockExecCall struct {
	Name string
	Args []string
}

type mockExecResult struct {
	Output string
	Err    error
}

func newMockExecRunner() *mockExecRunner {
	return &mockExecRunner{
		outputs: make(map[string]mockExecResult),
	}
}

func (m *mockExecRunner) On(name string, args ...string) *mockExecRunner {
	key := m.key(name, args...)
	m.outputs[key] = mockExecResult{}
	return m
}

func (m *mockExecRunner) OnWithOutput(output string, name string, args ...string) *mockExecRunner {
	key := m.key(name, args...)
	m.outputs[key] = mockExecResult{Output: output}
	return m
}

func (m *mockExecRunner) OnWithError(err error, name string, args ...string) *mockExecRunner {
	key := m.key(name, args...)
	m.outputs[key] = mockExecResult{Err: err}
	return m
}

func (m *mockExecRunner) key(name string, args ...string) string {
	return fmt.Sprintf("%s %v", name, args)
}

func (m *mockExecRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	m.calls = append(m.calls, mockExecCall{Name: name, Args: args})
	key := m.key(name, args...)
	if result, ok := m.outputs[key]; ok {
		return result.Output, result.Err
	}
	return "", nil
}

func (m *mockExecRunner) wasCalled(name string, args ...string) bool {
	key := m.key(name, args...)
	for _, call := range m.calls {
		if m.key(call.Name, call.Args...) == key {
			return true
		}
	}
	return false
}

// setupTestDisk creates a temporary disk state with releases for testing.
func setupTestDisk(t *testing.T, releases map[int64]string, currentSeq int64) *DiskState {
	t.Helper()
	dir := t.TempDir()
	disk, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	for seq, composeYAML := range releases {
		state := &ReleaseState{Seq: seq, Status: StatusApplied}
		if err := disk.WriteRelease(state, composeYAML, "# caddy"); err != nil {
			t.Fatalf("WriteRelease(%d): %v", seq, err)
		}
	}

	if currentSeq > 0 {
		if err := disk.SetCurrent(currentSeq); err != nil {
			t.Fatalf("SetCurrent(%d): %v", currentSeq, err)
		}
	}

	return disk
}

func TestPruneUnusedImages_PreservesCurrentAndPrevious(t *testing.T) {
	compose1 := `services:
  web:
    image: registry.example.com/app:v1
`
	compose2 := `services:
  web:
    image: registry.example.com/app:v2
`
	compose3 := `services:
  web:
    image: registry.example.com/app:v3
`

	disk := setupTestDisk(t, map[int64]string{
		1: compose1,
		2: compose2,
		3: compose3,
	}, 3) // current = 3, previous = 2

	runner := newMockExecRunner()
	runner.OnWithOutput(
		"registry.example.com/app:v1\nregistry.example.com/app:v2\nregistry.example.com/app:v3\nnginx:latest",
		"docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
	)
	// v1 and nginx:latest should be pruned; v2 and v3 should be kept
	runner.On("docker", "rmi", "registry.example.com/app:v1")
	runner.On("docker", "rmi", "nginx:latest")
	runner.On("docker", "image", "prune", "-f")

	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	// Protected images: v3 (current) and v2 (previous/rollback)
	if len(result.ProtectedImages) != 2 {
		t.Errorf("expected 2 protected images, got %d: %v", len(result.ProtectedImages), result.ProtectedImages)
	}

	// v1 and nginx should be pruned — assert exact contents
	if len(result.PrunedImages) != 2 {
		t.Errorf("expected 2 pruned images, got %d: %v", len(result.PrunedImages), result.PrunedImages)
	}
	prunedSet := make(map[string]bool)
	for _, img := range result.PrunedImages {
		prunedSet[img] = true
	}
	if !prunedSet["registry.example.com/app:v1"] {
		t.Error("expected v1 in pruned set")
	}
	if !prunedSet["nginx:latest"] {
		t.Error("expected nginx:latest in pruned set")
	}

	// v3 should NOT be removed
	if runner.wasCalled("docker", "rmi", "registry.example.com/app:v3") {
		t.Error("current release image (v3) should NOT be pruned")
	}

	// v2 should NOT be removed (rollback target)
	if runner.wasCalled("docker", "rmi", "registry.example.com/app:v2") {
		t.Error("previous release image (v2) should NOT be pruned (rollback target)")
	}
}

func TestPruneUnusedImages_DryRun(t *testing.T) {
	compose1 := `services:
  web:
    image: myapp:latest
`
	disk := setupTestDisk(t, map[int64]string{1: compose1}, 1)

	runner := newMockExecRunner()
	runner.OnWithOutput(
		"myapp:latest\nold-image:stale",
		"docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
	)

	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{DryRun: true})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	// Should report old-image:stale as pruned but NOT actually call docker rmi
	if len(result.PrunedImages) != 1 || result.PrunedImages[0] != "old-image:stale" {
		t.Errorf("expected dry-run to report old-image:stale, got %v", result.PrunedImages)
	}
	if runner.wasCalled("docker", "rmi", "old-image:stale") {
		t.Error("dry-run should NOT actually remove images")
	}
}

func TestPruneUnusedImages_NoReleases(t *testing.T) {
	disk := setupTestDisk(t, map[int64]string{}, 0)

	runner := newMockExecRunner()
	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	if len(result.ProtectedImages) != 0 {
		t.Errorf("expected 0 protected images, got %d", len(result.ProtectedImages))
	}
}

func TestPruneUnusedImages_SingleRelease(t *testing.T) {
	compose := `services:
  web:
    image: myapp:v1
  worker:
    image: myapp-worker:v1
`
	disk := setupTestDisk(t, map[int64]string{1: compose}, 1)

	runner := newMockExecRunner()
	runner.OnWithOutput(
		"myapp:v1\nmyapp-worker:v1\nold:stale",
		"docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
	)
	runner.On("docker", "rmi", "old:stale")
	runner.On("docker", "image", "prune", "-f")

	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	// Both service images should be protected
	if len(result.ProtectedImages) != 2 {
		t.Errorf("expected 2 protected images, got %d: %v", len(result.ProtectedImages), result.ProtectedImages)
	}

	// Only old:stale should be pruned
	if len(result.PrunedImages) != 1 {
		t.Errorf("expected 1 pruned image, got %d: %v", len(result.PrunedImages), result.PrunedImages)
	}
}

func TestPruneUnusedImages_HandleRemoveErrors(t *testing.T) {
	compose := `services:
  web:
    image: myapp:v1
`
	disk := setupTestDisk(t, map[int64]string{1: compose}, 1)

	runner := newMockExecRunner()
	runner.OnWithOutput(
		"myapp:v1\nin-use:latest",
		"docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
	)
	runner.OnWithError(fmt.Errorf("image in use by container"), "docker", "rmi", "in-use:latest")
	runner.On("docker", "image", "prune", "-f")

	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	// Should have a non-fatal error
	if len(result.Errors) != 1 {
		t.Errorf("expected 1 error, got %d", len(result.Errors))
	}
}

func TestExtractImagesFromRelease(t *testing.T) {
	dir := t.TempDir()
	disk, err := NewDiskState(dir)
	if err != nil {
		t.Fatalf("NewDiskState: %v", err)
	}

	compose := `services:
  web:
    image: "ghcr.io/myorg/app@sha256:abc123"
  api:
    image: ghcr.io/myorg/api:v2
  worker:
    image: 'custom-registry.io/worker:latest'
`
	state := &ReleaseState{Seq: 1, Status: StatusApplied}
	if err := disk.WriteRelease(state, compose, "# caddy"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	images, err := extractImagesFromRelease(disk, 1)
	if err != nil {
		t.Fatalf("extractImagesFromRelease: %v", err)
	}

	if len(images) != 3 {
		t.Fatalf("expected 3 images, got %d: %v", len(images), images)
	}

	expected := []string{
		"ghcr.io/myorg/app@sha256:abc123",
		"ghcr.io/myorg/api:v2",
		"custom-registry.io/worker:latest",
	}
	for i, exp := range expected {
		if images[i] != exp {
			t.Errorf("image[%d] = %q, want %q", i, images[i], exp)
		}
	}
}

func TestFindPreviousSeq(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	// Create release dirs
	for _, seq := range []int64{1, 3, 5, 7} {
		seqDir := filepath.Join(dir, "desired", "releases", fmt.Sprintf("%d", seq))
		os.MkdirAll(seqDir, 0755)
	}

	tests := []struct {
		currentSeq int64
		expected   int64
	}{
		{7, 5},
		{5, 3},
		{3, 1},
		{1, 0}, // no previous
	}

	for _, tt := range tests {
		result := findPreviousSeq(disk, tt.currentSeq)
		if result != tt.expected {
			t.Errorf("findPreviousSeq(%d) = %d, want %d", tt.currentSeq, result, tt.expected)
		}
	}
}

func TestListReleaseSeqs(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	// Create some release dirs
	for _, seq := range []int64{1, 3, 5} {
		seqDir := filepath.Join(dir, "desired", "releases", fmt.Sprintf("%d", seq))
		os.MkdirAll(seqDir, 0755)
	}
	// Also create a non-numeric dir (should be ignored)
	os.MkdirAll(filepath.Join(dir, "desired", "releases", "temp"), 0755)

	seqs := disk.ListReleaseSeqs()
	if len(seqs) != 3 {
		t.Fatalf("expected 3 seqs, got %d: %v", len(seqs), seqs)
	}
}

func TestPruneUnusedImages_SkipsNoneNone(t *testing.T) {
	compose := `services:
  web:
    image: myapp:v1
`
	disk := setupTestDisk(t, map[int64]string{1: compose}, 1)

	runner := newMockExecRunner()
	runner.OnWithOutput(
		"myapp:v1\n<none>:<none>",
		"docker", "images", "--format", "{{.Repository}}:{{.Tag}}",
	)
	runner.On("docker", "image", "prune", "-f")

	result, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err != nil {
		t.Fatalf("PruneUnusedImages: %v", err)
	}

	// <none>:<none> should be skipped entirely — not pruned, not errored
	if len(result.PrunedImages) != 0 {
		t.Errorf("expected 0 pruned images, got %d: %v", len(result.PrunedImages), result.PrunedImages)
	}
	if runner.wasCalled("docker", "rmi", "<none>:<none>") {
		t.Error("should NOT attempt to rmi <none>:<none> images")
	}
}

func TestPruneUnusedImages_ListImagesError(t *testing.T) {
	compose := `services:
  web:
    image: myapp:v1
`
	disk := setupTestDisk(t, map[int64]string{1: compose}, 1)

	runner := newMockExecRunner()
	runner.OnWithError(fmt.Errorf("docker not found"), "docker", "images", "--format", "{{.Repository}}:{{.Tag}}")

	_, err := PruneUnusedImages(context.Background(), disk, runner, ImageGCConfig{})
	if err == nil {
		t.Fatal("expected error when docker images fails")
	}
}

func TestReadComposeFile(t *testing.T) {
	dir := t.TempDir()
	disk, _ := NewDiskState(dir)

	compose := `services:
  web:
    image: myapp:v1
`
	state := &ReleaseState{Seq: 42, Status: StatusApplied}
	if err := disk.WriteRelease(state, compose, "# caddy"); err != nil {
		t.Fatalf("WriteRelease: %v", err)
	}

	content, err := disk.ReadComposeFile(42)
	if err != nil {
		t.Fatalf("ReadComposeFile: %v", err)
	}
	if content != compose {
		t.Errorf("content mismatch:\ngot:  %q\nwant: %q", content, compose)
	}

	// Non-existent seq should error
	_, err = disk.ReadComposeFile(99)
	if err == nil {
		t.Error("expected error for non-existent seq")
	}
}
