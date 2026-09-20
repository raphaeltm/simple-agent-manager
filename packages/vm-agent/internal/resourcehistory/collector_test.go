package resourcehistory

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestResolveCgroupPathFindsDockerScopeAndReadsCounters(t *testing.T) {
	root := t.TempDir()
	containerID := "abcdef1234567890"
	path := filepath.Join(root, "system.slice", "docker-"+containerID+".scope")
	writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 123456\nuser_usec 1\n")
	writeFile(t, filepath.Join(path, "memory.current"), "4096\n")
	writeFile(t, filepath.Join(path, "memory.peak"), "8192\n")
	writeFile(t, filepath.Join(path, "io.stat"), "8:0 rbytes=100 wbytes=25 rios=1 wios=2\n8:16 rbytes=50 wbytes=75\n")
	writeFile(t, filepath.Join(path, "memory.events"), "oom 2\noom_kill 1\n")
	writeFile(t, filepath.Join(path, "pids.current"), "7\n")

	resolved, err := ResolveCgroupPath(context.Background(), root, t.TempDir(), containerID)
	if err != nil {
		t.Fatalf("ResolveCgroupPath: %v", err)
	}
	if resolved != path {
		t.Fatalf("resolved path = %q, want %q", resolved, path)
	}
	counters, err := readCgroupCounters(resolved)
	if err != nil {
		t.Fatalf("read counters: %v", err)
	}
	if counters.CPUUsageUsec != 123456 || counters.MemoryCurrent != 4096 || counters.MemoryPeak != 8192 {
		t.Fatalf("unexpected counters: %+v", counters)
	}
	if counters.IOReadBytes != 150 || counters.IOWriteBytes != 100 || counters.OOM != 2 || counters.OOMKill != 1 || counters.PidsCurrent != 7 {
		t.Fatalf("unexpected io/events counters: %+v", counters)
	}
}

func TestResolveCgroupPathFindsNestedSystemdScopeWithShortContainerID(t *testing.T) {
	root := t.TempDir()
	fullID := "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
	shortID := fullID[:12]
	path := filepath.Join(root, "system.slice", "docker-"+fullID+".scope")
	writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 123456\n")
	writeFile(t, filepath.Join(path, "memory.current"), "4096\n")

	resolved, err := ResolveCgroupPath(context.Background(), root, t.TempDir(), shortID)
	if err != nil {
		t.Fatalf("ResolveCgroupPath: %v", err)
	}
	if resolved != path {
		t.Fatalf("resolved path = %q, want %q", resolved, path)
	}
}

func TestCollectorRediscoverCgroupAfterCachedPathDisappears(t *testing.T) {
	root := t.TempDir()
	containerID := "abcdef1234567890"
	oldPath := filepath.Join(root, "docker", containerID)
	newPath := filepath.Join(root, "system.slice", "docker-"+containerID+".scope")
	writeFile(t, filepath.Join(oldPath, "cpu.stat"), "usage_usec 100000\n")
	writeFile(t, filepath.Join(oldPath, "memory.current"), "1000\n")
	writeFile(t, filepath.Join(oldPath, "memory.peak"), "1200\n")
	writeFile(t, filepath.Join(oldPath, "io.stat"), "8:0 rbytes=10 wbytes=20\n")
	writeFile(t, filepath.Join(oldPath, "memory.events"), "oom 0\noom_kill 0\n")
	writeFile(t, filepath.Join(oldPath, "pids.current"), "5\n")

	now := time.Unix(100, 0)
	collector := New(Config{
		ControlPlaneURL: "http://127.0.0.1",
		ProjectID:       "proj-1",
		WorkspaceID:     "ws-1",
		SampleInterval:  time.Second,
		ChunkInterval:   time.Hour,
		SpoolDir:        t.TempDir(),
		CgroupRoot:      root,
		ContainerID:     func(context.Context) (string, error) { return containerID, nil },
		Now:             func() time.Time { return now },
	})

	collector.sample(context.Background())
	if collector.cgroupPath != oldPath {
		t.Fatalf("initial cgroupPath = %q, want %q", collector.cgroupPath, oldPath)
	}
	if err := os.RemoveAll(oldPath); err != nil {
		t.Fatalf("remove old cgroup: %v", err)
	}
	writeFile(t, filepath.Join(newPath, "cpu.stat"), "usage_usec 175000\n")
	writeFile(t, filepath.Join(newPath, "memory.current"), "2000\n")
	writeFile(t, filepath.Join(newPath, "memory.peak"), "2500\n")
	writeFile(t, filepath.Join(newPath, "io.stat"), "8:0 rbytes=110 wbytes=220\n")
	writeFile(t, filepath.Join(newPath, "memory.events"), "oom 0\noom_kill 0\n")
	writeFile(t, filepath.Join(newPath, "pids.current"), "6\n")

	now = now.Add(time.Second)
	collector.sample(context.Background())
	if collector.cgroupPath != "" {
		t.Fatalf("cgroupPath after stale read = %q, want rediscovery reset", collector.cgroupPath)
	}
	now = now.Add(time.Second)
	collector.sample(context.Background())
	if collector.cgroupPath != newPath {
		t.Fatalf("rediscovered cgroupPath = %q, want %q", collector.cgroupPath, newPath)
	}
}

