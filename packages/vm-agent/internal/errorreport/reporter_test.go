package errorreport

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	return Config{
		DBPath:        filepath.Join(dir, "errors.db"),
		SpoolDir:      filepath.Join(dir, "evidence"),
		FlushInterval: time.Hour,
		MaxBatchSize:  100,
		MaxQueueSize:  50,
		HTTPTimeout:   time.Second,
		RetryInitial:  time.Millisecond,
		RetryMax:      5 * time.Millisecond,
	}
}

func readEntries(t *testing.T, reporter *Reporter) []ErrorEntry {
	t.Helper()
	rows, err := reporter.db.Query(`SELECT incident_id, level, message, source, stack,
		workspace_id, timestamp, context_json FROM error_report_outbox ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var entries []ErrorEntry
	for rows.Next() {
		var entry ErrorEntry
		var contextJSON string
		if err := rows.Scan(&entry.IncidentID, &entry.Level, &entry.Message, &entry.Source,
			&entry.Stack, &entry.WorkspaceID, &entry.Timestamp, &contextJSON); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal([]byte(contextJSON), &entry.Context)
		entries = append(entries, entry)
	}
	return entries
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not satisfied before timeout")
}

func TestNilReporterSafe(t *testing.T) {
	var reporter *Reporter
	reporter.Start()
	reporter.Report(ErrorEntry{Message: "test"})
	reporter.ReportError(fmt.Errorf("test"), "source", "ws-1", nil)
	reporter.ReportInfo("test", "source", "ws-1", nil)
	reporter.ReportWarn("test", "source", "ws-1", nil)
	reporter.SetToken("token")
	reporter.Shutdown()
}

func TestReportDurablyQueuesBoundedEntries(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxQueueSize = 3
	reporter := New("http://localhost", "node-1", "token", cfg)
	defer reporter.Shutdown()

	for index := 0; index < 4; index++ {
		reporter.Report(ErrorEntry{Level: "info", Message: fmt.Sprintf("entry-%d", index), Source: "test"})
	}
	if got := reporter.pendingCount(); got != 3 {
		t.Fatalf("expected three bounded rows, got %d", got)
	}
}

func TestReportAssignsMonotonicULIDsAndPreservesCallerID(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	defer reporter.Shutdown()

	first := reporter.Report(ErrorEntry{Level: "info", Message: "first", Source: "test"})
	second := reporter.Report(ErrorEntry{Level: "info", Message: "second", Source: "test"})
	explicit := "01J00000000000000000000000"
	third := reporter.Report(ErrorEntry{IncidentID: explicit, Level: "warn", Message: "third", Source: "test"})
	if len(first) != 26 || len(second) != 26 || first >= second {
		t.Fatalf("expected ordered 26-character ULIDs, got %q then %q", first, second)
	}
	if third != explicit {
		t.Fatalf("expected caller incident ID %q, got %q", explicit, third)
	}
}

func TestMonotonicULIDSurvivesClockRegressionAndConcurrency(t *testing.T) {
	var generator monotonicULID
	forward := generator.next(time.UnixMilli(2000))
	regressed := generator.next(time.UnixMilli(1000))
	if regressed <= forward {
		t.Fatalf("clock regression broke monotonic order: %q then %q", forward, regressed)
	}
	const count = 100
	ids := make(chan string, count)
	var workers sync.WaitGroup
	for index := 0; index < count; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ids <- generator.next(time.UnixMilli(1500))
		}()
	}
	workers.Wait()
	close(ids)
	ordered := make([]string, 0, count)
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	for index := 1; index < len(ordered); index++ {
		if ordered[index] <= ordered[index-1] {
			t.Fatalf("ULIDs were not unique and ordered: %q then %q", ordered[index-1], ordered[index])
		}
	}
}

func TestReportEnrichesAndPreservesTimestamp(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	explicit := "2026-01-01T00:00:00Z"
	reporter.Report(ErrorEntry{Level: "info", Message: "generated", Source: "test"})
	reporter.Report(ErrorEntry{Level: "info", Message: "explicit", Source: "test", Timestamp: explicit})
	entries := readEntries(t, reporter)
	if entries[0].Timestamp == "" || entries[1].Timestamp != explicit {
		t.Fatalf("unexpected timestamps: %#v", entries)
	}
}

func TestStartFlushesStructuredRowsAndIncludesAuth(t *testing.T) {
	var mu sync.Mutex
	var received []ErrorEntry
	var auth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/nodes/node-42/errors" {
			http.NotFound(w, request)
			return
		}
		body, _ := io.ReadAll(request.Body)
		var payload struct {
			Errors []ErrorEntry `json:"errors"`
		}
		_ = json.Unmarshal(body, &payload)
		mu.Lock()
		received = append(received, payload.Errors...)
		auth = request.Header.Get("Authorization")
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	reporter := New(server.URL, "node-42", "callback-token", testConfig(t))
	reporter.ReportInfo("one", "test", "", nil)
	reporter.ReportWarn("two", "test", "", nil)
	reporter.Start()
	defer reporter.Shutdown()
	waitFor(t, func() bool { return reporter.pendingCount() == 0 })

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 || auth != "Bearer callback-token" {
		t.Fatalf("received=%d auth=%q", len(received), auth)
	}
	for _, entry := range received {
		if entry.IncidentID == "" {
			t.Fatal("structured error omitted incidentId")
		}
	}
}

func TestErrorDeliveryRegistersAndUploadsOnlyRedactedAutomaticEvidence(t *testing.T) {
	const canary = "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var mu sync.Mutex
	var structuredBody, registrationBody, uploadedArchive []byte
	var uploadedChecksum, authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		mu.Lock()
		defer mu.Unlock()
		authorization = request.Header.Get("Authorization")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/nodes/node-safe/errors":
			structuredBody = body
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && bytes.HasSuffix([]byte(request.URL.Path), []byte("/artifacts")):
			registrationBody = body
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"status":"pending"}`))
		case request.Method == http.MethodPut && bytes.HasSuffix([]byte(request.URL.Path), []byte("/content")):
			uploadedArchive = body
			uploadedChecksum = request.Header.Get("X-Content-SHA256")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	reporter := New(server.URL, "node-safe", "callback-token", testConfig(t))
	reporter.SetCollectors(CollectorFunc{
		CollectorName: "safe-health",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			return map[string]any{
				"status": "degraded",
				"nested": map[string]any{
					"authorization": "Bearer " + canary,
					"detail":        canary,
				},
			}, nil
		},
	})
	incidentID := reporter.Report(ErrorEntry{
		Level: "error", Message: "provider failed " + canary, Source: "session-host",
		WorkspaceID: "workspace-1",
		Context:     map[string]interface{}{"token": canary, "phase": "start"},
	})
	waitFor(t, func() bool {
		var state string
		return reporter.db.QueryRow(
			"SELECT artifact_state FROM error_report_outbox WHERE incident_id = ?", incidentID,
		).Scan(&state) == nil && state == "ready"
	})
	reporter.flush()
	if reporter.pendingCount() != 0 {
		t.Fatal("row was not deleted after both structured and artifact acknowledgements")
	}
	reporter.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if authorization != "Bearer callback-token" {
		t.Fatalf("unexpected authorization header %q", authorization)
	}
	if len(structuredBody) == 0 || len(registrationBody) == 0 || len(uploadedArchive) == 0 {
		t.Fatalf("missing delivery stage: structured=%d registration=%d archive=%d",
			len(structuredBody), len(registrationBody), len(uploadedArchive))
	}
	for name, value := range map[string][]byte{
		"structured report": structuredBody,
		"registration":      registrationBody,
		"expanded archive":  expandArchive(t, uploadedArchive),
	} {
		if bytes.Contains(value, []byte(canary)) {
			t.Fatalf("%s contained the canary secret", name)
		}
	}
	if !bytes.Contains(structuredBody, []byte(incidentID)) ||
		!bytes.Contains(registrationBody, []byte(incidentID)) {
		t.Fatal("stable incident ID was not preserved across delivery stages")
	}
	if !bytes.Contains(registrationBody, []byte(`"redactions":2`)) {
		t.Fatalf("registration omitted redaction accounting: %s", registrationBody)
	}
	if len(uploadedChecksum) != 64 {
		t.Fatalf("upload omitted the SHA-256 header: %q", uploadedChecksum)
	}
}

