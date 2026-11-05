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
	for name, mounts := range map[string]string{
		"workspace volume": sidecar + "|volume:sam-ws-workspace-1:/var/lib/docker/volumes/sam-ws-workspace-1/_data",
		"host root":        sidecar + "|bind::/workspace/repo/.cache",
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
	// Control: an unrelated tenant's running container never blocks certification.
	s, _ := newFinalSnapshotTestServer(t)
	t.Setenv("SAM_EVICTION_TEST_RUNNING", sidecar)
	t.Setenv("SAM_EVICTION_TEST_MOUNTS", sidecar+"|volume:sam-ws-other-workspace:/var/lib/docker/volumes/sam-ws-other-workspace/_data")
	s.sessionSnapshotRunner = runnerEvaluatingQuiescence(nil)
	outcome, err := s.captureQuiescedEvictionSnapshot(context.Background(), finalSnapshotTarget(s))
	if err != nil || !outcome.Quiesced {
		t.Fatalf("neighbor container blocked certification: outcome=%+v err=%v", outcome, err)
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
		check func(context.Context) error
		want  bool
	}{
		"no check (sleep, live eviction)": {nil, false},
		"check passes":                    {func(context.Context) error { return nil }, true},
		"check fails":                     {func(context.Context) error { return errors.New("source ran") }, false},
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
			result, err := s.hibernateSessionSnapshot(context.Background(), &sessionSnapshotHandlerInput{
				workspaceID: "ws-1", sessionID: "agent-1", chatSessionID: "chat-1", runtimeName: "vm",
				runtime:       &WorkspaceRuntime{ID: "ws-1", WorkspaceDir: t.TempDir()},
				callbackToken: "token", agentType: "claude-code", acpSessionID: "acp-1",
				containerTarget: &containerSnapshotTarget{workDir: repo},
				quiescence:      tc.check,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result["status"] != "available" {
				t.Fatalf("capture status = %v; the flag is only meaningful for a complete capture", result["status"])
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
