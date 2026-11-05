package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

func finalSnapshotTarget(s *Server) resourcemon.EvictionTarget {
	return resourcemon.EvictionTarget{
		WorkspaceID:    "workspace-1",
		ContainerID:    evictionTestContainerID,
		RuntimeVersion: s.workspaces["workspace-1"].UpdatedAt.UTC().Format(time.RFC3339Nano),
		Reason:         resourcemon.EvictionReasonMemoryPressure,
	}
}

func newFinalSnapshotTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	s := newEvictionTestServer()
	logPath := setupExitedEvictionDocker(t, evictionTestContainerID, strings.Repeat("b", 64))
	// A memory-pressure source was stopped by the eviction, not killed by the kernel.
	setEvictionTestSourceState(t, "false|false|0|2026-11-05T01:00:00Z|2026-11-05T01:09:00Z")
	session, _, err := s.agentSessions.Create("workspace-1", "agent-session-1", "Agent", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID("workspace-1", session.ID, "acp-session-1", "claude-code"); err != nil {
		t.Fatal(err)
	}
	return s, logPath
}

// runnerEvaluatingQuiescence stands in for hibernateSessionSnapshot, which evaluates the
// quiescence check immediately before completion (see TestHibernateReportsQuiesced...).
func runnerEvaluatingQuiescence(beforeCheck func()) func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
	return func(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		if beforeCheck != nil {
			beforeCheck()
		}
		quiesced := input.quiescence != nil && input.quiescence(ctx) == nil
		return map[string]interface{}{"status": "available", "quiesced": quiesced}, nil
	}
}

func TestFinalEvictionSnapshotCapturesStoppedSourceThroughHelper(t *testing.T) {
	s, logPath := newFinalSnapshotTestServer(t)
	var captured *containerSnapshotTarget
	s.sessionSnapshotRunner = func(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		captured = input.containerTarget
		return runnerEvaluatingQuiescence(nil)(ctx, input)
	}

	outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
	if err != nil {
		t.Fatalf("final capture: %v", err)
	}
	if !outcome.Quiesced {
		t.Fatal("stopped source with no other writer was not reported quiesced")
	}
	if captured == nil || captured.containerID != strings.Repeat("b", 64) {
		t.Fatalf("capture did not run in the helper: %#v", captured)
	}
	calls := readCalls(t, logPath)
	for _, want := range []string{
		"container inspect --size --format {{.SizeRw}} " + evictionTestContainerID,
		"commit --change LABEL sam.snapshot-helper.workspace=workspace-1 " + evictionTestContainerID,
		"--volumes-from " + evictionTestContainerID,
		"rm --force --volumes sam-eviction-snapshot-",
		"image rm --force sam-eviction-snapshot:",
	} {
		if !strings.Contains(calls, want) {
			t.Fatalf("missing %q in Docker calls:\n%s", want, calls)
		}
	}
	if strings.Index(calls, "commit ") > strings.Index(calls, "rm --force --volumes") {
		t.Fatalf("helper removed before it was created:\n%s", calls)
	}
}

