package resourcehistory

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
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
	writeFile(t, filepath.Join(path, "memory.stat"), "anon 1024\nfile 3072\ninactive_anon 256\nactive_anon 768\ninactive_file 3072\nactive_file 0\nslab 128\n")
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
	if counters.MemoryWorkingSet == nil || *counters.MemoryWorkingSet != 1024 {
		t.Fatalf("working set = %v, want 1024", counters.MemoryWorkingSet)
	}
	if counters.IOReadBytes != 150 || counters.IOWriteBytes != 100 || counters.OOM != 2 || counters.OOMKill != 1 || counters.PidsCurrent != 7 {
		t.Fatalf("unexpected io/events counters: %+v", counters)
	}
}

func TestReadCgroupCountersWorkingSetMemory(t *testing.T) {
	const gib = uint64(1024 * 1024 * 1024)
	tests := []struct {
		name       string
		current    uint64
		memoryStat *string
		want       *uint64
	}{
		{
			name:       "large page cache",
			current:    8 * gib,
			memoryStat: stringPtr("anon 1610612736\nfile 6442450944\nkernel 536870912\ninactive_anon 268435456\nactive_anon 1342177280\ninactive_file 6442450944\nactive_file 0\nslab 268435456\n"),
			want:       uint64Ptr(2 * gib),
		},
		{
			name:       "inactive file clamps at zero",
			current:    2 * gib,
			memoryStat: stringPtr("anon 536870912\nfile 3221225472\ninactive_file 3221225472\n"),
			want:       uint64Ptr(0),
		},
		{name: "missing memory stat", current: 2 * gib, want: nil},
		{
			name:       "unparseable inactive file",
			current:    2 * gib,
			memoryStat: stringPtr("anon 536870912\ninactive_file not-a-number\nfile 1610612736\n"),
			want:       nil,
		},
		{
			name:       "missing inactive file key",
			current:    2 * gib,
			memoryStat: stringPtr("anon 536870912\nfile 1610612736\n"),
			want:       nil,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := t.TempDir()
			writeFile(t, filepath.Join(path, "cpu.stat"), "usage_usec 1\n")
			writeFile(t, filepath.Join(path, "memory.current"), strconv.FormatUint(test.current, 10)+"\n")
			if test.memoryStat != nil {
				writeFile(t, filepath.Join(path, "memory.stat"), *test.memoryStat)
			}

			counters, err := readCgroupCounters(path)
			if err != nil {
				t.Fatalf("readCgroupCounters: %v", err)
			}
			if test.want == nil {
				if counters.MemoryWorkingSet != nil {
					t.Fatalf("working set = %d, want unknown", *counters.MemoryWorkingSet)
				}
				return
			}
			if counters.MemoryWorkingSet == nil || *counters.MemoryWorkingSet != *test.want {
				t.Fatalf("working set = %v, want %d", counters.MemoryWorkingSet, *test.want)
			}
		})
	}
}

func stringPtr(value string) *string { return &value }

func uint64Ptr(value uint64) *uint64 { return &value }

func TestSummarizeWorkingSetUsesOnlyKnownSamples(t *testing.T) {
	known := uint64(768)
	summary := summarize([]Sample{
		{T: 1, MemoryBytes: 4096},
		{T: 2, MemoryBytes: 4096, MemoryWorkingSetBytes: &known},
	}, 5*time.Second)

	if summary.MemoryWorkingSetMeanBytes == nil || *summary.MemoryWorkingSetMeanBytes != known {
		t.Fatalf("working-set mean = %v, want %d", summary.MemoryWorkingSetMeanBytes, known)
	}
	if summary.MemoryWorkingSetPeakBytes == nil || *summary.MemoryWorkingSetPeakBytes != known {
		t.Fatalf("working-set peak = %v, want %d", summary.MemoryWorkingSetPeakBytes, known)
	}
	if summary.MemoryWorkingSetSampleCount != 1 {
		t.Fatalf("working-set sample count = %d, want 1", summary.MemoryWorkingSetSampleCount)
	}

	encoded, err := json.Marshal(Sample{T: 1, MemoryBytes: 4096})
	if err != nil {
		t.Fatalf("marshal unknown working set: %v", err)
	}
	if strings.Contains(string(encoded), "memoryWorkingSetBytes") {
		t.Fatalf("unknown working set must be omitted, got %s", encoded)
	}
}

