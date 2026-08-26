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
	var mu sync.Mutex
	var structuredBody, registrationBody, uploadedArchive, capturedRequestLog []byte
	var uploadedChecksum, authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		mu.Lock()
		defer mu.Unlock()
		capturedRequestLog = append(capturedRequestLog, []byte(fmt.Sprintf(
			"%s %s content-type=%s checksum=%s body=%s\n",
			request.Method,
			request.URL.Path,
			request.Header.Get("Content-Type"),
			request.Header.Get("X-Content-SHA256"),
			body,
		))...)
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
					"authorization": strings.Join(credentialCanaries, " "),
					"details":       credentialCanaries,
				},
			}, nil
		},
	})
	reporter.Start()
	incidentID := reporter.Report(ErrorEntry{
		Level: "error", Message: "provider failed " + strings.Join(credentialCanaries, " "), Source: "session-host",
		WorkspaceID: "workspace-1",
		Context:     map[string]interface{}{"token": credentialCanaries, "phase": "start"},
	})
	waitFor(t, func() bool { return reporter.pendingCount() == 0 })
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
		"structured report":    structuredBody,
		"registration":         registrationBody,
		"expanded archive":     expandArchive(t, uploadedArchive),
		"captured request log": capturedRequestLog,
	} {
		for _, canary := range credentialCanaries {
			if bytes.Contains(value, []byte(canary)) {
				t.Fatalf("%s contained canary secret %q", name, canary)
			}
		}
	}
	if !bytes.Contains(structuredBody, []byte(incidentID)) ||
		!bytes.Contains(registrationBody, []byte(incidentID)) {
		t.Fatal("stable incident ID was not preserved across delivery stages")
	}
	var registration struct {
		Manifest SnapshotManifest `json:"manifest"`
	}
	if err := json.Unmarshal(registrationBody, &registration); err != nil {
		t.Fatal(err)
	}
	if registration.Manifest.Redactions < len(credentialCanaries) {
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

func TestArtifactRegistrationConflictIsRetriedWithoutUploading(t *testing.T) {
	var putCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/errors"):
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/artifacts"):
			http.Error(w, "Diagnostic artifact quota exceeded", http.StatusConflict)
		case request.Method == http.MethodPut:
			putCount++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	cfg := testConfig(t)
	reporter := New(server.URL, "node-1", "token", cfg)
	reporter.Start()
	defer reporter.Shutdown()
	incidentID := reporter.Report(ErrorEntry{Level: "error", Message: "quota", Source: "test"})
	waitFor(t, func() bool {
		var attempts int
		_ = reporter.db.QueryRow(
			"SELECT attempts FROM error_report_outbox WHERE incident_id = ?", incidentID,
		).Scan(&attempts)
		return attempts > 0
	})
	var artifactAck int
	if err := reporter.db.QueryRow(
		"SELECT artifact_ack FROM error_report_outbox WHERE incident_id = ?", incidentID,
	).Scan(&artifactAck); err != nil {
		t.Fatal(err)
	}
	if artifactAck != 0 || putCount != 0 {
		t.Fatalf("registration conflict was acknowledged or uploaded: ack=%d puts=%d", artifactAck, putCount)
	}
}

func TestArtifactRegistrationFailureTerminalizesAtMaxAttempts(t *testing.T) {
	var mu sync.Mutex
	registrations := 0
	puts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/errors"):
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/artifacts"):
			mu.Lock()
			registrations++
			mu.Unlock()
			w.WriteHeader(http.StatusServiceUnavailable)
		case request.Method == http.MethodPut:
			mu.Lock()
			puts++
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.MaxAttempts = 2
	cfg.FlushInterval = time.Hour
	cfg.RetryInitial = 10 * time.Millisecond
	cfg.RetryMax = 10 * time.Millisecond
	reporter := New(server.URL, "node-1", "token", cfg)
	reporter.Start()
	incidentID := reporter.Report(ErrorEntry{Level: "error", Message: "bounded", Source: "test"})
	waitFor(t, func() bool { return reporter.pendingCount() == 0 })
	reporter.Shutdown()
	mu.Lock()
	defer mu.Unlock()
	if registrations != 2 || puts != 0 {
		t.Fatalf("expected two bounded registrations and no upload, got registrations=%d puts=%d", registrations, puts)
	}
	if _, err := os.Stat(filepath.Join(cfg.SpoolDir, incidentID+".tar.gz")); !os.IsNotExist(err) {
		t.Fatalf("terminalized artifact spool was not cleaned up: %v", err)
	}
}

func TestShutdownWaitsForActiveSnapshotBeforeFinalUpload(t *testing.T) {
	var putCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/errors"):
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/artifacts"):
			w.WriteHeader(http.StatusCreated)
		case request.Method == http.MethodPut:
			putCount++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	reporter := New(server.URL, "node-1", "token", testConfig(t))
	collectorStarted := make(chan struct{})
	releaseCollector := make(chan struct{})
	reporter.SetCollectors(CollectorFunc{
		CollectorName: "shutdown-race",
		CollectFunc: func(context.Context, IncidentContext) (any, error) {
			close(collectorStarted)
			<-releaseCollector
			return map[string]any{"safe": true}, nil
		},
	})
	reporter.Start()
	reporter.Report(ErrorEntry{Level: "error", Message: "final evidence", Source: "test"})
	<-collectorStarted
	shutdownDone := make(chan struct{})
	go func() {
		reporter.Shutdown()
		close(shutdownDone)
	}()
	close(releaseCollector)
	select {
	case <-shutdownDone:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not complete")
	}
	if putCount != 1 {
		t.Fatalf("expected final snapshot upload before shutdown, got %d PUTs", putCount)
	}
}

func TestOutboxAndWALFilesArePrivate(t *testing.T) {
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(t.TempDir(), "private-outbox", "errors.db")
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

func TestCustomOutboxPathDoesNotChangeExistingParentPermissions(t *testing.T) {
	shared := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.DBPath = filepath.Join(shared, "errors.db")
	reporter := New("http://localhost", "node-1", "token", cfg)
	defer reporter.Shutdown()
	if err := reporter.InitError(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(shared); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("shared parent mode=%v err=%v", info.Mode().Perm(), err)
	}
	if info, err := os.Stat(cfg.DBPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("outbox file mode=%v err=%v", info.Mode().Perm(), err)
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

func TestTransientFailureRetriesAtStoredDeadlineWithoutManualFlush(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requests++
		attempt := requests
		mu.Unlock()
		if attempt == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.FlushInterval = time.Hour
	cfg.RetryInitial = 20 * time.Millisecond
	cfg.RetryMax = 20 * time.Millisecond
	reporter := New(server.URL, "node-1", "token", cfg)
	reporter.Start()
	defer reporter.Shutdown()
	reporter.ReportInfo("automatic retry", "test", "", nil)
	waitFor(t, func() bool { return reporter.pendingCount() == 0 })
	mu.Lock()
	defer mu.Unlock()
	if requests != 2 {
		t.Fatalf("expected one deadline-driven retry, got %d requests", requests)
	}
}

func TestStructuredReportTerminalStatusesLatchReporter(t *testing.T) {
	for _, status := range []int{
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusGone,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var mu sync.Mutex
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				mu.Lock()
				requests++
				mu.Unlock()
				w.WriteHeader(status)
				_, _ = w.Write([]byte("terminal callback resource"))
			}))
			defer server.Close()

			reporter := New(server.URL, "node-1", "token", testConfig(t))
			defer reporter.Shutdown()
			incidentID := reporter.Report(ErrorEntry{
				Level:   "info",
				Message: "terminal report",
				Source:  "test",
			})
			if incidentID == "" {
				t.Fatal("expected pre-terminal report to enqueue")
			}

			if err := reporter.flushReports(); err == nil {
				t.Fatal("expected terminal delivery error to be returned for logging")
			}

			if got := reporter.pendingCount(); got != 0 {
				t.Fatalf("terminal status should clear queued rows, got %d", got)
			}
			if got := reporter.Report(ErrorEntry{
				Level:   "info",
				Message: "after terminal",
				Source:  "test",
			}); got != "" {
				t.Fatalf("terminal reporter accepted a future report: %q", got)
			}
			if err := reporter.flushReports(); err != nil {
				t.Fatalf("terminal reporter should not retry: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if requests != 1 {
				t.Fatalf("expected no retry after terminal status, got %d requests", requests)
			}
		})
	}
}