func TestFinalEvictionSnapshotIsNotQuiescedWhenAnotherContainerMountsWorkspaceStorage(t *testing.T) {
	const sidecar = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	const running = sidecar + " true 0001-01-01T00:00:00Z "
	for name, mounts := range map[string]string{
		"workspace volume":      running + `[{"Type":"volume","Name":"sam-ws-workspace-1","Source":"/var/lib/docker/volumes/sam-ws-workspace-1/_data"}]`,
		"host root":             running + `[{"Type":"bind","Name":"","Source":"/workspace/repo/.cache"}]`,
		"ancestor of host root": running + `[{"Type":"bind","Name":"","Source":"/workspace"}]`,
		"filesystem root":       running + `[{"Type":"bind","Name":"","Source":"/"}]`,
		"unparseable":           running + `not-json`,
		"unknown finish time":   sidecar + " false garbage []",
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := newFinalSnapshotTestServer(t)
			t.Setenv("SAM_EVICTION_TEST_RUNNING", sidecar)
			t.Setenv("SAM_EVICTION_TEST_MOUNTS", mounts)
			s.sessionSnapshotRunner = runnerEvaluatingQuiescence(nil)

			outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
			if err != nil {
				t.Fatalf("final capture: %v", err)
			}
			if outcome.Quiesced {
				t.Fatal("a capture with another writer on workspace storage was certified final")
			}
		})
	}
	// Control: an unrelated tenant's running container never blocks certification, including
	// mounts that share a string prefix with the host root but not a path component.
	s, _ := newFinalSnapshotTestServer(t)
	t.Setenv("SAM_EVICTION_TEST_RUNNING", sidecar)
	t.Setenv("SAM_EVICTION_TEST_MOUNTS", running+`[{"Type":"volume","Name":"sam-ws-other-workspace","Source":"/var/lib/docker/volumes/sam-ws-other-workspace/_data"},{"Type":"bind","Name":"","Source":"/workspace/repo-other|odd:path"},{"Type":"bind","Name":"","Source":"/work"},{"Type":"bind","Name":"","Source":"/workspace/rep"}]`)
	s.sessionSnapshotRunner = runnerEvaluatingQuiescence(nil)
	outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
	if err != nil || !outcome.Quiesced {
		t.Fatalf("neighbor container blocked certification: outcome=%+v err=%v", outcome, err)
	}
}

// A container that starts, writes the workspace volume and exits while the helper captures
// is not running at either quiescence check. Its FinishedAt is what proves it ran.
func TestFinalEvictionSnapshotIsNotQuiescedWhenAWriterStartsAndExitsMidCapture(t *testing.T) {
	const writer = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	const volumeMount = `[{"Type":"volume","Name":"sam-ws-workspace-1","Source":"/var/lib/docker/volumes/sam-ws-workspace-1/_data"}]`
	for name, tc := range map[string]struct {
		finishedAt   func() string
		wantQuiesced bool
	}{
		"exited during the capture": {func() string { return time.Now().UTC().Format(time.RFC3339Nano) }, false},
		// Control: a container that exited before the capture began wrote nothing it missed.
		"exited before the capture": {func() string { return "2020-01-01T00:00:00Z" }, true},
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := newFinalSnapshotTestServer(t)
			s.sessionSnapshotRunner = runnerEvaluatingQuiescence(func() {
				// Nothing else existed at the first check; the writer ran and exited since.
				t.Setenv("SAM_EVICTION_TEST_RUNNING", writer)
				t.Setenv("SAM_EVICTION_TEST_MOUNTS", writer+" false "+tc.finishedAt()+" "+volumeMount)
			})
			outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
			if err != nil {
				t.Fatalf("final capture: %v", err)
			}
			if outcome.Quiesced != tc.wantQuiesced {
				t.Fatalf("quiesced = %v, want %v", outcome.Quiesced, tc.wantQuiesced)
			}
		})
	}
}

func TestFinalEvictionSnapshotIsNotQuiescedWhenSourceRestartsMidCapture(t *testing.T) {
	s, _ := newFinalSnapshotTestServer(t)
	s.sessionSnapshotRunner = runnerEvaluatingQuiescence(func() {
		// Something restarted and stopped the source while the helper was capturing.
		setEvictionTestSourceState(t, "false|false|0|2026-11-05T01:09:30Z|2026-11-05T01:09:40Z")
	})
	outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
	if err != nil {
		t.Fatalf("final capture: %v", err)
	}
	if outcome.Quiesced {
		t.Fatal("a source that ran during the capture was certified final")
	}
}

