package errorreport

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readArchive(t *testing.T, path string) map[string][]byte {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	files := make(map[string][]byte)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(tarReader)
		if err != nil {
			t.Fatal(err)
		}
		files[header.Name] = data
	}
	return files
}

func TestSnapshotRecursivelyRedactsCanariesAndBoundsValues(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxStringBytes = 32
	cfg.MaxValueDepth = 4
	cfg.MaxValueItems = 64
	reporter := New("http://localhost", "node-1", "token", cfg)
	defer reporter.Shutdown()
	reporter.SetCollectors(CollectorFunc{
		CollectorName: "malicious",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return map[string]any{
				"authorization": "Bearer should-never-appear",
				"nested": map[string]any{
					"message": evidenceCanary,
					"long":    strings.Repeat("x", 256),
					"deeper":  map[string]any{"value": map[string]any{"tooDeep": true}},
				},
				"many":             []any{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
				"environmentValue": credentialCanaries[0],
				"processCommand":   credentialCanaries[1],
				"prompt":           credentialCanaries[2],
				"repositoryContent": []any{
					credentialCanaries[3], credentialCanaries[4], credentialCanaries[5],
				},
			}, nil
		},
	})
	entry := ErrorEntry{
		IncidentID: "01JTESTSNAPSHOT00000000000",
		Level:      "error", Source: "test", Timestamp: "2026-08-05T00:00:00Z",
	}
	path, manifestJSON, previewJSON, checksum, size, err := reporter.buildSnapshot(entry)
	if err != nil {
		t.Fatal(err)
	}
	if checksum == "" || size <= 0 {
		t.Fatalf("invalid archive metadata checksum=%q size=%d", checksum, size)
	}
	combined := manifestJSON + previewJSON
	files := readArchive(t, path)
	for name, data := range files {
		combined += string(data)
		if strings.Contains(string(data), evidenceCanary) || strings.Contains(string(data), "should-never-appear") {
			t.Fatalf("canary leaked in %s", name)
		}
	}
	if strings.Contains(combined, evidenceCanary) || !strings.Contains(combined, "[REDACTED]") {
		t.Fatalf("unexpected sanitized evidence: %s", combined)
	}
	for _, canary := range credentialCanaries {
		if strings.Contains(combined, canary) {
			t.Fatalf("credential canary leaked: %s", canary)
		}
	}
	var manifest SnapshotManifest
	if err := json.Unmarshal([]byte(manifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Redactions < 2 || !manifest.AnyTruncated {
		t.Fatalf("expected redaction and truncation accounting: %#v", manifest)
	}
	if info, err := os.Stat(cfg.SpoolDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("spool mode=%v err=%v", info.Mode().Perm(), err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("artifact mode=%v err=%v", info.Mode().Perm(), err)
	}
}

func TestSnapshotManifestPreservesPartialCollectorFailure(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	reporter.SetCollectors(
		CollectorFunc{CollectorName: "healthy", CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return map[string]any{"status": "ok"}, nil
		}},
		CollectorFunc{CollectorName: "failed", CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return nil, errors.New(evidenceCanary)
		}},
	)
	entry := ErrorEntry{IncidentID: "01JTESTPARTIAL000000000000", Level: "error", Source: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano)}
	path, manifestJSON, _, _, _, err := reporter.buildSnapshot(entry)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(manifestJSON, evidenceCanary) {
		t.Fatal("collector error detail leaked into the manifest")
	}
	var manifest SnapshotManifest
	if err := json.Unmarshal([]byte(manifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Collectors) != 3 || manifest.Collectors[2].Status != "failed" || manifest.Collectors[2].Error != "collector failed" {
		t.Fatalf("unexpected partial manifest: %#v", manifest.Collectors)
	}
	files := readArchive(t, path)
	if _, ok := files["collectors/healthy.json"]; !ok {
		t.Fatal("healthy collector was omitted after another collector failed")
	}
}

func TestPendingSnapshotRecoversAfterRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(dir, "outbox.db")
	cfg.SpoolDir = filepath.Join(dir, "spool")
	first := New("http://localhost", "node-1", "", cfg)
	entry := ErrorEntry{
		IncidentID: "01JTESTRESTART00000000000", Level: "error", Message: "failure",
		Source: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := first.insertEntry(entry, "{}"); err != nil {
		t.Fatal(err)
	}
	first.Shutdown()

	second := New("http://localhost", "node-1", "", cfg)
	second.SetCollectors(CollectorFunc{
		CollectorName: "configured-before-start",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return map[string]any{"configured": true}, nil
		},
	})
	second.Start()
	defer second.Shutdown()
	waitFor(t, func() bool {
		var state string
		_ = second.db.QueryRow(`SELECT artifact_state FROM error_report_outbox WHERE incident_id = ?`, entry.IncidentID).Scan(&state)
		return state == "ready"
	})
	if _, err := os.Stat(filepath.Join(cfg.SpoolDir, entry.IncidentID+".tar.gz")); err != nil {
		t.Fatalf("restart did not create deterministic archive: %v", err)
	}
	files := readArchive(t, filepath.Join(cfg.SpoolDir, entry.IncidentID+".tar.gz"))
	if _, ok := files["collectors/configured-before-start.json"]; !ok {
		t.Fatal("restart recovery ran before production collectors were configured")
	}
}

func TestStartupCleanupDoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	spool := filepath.Join(dir, "spool")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(dir, "external-secret")
	if err := os.WriteFile(external, []byte(evidenceCanary), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(spool, "linked.tar.gz")); err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(spool, "01J00000000000000000000001.tar.gz")
	partial := filepath.Join(spool, ".incident-01J00000000000000000000002.tmp")
	sentinel := filepath.Join(spool, "state.db")
	if err := os.WriteFile(orphan, []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sentinel, []byte("unrelated state"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(dir, "outbox.db")
	cfg.SpoolDir = spool
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphan archive was not removed: %v", err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatalf("partial archive was not removed: %v", err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "unrelated state" {
		t.Fatalf("unrelated spool sentinel changed: data=%q err=%v", data, err)
	}
	data, err := os.ReadFile(external)
	if err != nil || string(data) != evidenceCanary {
		t.Fatalf("cleanup followed the symlink: data=%q err=%v", data, err)
	}
}

func TestStartupRejectsSpoolContainingOutbox(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(t)
	cfg.SpoolDir = dir
	cfg.DBPath = filepath.Join(dir, "error-reports.db")
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	if err := reporter.InitError(); err == nil || !strings.Contains(err.Error(), "must not contain") {
		t.Fatalf("expected spool/outbox overlap rejection, got %v", err)
	}
	if _, err := os.Stat(cfg.DBPath); !os.IsNotExist(err) {
		t.Fatalf("overlap validation created the outbox before rejecting it: %v", err)
	}
}

func TestStartupDoesNotChmodPreexistingSharedSpool(t *testing.T) {
	spool := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(spool, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.SpoolDir = spool
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	if err := reporter.InitError(); err == nil || !strings.Contains(err.Error(), "group or others") {
		t.Fatalf("expected unsafe shared spool rejection, got %v", err)
	}
	if info, err := os.Stat(spool); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("shared spool mode=%v err=%v", info.Mode().Perm(), err)
	}
}

func TestStartupRejectsSymlinkedSpoolRoot(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "external")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(target, "protected.tar.gz")
	if err := os.WriteFile(protected, []byte(evidenceCanary), 0o600); err != nil {
		t.Fatal(err)
	}
	spool := filepath.Join(dir, "spool-link")
	if err := os.Symlink(target, spool); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(dir, "outbox", "errors.db")
	cfg.SpoolDir = spool
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	if reporter.InitError() == nil || !strings.Contains(reporter.InitError().Error(), "symlink") {
		t.Fatalf("expected symlink-root rejection, got %v", reporter.InitError())
	}
	if data, err := os.ReadFile(protected); err != nil || string(data) != evidenceCanary {
		t.Fatalf("symlink target was modified: data=%q err=%v", data, err)
	}
}

func TestCollectorTimeoutBoundsBacklogAndShutdown(t *testing.T) {
	cfg := testConfig(t)
	cfg.CollectorTimeout = 40 * time.Millisecond
	reporter := New("http://localhost", "node-1", "", cfg)
	blocked := make(chan struct{})
	reporter.SetCollectors(CollectorFunc{
		CollectorName: "ignores-cancellation",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			<-blocked
			return map[string]any{"late": true}, nil
		},
	})
	reporter.Start()
	for index := 0; index < 20; index++ {
		reporter.Report(ErrorEntry{Level: "error", Message: "failure", Source: "test"})
	}
	started := time.Now()
	reporter.Shutdown()
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("shutdown exceeded bounded collector window: %s", elapsed)
	}
	close(blocked)
}

func TestSnapshotEnforcesArtifactAndSpoolQuotas(t *testing.T) {
	cfg := testConfig(t)
	cfg.ArtifactMaxBytes = 32
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	entry := ErrorEntry{IncidentID: "01JTESTOVERSIZE0000000000", Level: "error", Source: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano)}
	if _, _, _, _, _, err := reporter.buildSnapshot(entry); err == nil || !strings.Contains(err.Error(), "artifact exceeds") {
		t.Fatalf("expected compressed artifact limit error, got %v", err)
	}

	cfg2 := testConfig(t)
	cfg2.SpoolMaxBytes = 1024
	reporter2 := New("http://localhost", "node-1", "", cfg2)
	defer reporter2.Shutdown()
	if err := os.WriteFile(
		filepath.Join(cfg2.SpoolDir, "occupied.tar.gz"),
		make([]byte, cfg2.SpoolMaxBytes-16),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, _, err := reporter2.buildSnapshot(entry); err == nil || !strings.Contains(err.Error(), "artifact exceeds") {
		t.Fatalf("expected remaining-spool quota error, got %v", err)
	}
	entries, err := os.ReadDir(cfg2.SpoolDir)
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, item := range entries {
		info, statErr := item.Info()
		if statErr != nil {
			t.Fatal(statErr)
		}
		total += info.Size()
	}
	if total > cfg2.SpoolMaxBytes {
		t.Fatalf("spool quota exceeded: %d > %d", total, cfg2.SpoolMaxBytes)
	}
}