func TestArtifactTerminalStatusLatchesReporter(t *testing.T) {
	var mu sync.Mutex
	registrations := 0
	uploads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/artifacts"):
			mu.Lock()
			registrations++
			mu.Unlock()
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte("terminal artifact callback resource"))
		case request.Method == http.MethodPut:
			mu.Lock()
			uploads++
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	reporter := New(server.URL, "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	incidentID := reporter.Report(ErrorEntry{
		Level: "error", Message: "artifact terminal",
		Source: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if incidentID == "" {
		t.Fatal("expected pre-terminal report to enqueue")
	}
	if err := reporter.markSnapshotReady(
		incidentID,
		filepath.Join(reporter.config.SpoolDir, incidentID+".tar.gz"),
		`{"version":1}`,
		`{}`,
		strings.Repeat("a", 64),
		10,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := reporter.db.Exec(
		"UPDATE error_report_outbox SET report_ack = 1 WHERE incident_id = ?",
		incidentID,
	); err != nil {
		t.Fatal(err)
	}

	if err := reporter.flushArtifacts(); err == nil {
		t.Fatal("expected terminal artifact delivery error")
	}
	if got := reporter.pendingCount(); got != 0 {
		t.Fatalf("terminal artifact status should clear queued rows, got %d", got)
	}
	if got := reporter.Report(ErrorEntry{
		Level:   "warn",
		Message: "after artifact terminal",
		Source:  "test",
	}); got != "" {
		t.Fatalf("terminal reporter accepted a future report: %q", got)
	}
	reporter.flush()

	mu.Lock()
	defer mu.Unlock()
	if registrations != 1 || uploads != 0 {
		t.Fatalf("registrations=%d uploads=%d, want one terminal registration and no uploads", registrations, uploads)
	}
}

func TestMarkTerminalDropsQueuedAndFutureErrorReports(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	reporter := New(server.URL, "node-1", "token", testConfig(t))
	defer reporter.Shutdown()

	if reporter.Report(ErrorEntry{
		Level:   "warn",
		Message: "queued before terminal",
		Source:  "test",
	}) == "" {
		t.Fatal("expected pre-terminal report to enqueue")
	}
	if got := reporter.pendingCount(); got != 1 {
		t.Fatalf("expected one queued report before terminal, got %d", got)
	}

	reporter.MarkTerminal("node heartbeat returned terminal status")
	if got := reporter.pendingCount(); got != 0 {
		t.Fatalf("expected terminal mark to clear outbox, got %d rows", got)
	}
	if incidentID := reporter.Report(ErrorEntry{
		Level:   "warn",
		Message: "after terminal",
		Source:  "test",
	}); incidentID != "" {
		t.Fatalf("expected no incident ID after terminal state, got %q", incidentID)
	}
	reporter.flush()

	mu.Lock()
	defer mu.Unlock()
	if requests != 0 {
		t.Fatalf("expected no HTTP requests after terminal mark, got %d", requests)
	}
}

func TestBuildReportBatchSplitsAtByteLimitAndRejectsSingleOversize(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	defer reporter.Shutdown()
	reporter.ReportInfo("first bounded report", "test", "", nil)
	reporter.ReportInfo("second bounded report", "test", "", nil)
	rows, err := reporter.readReportCandidates()
	if err != nil || len(rows) != 2 {
		t.Fatalf("read candidates=%d err=%v", len(rows), err)
	}
	_, oneBody, err := reporter.buildReportBatch(rows[:1])
	if err != nil {
		t.Fatal(err)
	}
	reporter.config.MaxBatchBytes = len(oneBody) + 1
	batch, body, err := reporter.buildReportBatch(rows)
	if err != nil || len(batch) != 1 || len(body) > reporter.config.MaxBatchBytes {
		t.Fatalf("batch=%d bytes=%d limit=%d err=%v", len(batch), len(body), reporter.config.MaxBatchBytes, err)
	}
	reporter.config.MaxBatchBytes = len(oneBody) - 1
	if _, _, err := reporter.buildReportBatch(rows[:1]); err == nil || !strings.Contains(err.Error(), "single structured incident") {
		t.Fatalf("expected single-row byte-limit rejection, got %v", err)
	}
}

func TestLocalRetentionTerminalizesAndDeletesExpiredRows(t *testing.T) {
	reporter := New("http://localhost", "node-1", "token", testConfig(t))
	incidentID := reporter.Report(ErrorEntry{Level: "error", Message: "expired", Source: "test"})
	if _, err := reporter.db.Exec(
		"UPDATE error_report_outbox SET expires_at = ? WHERE incident_id = ?",
		time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), incidentID,
	); err != nil {
		t.Fatal(err)
	}
	reporter.flush()
	if reporter.pendingCount() != 0 {
		t.Fatal("expired local row survived terminalization cleanup")
	}
	reporter.Shutdown()
}