func TestCollectorUploadsCompressedChunkAndHashesToolIDs(t *testing.T) {
	var received uploadBody
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/api/projects/proj-1/workspace-resource-history" {
			t.Fatalf("path = %s", got)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer callback-token" {
			t.Fatalf("Authorization = %q", auth)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &received); err != nil {
			t.Fatalf("decode upload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	root := t.TempDir()
	containerID := "abcdef1234567890"
	path := filepath.Join(root, "docker", containerID)
	writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 100000\n")
	writeFile(t, filepath.Join(path, "memory.current"), "1000\n")
	writeFile(t, filepath.Join(path, "memory.peak"), "1200\n")
	writeFile(t, filepath.Join(path, "io.stat"), "8:0 rbytes=10 wbytes=20\n")
	writeFile(t, filepath.Join(path, "memory.events"), "oom 0\noom_kill 0\n")
	writeFile(t, filepath.Join(path, "pids.current"), "5\n")

	now := time.Unix(100, 0)
	collector := New(Config{
		ControlPlaneURL: server.URL,
		ProjectID:       "proj-1",
		WorkspaceID:     "ws-1",
		NodeID:          "node-1",
		SessionID:       "sess-1",
		TaskID:          "task-1",
		SampleInterval:  time.Second,
		ChunkInterval:   time.Hour,
		SpoolDir:        t.TempDir(),
		CgroupRoot:      root,
		ContainerID:     func(context.Context) (string, error) { return containerID, nil },
		CallbackToken:   func() string { return "callback-token" },
		Now:             func() time.Time { return now },
	})

	collector.sample(context.Background())
	now = now.Add(time.Second)
	writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 175000\n")
	writeFile(t, filepath.Join(path, "memory.current"), "2000\n")
	writeFile(t, filepath.Join(path, "memory.peak"), "2500\n")
	writeFile(t, filepath.Join(path, "io.stat"), "8:0 rbytes=110 wbytes=220\n")
	collector.RecordACPToolCall("secret-tool-id", "in_progress", now)
	collector.sample(context.Background())
	now = now.Add(time.Second)
	collector.RecordACPToolCall("secret-tool-id", "completed", now)
	collector.flush(context.Background(), true)

	if received.WorkspaceID != "ws-1" || received.SampleCount != 2 || received.ToolSpanCount != 1 {
		t.Fatalf("unexpected upload body: %+v", received)
	}
	if strings.Contains(string(mustJSON(t, received)), "secret-tool-id") {
		t.Fatalf("upload body leaked raw tool id: %+v", received)
	}
	if received.CompressedBytes == 0 || received.SHA256 == "" || received.StorageFormat != StorageFormat {
		t.Fatalf("missing compressed payload metadata: %+v", received)
	}
}

func TestCollectorRetrySpoolDropsPermanentClientErrorsAndContinues(t *testing.T) {
	var uploaded []int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var received uploadBody
		if err := json.Unmarshal(body, &received); err != nil {
			t.Fatalf("decode upload: %v", err)
		}
		if received.ChunkSequence == 0 {
			http.Error(w, "bad chunk", http.StatusBadRequest)
			return
		}
		uploaded = append(uploaded, received.ChunkSequence)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	spoolDir := t.TempDir()
	collector := New(Config{
		ControlPlaneURL: server.URL,
		ProjectID:       "proj-1",
		WorkspaceID:     "ws-1",
		SpoolDir:        spoolDir,
		CallbackToken:   func() string { return "callback-token" },
	})
	if err := collector.writeSpool(uploadBody{WorkspaceID: "ws-1", ChunkSequence: 0}); err != nil {
		t.Fatalf("write rejected spool: %v", err)
	}
	if err := collector.writeSpool(uploadBody{WorkspaceID: "ws-1", ChunkSequence: 1}); err != nil {
		t.Fatalf("write accepted spool: %v", err)
	}

	collector.retrySpool(context.Background())

	if len(uploaded) != 1 || uploaded[0] != 1 {
		t.Fatalf("uploaded sequences = %v, want [1]", uploaded)
	}
	if _, err := os.Stat(filepath.Join(spoolDir, "00000000000000000000.json")); !os.IsNotExist(err) {
		t.Fatalf("permanently rejected spool file still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(spoolDir, "00000000000000000001.json")); !os.IsNotExist(err) {
		t.Fatalf("uploaded spool file still exists: %v", err)
	}
}

func TestCollectorPersistsNextSequenceAcrossRestart(t *testing.T) {
	spoolDir := t.TempDir()
	now := time.Unix(10, 0)
	collector := New(Config{SpoolDir: spoolDir, Now: func() time.Time { return now }})
	collector.mu.Lock()
	collector.loadSequenceLocked()
	first := collector.sequence
	collector.sequence++
	collector.persistSequenceLocked()
	collector.mu.Unlock()

	restarted := New(Config{SpoolDir: spoolDir, Now: func() time.Time { return now }})
	restarted.mu.Lock()
	restarted.loadSequenceLocked()
	next := restarted.sequence
	restarted.mu.Unlock()

	if next != first+1 {
		t.Fatalf("restarted sequence = %d, want %d", next, first+1)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return data
}

func BenchmarkReadCgroupCounters(b *testing.B) {
	root := b.TempDir()
	path := filepath.Join(root, "docker", "abcdef123456")
	if err := os.MkdirAll(path, 0o700); err != nil {
		b.Fatal(err)
	}
	for name, body := range map[string]string{
		"cpu.stat":       "usage_usec 123456\nuser_usec 1\nsystem_usec 2\n",
		"memory.current": "4096\n",
		"memory.peak":    "8192\n",
		"io.stat":        "8:0 rbytes=100 wbytes=25 rios=1 wios=2\n8:16 rbytes=50 wbytes=75\n",
		"memory.events":  "oom 2\noom_kill 1\n",
		"pids.current":   "7\n",
	} {
		if err := os.WriteFile(filepath.Join(path, name), []byte(body), 0o600); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := readCgroupCounters(path); err != nil {
			b.Fatal(err)
		}
	}
}