func expandArchive(t *testing.T, compressed []byte) []byte {
	t.Helper()
	gzipReader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	var expanded bytes.Buffer
	for {
		_, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(&expanded, tarReader); err != nil {
			t.Fatal(err)
		}
	}
	return expanded.Bytes()
}

func TestShutdownFlushesRemainingAndIsIdempotent(t *testing.T) {
	var received int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var payload struct {
			Errors []ErrorEntry `json:"errors"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		received += len(payload.Errors)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	reporter := New(server.URL, "node-1", "token", testConfig(t))
	reporter.ReportInfo("remaining", "test", "", nil)
	reporter.Shutdown()
	reporter.Shutdown()
	if received != 1 {
		t.Fatalf("expected final flush, received %d", received)
	}
}

func TestConcurrentStartShutdownAndReportIsRaceSafe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	for iteration := 0; iteration < 25; iteration++ {
		reporter := New(server.URL, "node-race", "token", testConfig(t))
		var workers sync.WaitGroup
		workers.Add(3)
		go func() { defer workers.Done(); reporter.Start() }()
		go func() { defer workers.Done(); reporter.ReportInfo("race", "test", "", nil) }()
		go func() { defer workers.Done(); reporter.Shutdown() }()
		workers.Wait()
		reporter.Shutdown()
		reporter.Start()
		if reporter.Report(ErrorEntry{Level: "info", Message: "closed", Source: "test"}) != "" {
			t.Fatal("closed reporter accepted a new durable row")
		}
	}
}

func TestMissingReadyArtifactRegistersFailedBeforeAnyUpload(t *testing.T) {
	var registration map[string]any
	var putCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPost:
			_ = json.NewDecoder(request.Body).Decode(&registration)
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			putCount++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	reporter := New(server.URL, "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	entry := ErrorEntry{
		IncidentID: "01JTESTMISSINGREADY00000000", Level: "error", Message: "failure",
		Source: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := reporter.insertEntry(entry, "{}"); err != nil {
		t.Fatal(err)
	}
	if err := reporter.markSnapshotReady(
		entry.IncidentID,
		filepath.Join(reporter.config.SpoolDir, entry.IncidentID+".tar.gz"),
		`{"version":1}`,
		`{}`,
		strings.Repeat("a", 64),
		10,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := reporter.db.Exec(
		"UPDATE error_report_outbox SET report_ack = 1 WHERE incident_id = ?",
		entry.IncidentID,
	); err != nil {
		t.Fatal(err)
	}
	if err := reporter.flushArtifacts(); err != nil {
		t.Fatal(err)
	}
	if registration["status"] != "failed" || putCount != 0 {
		t.Fatalf("registration=%#v putCount=%d", registration, putCount)
	}
	var state string
	if err := reporter.db.QueryRow(
		"SELECT artifact_state FROM error_report_outbox WHERE incident_id = ?",
		entry.IncidentID,
	).Scan(&state); err != nil || state != "failed" {
		t.Fatalf("artifact state=%q err=%v", state, err)
	}
}

func TestOutboxAndWALFilesArePrivate(t *testing.T) {
	cfg := testConfig(t)
	reporter := New("http://localhost", "node-1", "token", cfg)
	defer reporter.Shutdown()
	if info, err := os.Stat(filepath.Dir(cfg.DBPath)); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("outbox directory mode=%v err=%v", info.Mode().Perm(), err)
	}
	for _, path := range []string{cfg.DBPath, cfg.DBPath + "-wal", cfg.DBPath + "-shm"} {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("outbox file %s mode=%v err=%v", path, info.Mode().Perm(), err)
		}
	}
}

func TestTransientFailureSurvivesRestartAndTokenRefresh(t *testing.T) {
	var mu sync.Mutex
	var statuses = []int{http.StatusServiceUnavailable, http.StatusNoContent}
	var authHeaders []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		mu.Lock()
		authHeaders = append(authHeaders, request.Header.Get("Authorization"))
		status := statuses[0]
		statuses = statuses[1:]
		mu.Unlock()
		w.WriteHeader(status)
	}))
	defer server.Close()

	dir := t.TempDir()
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(dir, "durable-errors.db")
	cfg.SpoolDir = filepath.Join(dir, "evidence")
	first := New(server.URL, "node-1", "expired-token", cfg)
	first.ReportInfo("survives", "test", "", nil)
	first.flush()
	if first.pendingCount() != 1 {
		t.Fatal("transient failure deleted the durable row")
	}
	// Simulate an abrupt process loss. Graceful Shutdown intentionally performs
	// one final delivery attempt and is covered separately.
	first.closed.Store(true)
	if err := first.db.Close(); err != nil {
		t.Fatal(err)
	}

	second := New(server.URL, "node-1", "", cfg)
	second.SetToken("fresh-token")
	time.Sleep(2 * time.Millisecond)
	second.flush()
	if second.pendingCount() != 0 {
		t.Fatal("restarted reporter did not acknowledge the retained row")
	}
	second.Shutdown()
	mu.Lock()
	defer mu.Unlock()
	if len(authHeaders) != 2 || authHeaders[0] != "Bearer expired-token" || authHeaders[1] != "Bearer fresh-token" {
		t.Fatalf("unexpected authorization sequence: %#v", authHeaders)
	}
}

func TestErrorInfoAndWarnFieldsPersist(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	reporter.ReportError(fmt.Errorf("something broke"), "acp-gateway", "ws-123", map[string]interface{}{"step": "agent_start"})
	reporter.ReportInfo("agent started", "acp-gateway", "ws-abc", nil)
	reporter.ReportWarn("load failed", "acp-gateway", "ws-xyz", map[string]interface{}{"reason": "not found"})
	entries := readEntries(t, reporter)
	if len(entries) != 3 {
		t.Fatalf("expected three entries, got %d", len(entries))
	}
	if entries[0].Level != "error" || entries[0].Message != "something broke" || entries[0].Context["step"] != "agent_start" {
		t.Fatalf("unexpected error entry: %#v", entries[0])
	}
	if entries[1].Level != "info" || entries[2].Level != "warn" {
		t.Fatalf("unexpected lifecycle levels: %#v", entries)
	}
	var artifactRequired int
	if err := reporter.db.QueryRow(`SELECT SUM(artifact_required) FROM error_report_outbox`).Scan(&artifactRequired); err != nil {
		t.Fatal(err)
	}
	if artifactRequired != 1 {
		t.Fatalf("expected evidence only for the error row, got %d", artifactRequired)
	}
}

func TestDefaultConfig(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", Config{})
	defer reporter.Shutdown()
	if reporter.config.FlushInterval != DefaultFlushInterval || reporter.config.MaxBatchSize != DefaultMaxBatchSize {
		t.Fatalf("unexpected batch defaults: %#v", reporter.config)
	}
	if reporter.config.MaxQueueSize != DefaultMaxQueueSize || reporter.config.HTTPTimeout != DefaultHTTPTimeout {
		t.Fatalf("unexpected transport defaults: %#v", reporter.config)
	}
	if reporter.config.ArtifactMaxBytes != DefaultArtifactMaxBytes || reporter.config.SpoolMaxBytes != DefaultSpoolMaxBytes {
		t.Fatalf("unexpected evidence defaults: %#v", reporter.config)
	}
}