func TestSummarizeOmitsWorkingSetWhenAllSamplesAreUnknown(t *testing.T) {
	summary := summarize([]Sample{{T: 1, MemoryBytes: 4096}}, 5*time.Second)
	if summary.MemoryWorkingSetMeanBytes != nil || summary.MemoryWorkingSetPeakBytes != nil {
		t.Fatalf("working-set summary = mean %v peak %v, want unknown", summary.MemoryWorkingSetMeanBytes, summary.MemoryWorkingSetPeakBytes)
	}
	if summary.MemoryWorkingSetSampleCount != 0 {
		t.Fatalf("working-set sample count = %d, want 0", summary.MemoryWorkingSetSampleCount)
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
	writeFile(t, filepath.Join(path, "memory.stat"), "anon 600\nfile 400\ninactive_file 300\n")
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
	writeFile(t, filepath.Join(path, "memory.stat"), "anon 900\nfile 1100\ninactive_file 800\n")
	writeFile(t, filepath.Join(path, "io.stat"), "8:0 rbytes=110 wbytes=220\n")
	collector.RecordACPToolCall("secret-tool-id", "in_progress", "execute", "Bash", now)
	collector.sample(context.Background())
	now = now.Add(time.Second)
	collector.RecordACPToolCall("secret-tool-id", "completed", "", "", now)
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
	if received.Summary.MemoryWorkingSetMeanBytes == nil || *received.Summary.MemoryWorkingSetMeanBytes != 950 {
		t.Fatalf("working-set mean = %v, want 950", received.Summary.MemoryWorkingSetMeanBytes)
	}
	if received.Summary.MemoryWorkingSetPeakBytes == nil || *received.Summary.MemoryWorkingSetPeakBytes != 1200 {
		t.Fatalf("working-set peak = %v, want 1200", received.Summary.MemoryWorkingSetPeakBytes)
	}
	if received.Summary.MemoryWorkingSetSampleCount != 2 {
		t.Fatalf("working-set sample count = %d, want 2", received.Summary.MemoryWorkingSetSampleCount)
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
		"memory.stat":    "anon 1024\nfile 3072\ninactive_file 3072\n",
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

func TestConcurrentSpoolRetriesUploadOnce(t *testing.T) {
	for _, separate := range []bool{false, true} {
		t.Run(strconv.FormatBool(separate), func(t *testing.T) {
			entered := make(chan struct{}, 2)
			release := make(chan struct{})
			var uploads atomic.Int32
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				uploads.Add(1)
				entered <- struct{}{}
				<-release
				w.WriteHeader(http.StatusOK)
			}))
			defer httpServer.Close()
			cfg := Config{ControlPlaneURL: httpServer.URL, ProjectID: "project-1", WorkspaceID: "workspace-1",
				SpoolDir: t.TempDir(), CallbackToken: func() string { return "test-token" }, UploadTimeout: time.Second}
			collector := New(cfg)
			collector.samples = []Sample{{T: 1, CPUMillis: 1}}
			body, ok := collector.buildUpload(true)
			if !ok {
				t.Fatal("final upload missing")
			}
			if err := collector.writeSpool(body); err != nil {
				t.Fatal(err)
			}
			firstDone := make(chan struct{})
			go func() { collector.retrySpool(context.Background()); close(firstDone) }()
			<-entered
			secondDone := make(chan struct{})
			other := collector
			if separate {
				other = New(cfg)
			}
			go func() { other.retrySpool(context.Background()); close(secondDone) }()
			select {
			case <-entered:
				close(release)
				<-firstDone
				<-secondDone
				t.Fatal("same spool file uploaded concurrently")
			case <-time.After(50 * time.Millisecond):
			}
			close(release)
			<-firstDone
			<-secondDone
			if uploads.Load() != 1 {
				t.Fatalf("uploads = %d", uploads.Load())
			}
			assertSpoolDrained(t, cfg.SpoolDir)
		})
	}
}

func assertSpoolDrained(t *testing.T, dir string) {
	t.Helper()
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("spool read failed: %v", err)
	}
	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".json") {
			t.Fatalf("spool not drained: %v", files)
		}
	}
}

func TestStartAfterStopDoesNotRestartCollector(t *testing.T) {
	collector := New(Config{ControlPlaneURL: "http://unused", ProjectID: "project-1", WorkspaceID: "workspace-1",
		SpoolDir: t.TempDir(), CallbackToken: func() string { return "" }})
	collector.Stop(context.Background())
	collector.Start(context.Background())
	if collector.started {
		t.Fatal("closed collector restarted")
	}
}

func TestStopJoinsSamplerAndConcurrentFinalFlush(t *testing.T) {
	sampling := make(chan struct{})
	uploaded := make(chan struct{})
	releaseUpload := make(chan struct{})
	var calls atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(uploaded)
		<-releaseUpload
		w.WriteHeader(http.StatusOK)
	}))
	defer api.Close()
	collector := New(Config{ControlPlaneURL: api.URL, ProjectID: "project-1", WorkspaceID: "workspace-1",
		SpoolDir: t.TempDir(), CallbackToken: func() string { return "token" }, SampleInterval: time.Hour,
		ContainerID: func(ctx context.Context) (string, error) { close(sampling); <-ctx.Done(); return "", ctx.Err() },
	})
	collector.Start(context.Background())
	<-sampling
	first := make(chan struct{})
	go func() { collector.Stop(context.Background()); close(first) }()
	<-uploaded
	second := make(chan struct{})
	go func() { collector.Stop(context.Background()); close(second) }()
	select {
	case <-second:
		close(releaseUpload)
		<-first
		t.Fatal("concurrent Stop returned before final flush")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseUpload)
	<-first
	<-second
	if calls.Load() != 1 {
		t.Fatalf("uploads = %d", calls.Load())
	}
	collector.mu.Lock()
	defer collector.mu.Unlock()
	if len(collector.samples) != 0 {
		t.Fatal("sampler left data after final flush")
	}
}