// A restart admitted between the stop and the final capture rotates the runtime; the final
// capture must not certify (or even commit) anything for the superseded eviction.
func TestFinalEvictionSnapshotAbortsWhenTheRuntimeWasReplaced(t *testing.T) {
	s, logPath := newFinalSnapshotTestServer(t)
	target := finalSnapshotTarget(s)
	s.workspaces["workspace-1"].UpdatedAt = s.workspaces["workspace-1"].UpdatedAt.Add(time.Second)
	s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		t.Fatal("captured a replaced runtime")
		return nil, nil
	}
	if _, err := s.captureQuiescedEvictionSnapshot(context.Background(), target); err == nil ||
		!strings.Contains(err.Error(), "no longer current") {
		t.Fatalf("final capture of a replaced runtime: %v", err)
	}
	if calls := readCalls(t, logPath); strings.Contains(calls, "commit ") {
		t.Fatalf("helper commit ran for a replaced runtime:\n%s", calls)
	}
}

func TestFinalEvictionSnapshotRefusesRunningSourceAndShortDisk(t *testing.T) {
	for name, setup := range map[string]func(t *testing.T){
		"source still running": func(t *testing.T) {
			setEvictionTestSourceState(t, "true|false|0|2026-11-05T01:00:00Z|0001-01-01T00:00:00Z")
		},
		"writable layer larger than free disk": func(t *testing.T) {
			t.Setenv("SAM_EVICTION_TEST_SIZE_RW", "9223372036854775000")
		},
	} {
		t.Run(name, func(t *testing.T) {
			s, logPath := newFinalSnapshotTestServer(t)
			setup(t)
			s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
				t.Fatal("capture ran without a helper")
				return nil, nil
			}
			if _, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s)); err == nil {
				t.Fatal("final capture succeeded")
			}
			if calls := readCalls(t, logPath); strings.Contains(calls, "commit ") {
				t.Fatalf("helper commit ran:\n%s", calls)
			}
		})
	}
}

func TestFinalEvictionSnapshotReleasesFailedCaptureGeneration(t *testing.T) {
	var mu sync.Mutex
	var failures []map[string]string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/session-snapshot/failure") {
			body, _ := io.ReadAll(r.Body)
			var payload map[string]string
			_ = json.Unmarshal(body, &payload)
			mu.Lock()
			failures = append(failures, payload)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer controlPlane.Close()
	s, logPath := newFinalSnapshotTestServer(t)
	s.config.ControlPlaneURL = controlPlane.URL
	s.sessionSnapshotRunner = func(context.Context, *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
		return nil, &sessionSnapshotCaptureError{generation: "01FINALGEN", err: errors.New("upload failed")}
	}

	if _, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s)); err == nil {
		t.Fatal("failed final capture reported success")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(failures) != 1 || failures[0]["generation"] != "01FINALGEN" || failures[0]["chatSessionId"] != "chat-session-1" {
		t.Fatalf("failure reports = %#v", failures)
	}
	if calls := readCalls(t, logPath); !strings.Contains(calls, "rm --force --volumes sam-eviction-snapshot-") {
		t.Fatalf("helper not cleaned up after a failed capture:\n%s", calls)
	}
}

