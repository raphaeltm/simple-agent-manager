package publish

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestExecutionCountersObserveActualBuildAndSaveAttempts(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "docker")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", binary)
	before := ExecutionCounters()
	if before.ProcessIncarnation == "" {
		t.Fatal("missing process identity")
	}
	if _, err := runCompose(context.Background(), binary+" compose", dir, nil, "config"); err != nil {
		t.Fatal(err)
	}
	if after := ExecutionCounters(); after != before {
		t.Fatal("config must not count as build/save")
	}
	if _, err := buildComposeServices(context.Background(), binary+" compose", BuildOptions{WorkspaceDir: dir}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if after := ExecutionCounters(); after.ComposeBuildAttempts != before.ComposeBuildAttempts+1 || after.DockerSaveAttempts != before.DockerSaveAttempts {
		t.Fatalf("build attempt not observed: %+v -> %+v", before, after)
	}
	if err := NewHostDocker().Save(context.Background(), "fixture", filepath.Join(dir, "image.tar")); err != nil {
		t.Fatal(err)
	}
	after := ExecutionCounters()
	if after.ProcessIncarnation != before.ProcessIncarnation || after.ComposeBuildAttempts != before.ComposeBuildAttempts+1 || after.DockerSaveAttempts != before.DockerSaveAttempts+1 {
		t.Fatalf("save attempt not observed: %+v -> %+v", before, after)
	}
	// Failed execution attempts must count too: success-only counters could hide a
	// source build/save that failed before producing an image.
	t.Setenv("SAM_DOCKER_CLI_PATH", filepath.Join(dir, "missing"))
	if err := NewHostDocker().Save(context.Background(), "fixture", "unused"); err == nil {
		t.Fatal("expected exec failure")
	}
	if ExecutionCounters().DockerSaveAttempts != after.DockerSaveAttempts+1 {
		t.Fatal("failed save not observed")
	}
	if _, err := buildComposeServices(context.Background(), filepath.Join(dir, "missing"), BuildOptions{WorkspaceDir: dir}, nil, nil); err == nil {
		t.Fatal("expected build exec failure")
	}
	if ExecutionCounters().ComposeBuildAttempts != after.ComposeBuildAttempts+1 {
		t.Fatal("failed build not observed")
	}
}

func TestExecutionCountersConcurrentReadsDuringBuild(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "compose")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	before := ExecutionCounters()
	var readers sync.WaitGroup
	done := make(chan struct{})
	readers.Go(func() {
		for {
			select {
			case <-done:
				return
			default:
				_ = ExecutionCounters()
			}
		}
	})
	for range 8 {
		if _, err := buildComposeServices(context.Background(), binary, BuildOptions{WorkspaceDir: dir}, nil, nil); err != nil {
			close(done)
			readers.Wait()
			t.Fatal(err)
		}
	}
	close(done)
	readers.Wait()
	if ExecutionCounters().ComposeBuildAttempts != before.ComposeBuildAttempts+8 {
		t.Fatal("writer did not execute")
	}
}

func TestGenericComposeRefusesUncountedBuild(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "compose")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	before := ExecutionCounters()
	for _, args := range [][]string{{"build"}, {"build", "web"}, {"build", "--pull"}} {
		if _, err := runCompose(context.Background(), binary, dir, nil, args...); err == nil {
			t.Fatalf("uncounted build allowed: %v", args)
		}
	}
	if _, err := runCompose(context.Background(), binary+" build", dir, nil, "web"); err == nil {
		t.Fatal("embedded uncounted build allowed")
	}
	if after := ExecutionCounters(); after != before {
		t.Fatal("refused commands must not execute")
	}
}

func TestCountedComposeBuildIncludesTrailingServiceAndOptions(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "compose")
	script := "#!/bin/sh\n[ \"$1\" = --project-directory ] && [ \"$3\" = build ] && [ \"$4\" = --pull ] && [ \"$5\" = web ]\n"
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	before := ExecutionCounters()
	if _, err := runComposeBuild(context.Background(), binary, dir, nil, []string{"--project-directory", dir}, "--pull", "web"); err != nil {
		t.Fatal(err)
	}
	if after := ExecutionCounters(); after.ComposeBuildAttempts != before.ComposeBuildAttempts+1 || after.DockerSaveAttempts != before.DockerSaveAttempts {
		t.Fatalf("trailing service build not counted: %+v -> %+v", before, after)
	}
}