func TestMissingTokenDefersPollingUntilFlushInterval(t *testing.T) {
	cfg := testConfig(t)
	cfg.FlushInterval = time.Hour
	cfg.RetryInitial = time.Millisecond
	reporter := New("http://localhost", "node-1", "", cfg)
	defer reporter.Shutdown()
	reporter.ReportInfo("await token", "test", "", nil)
	if delay := reporter.nextFlushDelay(); delay != time.Hour {
		t.Fatalf("missing token scheduled noisy retry after %s", delay)
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
	if reporter.config.ResponseMaxBytes != DefaultResponseMaxBytes ||
		reporter.config.StoredErrorBytes != DefaultStoredErrorBytes ||
		cap(reporter.collectorSem) != DefaultCollectorWorkers {
		t.Fatalf("unexpected transport/evidence worker defaults: %#v", reporter.config)
	}
}

func TestConfigurableResponseErrorAndCollectorBounds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "response-body-that-must-be-bounded")
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.ResponseMaxBytes = 8
	cfg.StoredErrorBytes = 5
	cfg.CollectorWorkers = 3
	reporter := New(server.URL, "node-1", "token", cfg)
	defer reporter.Shutdown()

	status, body, err := reporter.doRequest(
		context.Background(),
		http.MethodGet,
		server.URL,
		"token",
		"application/json",
		nil,
		-1,
		"",
	)
	if err != nil || status != http.StatusOK || body != "response" {
		t.Fatalf("status=%d body=%q error=%v", status, body, err)
	}
	if got := boundedError(fmt.Errorf("ééé"), reporter.config.StoredErrorBytes); got != "éé" {
		t.Fatalf("bounded unicode error=%q, want two complete characters", got)
	}
	if got := cap(reporter.collectorSem); got != 3 {
		t.Fatalf("collector concurrency=%d, want 3", got)
	}
}