// finishEviction waits for the final capture before it records the eviction, so a stalled
// helper cleanup must not stretch the capture past its deadline. The cleanup still finishes
// in the background.
func TestFinalEvictionSnapshotReturnsAtItsDeadlineWhileHelperCleanupStalls(t *testing.T) {
	s, logPath := newFinalSnapshotTestServer(t)
	s.config.EvictionSnapshotTimeout = 30 * time.Second // The cleanup's own bound.
	t.Setenv("SAM_EVICTION_TEST_RM_DELAY", "3")
	s.sessionSnapshotRunner = runnerEvaluatingQuiescence(nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	started := time.Now()
	outcome, err := s.captureQuiescedEvictionSnapshot(ctx, finalSnapshotTarget(s))
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("final capture returned after %s, past its 1s deadline", elapsed)
	}
	if err != nil || !outcome.Quiesced {
		t.Fatalf("final capture: outcome=%+v err=%v", outcome, err)
	}
	// Control: the detached cleanup still removes the helper image after the stalled rm.
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(readCalls(t, logPath), "image rm --force sam-eviction-snapshot:") {
		if time.Now().After(deadline) {
			t.Fatalf("background cleanup never finished:\n%s", readCalls(t, logPath))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Final captures for different workspaces can overlap. Each headroom check must be followed
// by its own commit before another check runs, or two commits measured against the same free
// space could together exhaust the headroom.
func TestConcurrentStoppedSourceCapturesSerializeHeadroomCheckAndCommit(t *testing.T) {
	s, logPath := newFinalSnapshotTestServer(t)
	t.Setenv("SAM_EVICTION_TEST_COMMIT_DELAY", "0.3")
	s.sessionSnapshotRunner = runnerEvaluatingQuiescence(nil)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, workspaceID := range []string{"workspace-a", "workspace-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			input := &sessionSnapshotHandlerInput{workspaceID: workspaceID, chatSessionID: "chat-" + workspaceID,
				runtime: &WorkspaceRuntime{ID: workspaceID, ContainerWorkDir: "/workspaces/repo", ContainerLabelValue: "/workspace/" + workspaceID}}
			target := resourcemon.EvictionTarget{WorkspaceID: workspaceID, ContainerID: evictionTestContainerID}
			_, err := s.runStoppedSourceSnapshot(context.Background(), input, target, false)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("capture: %v", err)
		}
	}
	var sequence []string
	for _, line := range strings.Split(readCalls(t, logPath), "\n") {
		switch {
		case strings.HasPrefix(line, "container inspect --size"):
			sequence = append(sequence, "check")
		case strings.HasPrefix(line, "commit "):
			sequence = append(sequence, "commit")
		case line == "commit-done":
			sequence = append(sequence, "done")
		}
	}
	if want := []string{"check", "commit", "done", "check", "commit", "done"}; strings.Join(sequence, ",") != strings.Join(want, ",") {
		t.Fatalf("headroom checks and commits interleaved: %v", sequence)
	}
}

func TestStartupReapRemovesEveryLeakedHelperIncludingLegacyOnes(t *testing.T) {
	s := newEvictionTestServer()
	logPath := setupExitedEvictionDocker(t, evictionTestContainerID, strings.Repeat("b", 64))
	t.Setenv("SAM_EVICTION_TEST_LEAKED", "dddddddddddd")
	if err := s.reapSnapshotHelpers(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	calls := readCalls(t, logPath)
	for _, want := range []string{
		"ps -aq --no-trunc --filter label=sam.snapshot-helper.workspace\n",
		"ps -aq --no-trunc --filter label=devcontainer.local_folder=sam-eviction-snapshot-helper",
		"rm --force --volumes dddddddddddd",
		"image ls -q --no-trunc --filter reference=sam-eviction-snapshot",
	} {
		if !strings.Contains(calls, want) {
			t.Fatalf("missing %q in Docker calls:\n%s", want, calls)
		}
	}
}

func TestStaleHelperReaperRemovesOnlyHelpersOlderThanAnyCapture(t *testing.T) {
	s := newEvictionTestServer()
	logPath := setupExitedEvictionDocker(t, evictionTestContainerID, strings.Repeat("b", 64))
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	stale := now.Add(-3 * time.Hour).Format(dockerCreatedAtLayout)
	young := now.Add(-time.Minute).Format(dockerCreatedAtLayout)
	t.Setenv("SAM_EVICTION_TEST_STALE", "oldhelper\t"+stale+"\nnewhelper\t"+young)
	t.Setenv("SAM_EVICTION_TEST_STALE_IMAGES", "sha256:oldimage\t"+stale+"\nsha256:newimage\t"+young)
	if err := s.reapStaleSnapshotHelpers(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	calls := readCalls(t, logPath)
	for _, want := range []string{"rm --force --volumes oldhelper", "image rm --force sha256:oldimage"} {
		if !strings.Contains(calls, want) {
			t.Fatalf("missing %q in Docker calls:\n%s", want, calls)
		}
	}
	for _, unwanted := range []string{"newhelper", "sha256:newimage"} {
		if strings.Contains(calls, "rm --force --volumes "+unwanted) || strings.Contains(calls, "image rm --force "+unwanted) {
			t.Fatalf("a helper young enough to be in flight was removed:\n%s", calls)
		}
	}
}

func TestWorkspaceDeletionReapsLeakedSnapshotHelperBeforeVolumeRemoval(t *testing.T) {
	f := newDeletionFixture(t)
	if err := os.Remove(filepath.Join(f.state, "fail-volume")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"helper", "helper-image"} {
		if err := os.WriteFile(filepath.Join(f.state, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	rec := f.request(t.Context(), f.identity)
	if rec.Code != http.StatusOK {
		t.Fatalf("deletion with a leaked helper = %d %s", rec.Code, rec.Body.String())
	}
	for _, name := range []string{"helper", "helper-image", "volume", "container"} {
		if _, err := os.Stat(filepath.Join(f.state, name)); !os.IsNotExist(err) {
			t.Fatalf("%s survived deletion", name)
		}
	}
	helperCommands, err := os.ReadFile(filepath.Join(f.state, "helper-commands"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"rm --force --volumes helper-1", "image rm --force helper-image-1"} {
		if !strings.Contains(string(helperCommands), want) {
			t.Fatalf("missing %q in helper commands:\n%s", want, helperCommands)
		}
	}
}

func TestFinalEvictionSnapshotIsSkippedInStandaloneRuntime(t *testing.T) {
	s := newEvictionTestServer()
	s.config.Role = config.RoleStandalone
	if _, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s)); err == nil {
		t.Fatal("standalone runtime attempted a Docker helper capture")
	}
}

func readCalls(t *testing.T, path string) string {
	t.Helper()
	calls, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(calls)
}

// The quiesced flag is decided inside the real capture, immediately before completion,
// and is sent only when the capture is complete and the check passed.
func TestHibernateReportsQuiescedOnlyWhenCheckPasses(t *testing.T) {
	for name, tc := range map[string]struct {
		check    func(context.Context) error
		degraded bool
		want     bool
	}{
		"no check (sleep, live eviction)": {nil, false, false},
		"check passes":                    {func(context.Context) error { return nil }, false, true},
		"check fails":                     {func(context.Context) error { return errors.New("source ran") }, false, false},
		// A degraded capture is never final, even from a quiet source: the check passing must
		// not put `quiesced` on it.
		"check passes, capture degraded": {func(context.Context) error { return nil }, true, false},
	} {
		t.Run(name, func(t *testing.T) {
			repo, _, _ := initSnapshotRemoteRepoWithHistory(t, 4096)
			writeLocalTaskWork(t, repo, "sam/quiesced-flag")
			home := t.TempDir()
			if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
				t.Fatal(err)
			}
			mustWriteSnapshotFile(t, home, ".claude/settings.json", `{"ok":true}`)
			t.Setenv("HOME", home)
			plane := serveEnforcingSnapshotControlPlane(t, 256*1024)
			s := &Server{config: &config.Config{Role: config.RoleStandalone, ControlPlaneURL: plane.url}}
			acpSessionID, wantStatus := "acp-1", "available"
			if tc.degraded {
				// No resumable harness identity: the capture degrades to agent-context-skipped.
				acpSessionID, wantStatus = "", "degraded"
			}
			result, err := s.hibernateSessionSnapshot(context.Background(), &sessionSnapshotHandlerInput{
				workspaceID: "ws-1", sessionID: "agent-1", chatSessionID: "chat-1", runtimeName: "vm",
				runtime:       &WorkspaceRuntime{ID: "ws-1", WorkspaceDir: t.TempDir()},
				callbackToken: "token", agentType: "claude-code", acpSessionID: acpSessionID,
				containerTarget: &containerSnapshotTarget{workDir: repo},
				quiescence:      tc.check,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result["status"] != wantStatus {
				t.Fatalf("capture status = %v, want %v", result["status"], wantStatus)
			}
			bodies := *plane.bodies
			if len(bodies) != 1 {
				t.Fatalf("completions = %d", len(bodies))
			}
			var completion map[string]interface{}
			if err := json.Unmarshal(bodies[0], &completion); err != nil {
				t.Fatal(err)
			}
			got, present := completion["quiesced"]
			if (got == true) != tc.want || (!tc.want && present) {
				t.Fatalf("completion quiesced = %v (present %v), want %v", got, present, tc.want)
			}
			if result["quiesced"] != tc.want {
				t.Fatalf("result quiesced = %v, want %v", result["quiesced"], tc.want)
			}
		})
	}
}

// snapshotLifecycleControlPlane records the completion and failure callbacks of a real
// hibernateSessionSnapshot run.
type snapshotLifecycleControlPlane struct {
	mu          sync.Mutex
	completions []map[string]interface{}
	failures    []map[string]interface{}
}

func serveSnapshotLifecycleControlPlane(t *testing.T, s *Server) *snapshotLifecycleControlPlane {
	t.Helper()
	plane := &snapshotLifecycleControlPlane{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		plane.mu.Lock()
		defer plane.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/prepare"):
			_, _ = w.Write([]byte(`{"generation":"01FINALGEN","config":{"totalBudgetBytes":262144,"entryThresholdBytes":262144,"transferIdleTimeoutMs":30000,"jsonBodyMaxBytes":262144},"upload":{"home":"/upload/home","wip":"/upload/wip"}}`))
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/complete"):
			plane.completions = append(plane.completions, body)
			_, _ = w.Write([]byte(`{"status":"degraded","degradation":"transcript-only"}`))
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/failure"):
			plane.failures = append(plane.failures, body)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(server.Close)
	s.config.ControlPlaneURL = server.URL
	return plane
}

// Completing a degraded final capture would replace the eviction's pre-stop generation and
// delete its HOME/WIP objects. The final capture reports the failure instead, which releases
// its own generation and leaves the pre-stop capture authoritative. The fake Docker CLI
// fails every `docker exec`, so the real capture degrades to transcript-only.
func TestDegradedFinalEvictionCaptureIsReleasedInsteadOfCompleted(t *testing.T) {
	s, _ := newFinalSnapshotTestServer(t)
	plane := serveSnapshotLifecycleControlPlane(t, s)

	if _, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s)); err == nil ||
		snapshotCaptureErrorGeneration(err) != "01FINALGEN" || !strings.Contains(err.Error(), "keeping the pre-stop capture") {
		t.Fatalf("degraded final capture err = %v", err)
	}
	plane.mu.Lock()
	defer plane.mu.Unlock()
	if len(plane.completions) != 0 {
		t.Fatalf("degraded final capture completed and replaced the pre-stop generation: %v", plane.completions)
	}
	if len(plane.failures) != 1 || plane.failures[0]["generation"] != "01FINALGEN" {
		t.Fatalf("final capture generation was not released: %v", plane.failures)
	}
}

// Control: the OOM pre-stop capture runs through the same stopped-source helper, but nothing
// precedes it, so a degraded capture must still complete or the eviction has no snapshot.
func TestDegradedOOMPreStopCaptureStillCompletes(t *testing.T) {
	s, _ := newFinalSnapshotTestServer(t)
	setEvictionTestSourceState(t, "false|true|137|2026-11-05T01:00:00Z|2026-11-05T01:09:00Z")
	plane := serveSnapshotLifecycleControlPlane(t, s)
	target := finalSnapshotTarget(s)
	target.Reason = resourcemon.EvictionReasonOOMKill

	if _, err := s.captureEvictionSessionSnapshot(context.Background(), target); err != nil {
		t.Fatalf("OOM pre-stop capture: %v", err)
	}
	plane.mu.Lock()
	defer plane.mu.Unlock()
	if len(plane.completions) != 1 || plane.completions[0]["status"] != "degraded" || len(plane.failures) != 0 {
		t.Fatalf("completions = %v, failures = %v", plane.completions, plane.failures)
	}
	if _, present := plane.completions[0]["quiesced"]; present {
		t.Fatal("a degraded capture was sent as quiesced")
	}
}
