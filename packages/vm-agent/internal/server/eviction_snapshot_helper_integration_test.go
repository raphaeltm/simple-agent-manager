//go:build integration

package server

// Real-Docker round trip for the stopped-source snapshot helper:
//
//	source workspace (HOME + Git staged/unstaged/untracked/unpushed) → docker stop →
//	helper capture through the real hibernateSessionSnapshot → upload to a control
//	plane → restore into a fresh container with the production container restore
//	primitives → HOME and Git state equal the stopped source.
//
// Run with: go test -tags integration -run StoppedSourceHelper ./internal/server/
// The test skips when no Docker daemon is reachable.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/resourcemon"
)

const helperIntegrationImage = "buildpack-deps:bookworm-scm"

type integrationDocker struct {
	t       *testing.T
	cleanup []func()
}

func newIntegrationDocker(t *testing.T) *integrationDocker {
	t.Helper()
	if err := exec.Command("docker", "info").Run(); err != nil {
		t.Skipf("docker unavailable: %v", err)
	}
	if out, err := exec.Command("docker", "image", "inspect", helperIntegrationImage).CombinedOutput(); err != nil {
		if pull, pullErr := exec.Command("docker", "pull", "-q", helperIntegrationImage).CombinedOutput(); pullErr != nil {
			t.Skipf("image %s unavailable: %v %s %s", helperIntegrationImage, pullErr, out, pull)
		}
	}
	d := &integrationDocker{t: t}
	t.Cleanup(func() {
		for i := len(d.cleanup) - 1; i >= 0; i-- {
			d.cleanup[i]()
		}
	})
	return d
}

func (d *integrationDocker) run(args ...string) string {
	d.t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		d.t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (d *integrationDocker) try(args ...string) (string, error) {
	out, err := exec.Command("docker", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (d *integrationDocker) volume(name string) {
	d.run("volume", "create", name)
	d.cleanup = append(d.cleanup, func() { _, _ = d.try("volume", "rm", "-f", name) })
}

// container starts a workspace-like container with a non-root user `dev`, its own
// workspace volume at /workspaces and a shared Git remote volume at /remote.
func (d *integrationDocker) container(name, workspaceVolume, remoteVolume string, labels ...string) string {
	args := []string{"run", "-d", "--name", name, "-v", workspaceVolume + ":/workspaces", "-v", remoteVolume + ":/remote"}
	for _, label := range labels {
		args = append(args, "--label", label)
	}
	args = append(args, helperIntegrationImage, "sh", "-c",
		"id dev >/dev/null 2>&1 || useradd -m -u 1000 dev; chown dev /workspaces /remote; exec sleep infinity")
	id := d.run(args...)
	d.cleanup = append(d.cleanup, func() { _, _ = d.try("rm", "-f", "-v", id) })
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if out, err := d.try("exec", id, "id", "dev"); err == nil && strings.Contains(out, "uid=1000") {
			return id
		}
		time.Sleep(200 * time.Millisecond)
	}
	d.t.Fatalf("container %s never created user dev", name)
	return ""
}

func (d *integrationDocker) asDev(id, script string) string {
	d.t.Helper()
	return d.run("exec", "-u", "dev", "-w", "/workspaces", "-e", "HOME=/home/dev", id, "bash", "-ec", script)
}

// snapshotControlPlane stores uploaded artifacts and completion bodies and serves the
// artifacts back for restore.
type snapshotControlPlane struct {
	mu          sync.Mutex
	artifacts   map[string][]byte
	completions []map[string]interface{}
	server      *httptest.Server
}

func newSnapshotControlPlane(t *testing.T) *snapshotControlPlane {
	cp := &snapshotControlPlane{artifacts: map[string][]byte{}}
	cp.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cp.mu.Lock()
		defer cp.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/prepare"):
			_, _ = w.Write([]byte(`{"generation":"01ITGENERATION","config":{"totalBudgetBytes":268435456,"entryThresholdBytes":268435456,"transferIdleTimeoutMs":60000,"jsonBodyMaxBytes":262144},"upload":{"home":"/upload/home","wip":"/upload/wip"}}`))
		case strings.HasPrefix(r.URL.Path, "/upload/"):
			cp.artifacts[strings.TrimPrefix(r.URL.Path, "/upload/")] = body
			w.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(r.URL.Path, "/download/"):
			_, _ = w.Write(cp.artifacts[strings.TrimPrefix(r.URL.Path, "/download/")])
		case strings.HasSuffix(r.URL.Path, "/session-snapshot/complete"):
			var completion map[string]interface{}
			_ = json.Unmarshal(body, &completion)
			cp.completions = append(cp.completions, completion)
			_, _ = w.Write([]byte(`{"status":"available","degradation":"none"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(cp.server.Close)
	return cp
}

func helperIntegrationServer(controlPlaneURL string) *Server {
	return &Server{config: &config.Config{
		Role:                    config.RoleWorkspace,
		ContainerMode:           true,
		ContainerLabelKey:       "devcontainer.local_folder",
		ControlPlaneURL:         controlPlaneURL,
		EvictionSnapshotTimeout: 2 * time.Minute,
		EvictionResolveTimeout:  30 * time.Second,
		HTTPCallbackTimeout:     30 * time.Second,
	}}
}

func helperIntegrationInput(workspaceID, hostRoot string) *sessionSnapshotHandlerInput {
	return &sessionSnapshotHandlerInput{
		workspaceID:   workspaceID,
		sessionID:     "agent-1",
		chatSessionID: "chat-1",
		runtimeName:   "vm",
		runtime: &WorkspaceRuntime{
			ID:                  workspaceID,
			ContainerWorkDir:    "/workspaces/repo",
			ContainerUser:       "dev",
			ContainerLabelValue: hostRoot,
		},
		callbackToken: "token",
		agentType:     "claude-code",
		acpSessionID:  "acp-1",
	}
}

// seedWorkspaceState writes the state a working agent leaves behind.
func seedWorkspaceState(d *integrationDocker, id string) {
	d.asDev(id, `
git config --global user.email dev@example.com
git config --global user.name Dev
git config --global init.defaultBranch main
git init --bare -q /remote/repo.git
git clone -q /remote/repo.git /workspaces/repo
cd /workspaces/repo
echo base > a.txt && git add a.txt && git commit -qm base && git push -q origin main
git remote set-head origin main
git checkout -qb sam/work
echo local > l.txt && git add l.txt && git commit -qm "unpushed local commit"
echo staged > s.txt && git add s.txt
echo modified >> a.txt
echo untracked > u.txt
mkdir -p ~/.claude ~/.codex/sessions ~/.cache
echo '{"theme":"dark"}' > ~/.claude/settings.json
echo '{"turn":1}' > ~/.codex/sessions/rollout.jsonl
echo regenerable > ~/.cache/blob
`)
}

func TestStoppedSourceHelperRoundTripsHomeAndGitState(t *testing.T) {
	d := newIntegrationDocker(t)
	suffix := randomEventID()
	workspaceID := "it-" + suffix
	hostRoot := "/tmp/sam-helper-it-root-" + suffix
	wsVolume, remoteVolume := "sam-ws-"+workspaceID, "sam-it-remote-"+suffix
	d.volume(wsVolume)
	d.volume(remoteVolume)
	source := d.container("sam-it-source-"+suffix, wsVolume, remoteVolume, "devcontainer.local_folder="+hostRoot)
	seedWorkspaceState(d, source)
	// A large non-HOME file in the writable layer: docker commit must copy it.
	d.run("exec", source, "sh", "-c", "head -c 134217728 /dev/zero > /opt/large.bin")
	d.run("stop", "-t", "1", source)

	cp := newSnapshotControlPlane(t)
	s := helperIntegrationServer(cp.server.URL)
	started := time.Now()
	outcome, err := s.runStoppedSourceSnapshot(context.Background(), helperIntegrationInput(workspaceID, hostRoot),
		resourcemon.EvictionTarget{WorkspaceID: workspaceID, ContainerID: source}, false)
	if err != nil {
		t.Fatalf("stopped-source capture: %v", err)
	}
	t.Logf("capture of a stopped source with a 128 MiB writable layer took %s", time.Since(started))
	if !outcome.Quiesced {
		t.Fatal("a stopped source with no other writer was not certified quiesced")
	}
	if len(cp.completions) != 1 || cp.completions[0]["quiesced"] != true || cp.completions[0]["status"] != "available" {
		t.Fatalf("completion = %#v", cp.completions)
	}
	// The helper and its committed image are gone, so the workspace volume is removable.
	if out := d.run("ps", "-aq", "--filter", "label="+snapshotHelperWorkspaceLabel+"="+workspaceID); out != "" {
		t.Fatalf("helper container leaked: %s", out)
	}
	if out := d.run("image", "ls", "-q", "--filter", "label="+snapshotHelperWorkspaceLabel+"="+workspaceID); out != "" {
		t.Fatalf("helper image leaked: %s", out)
	}

	// Restore into a fresh container, as a wake on another node does.
	restoreVolume := "sam-ws-it-restore-" + suffix
	d.volume(restoreVolume)
	restored := d.container("sam-it-restore-"+suffix, restoreVolume, remoteVolume)
	d.asDev(restored, "git clone -q /remote/repo.git /workspaces/repo")
	target := &containerSnapshotTarget{containerID: restored, workDir: "/workspaces/repo", user: "dev"}
	manifestBytes, _ := json.Marshal(cp.completions[0]["manifest"])
	var manifest snapshotManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	gitState, err := snapshotRestoreGitState(&snapshotRestoreResponse{BaseCommit: manifest.BaseCommit, Manifest: &manifest})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.downloadAndExtractContainerHome(ctx, target, "/download/home", "token", time.Minute, 1<<28, 1<<28); err != nil {
		t.Fatalf("restore HOME: %v", err)
	}
	if err := s.downloadAndRestoreContainerWIPWithGitState(ctx, target, "/download/wip", "token", time.Minute, 1<<28, gitState); err != nil {
		t.Fatalf("restore WIP: %v", err)
	}
	gitCommand := func(ctx context.Context, env []string, args ...string) (string, error) {
		return s.containerGit(ctx, target, env, args...)
	}
	if err := validateSnapshotGitState(ctx, gitCommand, gitState); err != nil {
		t.Fatalf("restored Git state does not match the snapshot: %v", err)
	}

	got := d.asDev(restored, `cd /workspaces/repo
echo "branch=$(git rev-parse --abbrev-ref HEAD)"
echo "status=$(git status --porcelain=v1 | sort | tr '\n' ';')"
echo "log=$(git log --format=%s -2 | tr '\n' ';')"
echo "claude=$(cat ~/.claude/settings.json)"
echo "codex=$(cat ~/.codex/sessions/rollout.jsonl)"
echo "cache=$(test -e ~/.cache/blob && echo present || echo absent)"`)
	for _, want := range []string{
		"branch=sam/work",
		" M a.txt;", // unstaged
		"A  s.txt;", // staged
		"?? u.txt;", // untracked
		"log=unpushed local commit;base;",
		`claude={"theme":"dark"}`,
		`codex={"turn":1}`,
		"cache=absent", // regenerable caches are deliberately not captured
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("restored workspace missing %q:\n%s", want, got)
		}
	}
}

func TestStoppedSourceHelperIsNotQuiescedWhileASidecarMountsTheVolume(t *testing.T) {
	d := newIntegrationDocker(t)
	suffix := randomEventID()
	workspaceID := "it-" + suffix
	hostRoot := "/tmp/sam-helper-it-root-" + suffix
	wsVolume, remoteVolume := "sam-ws-"+workspaceID, "sam-it-remote-"+suffix
	d.volume(wsVolume)
	d.volume(remoteVolume)
	source := d.container("sam-it-source-"+suffix, wsVolume, remoteVolume, "devcontainer.local_folder="+hostRoot)
	seedWorkspaceState(d, source)
	d.run("stop", "-t", "1", source)
	// A sidecar that can still write the workspace volume after the source stopped.
	sidecar := d.run("run", "-d", "--name", "sam-it-sidecar-"+suffix, "-v", wsVolume+":/data", helperIntegrationImage, "sleep", "infinity")
	d.cleanup = append(d.cleanup, func() { _, _ = d.try("rm", "-f", sidecar) })

	cp := newSnapshotControlPlane(t)
	s := helperIntegrationServer(cp.server.URL)
	outcome, err := s.runStoppedSourceSnapshot(context.Background(), helperIntegrationInput(workspaceID, hostRoot),
		resourcemon.EvictionTarget{WorkspaceID: workspaceID, ContainerID: source}, false)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if outcome.Quiesced {
		t.Fatal("a capture with a running sidecar on the workspace volume was certified final")
	}
	if len(cp.completions) != 1 || cp.completions[0]["status"] != "available" {
		t.Fatalf("the capture itself must still complete: %#v", cp.completions)
	}
	if _, present := cp.completions[0]["quiesced"]; present {
		t.Fatal("quiesced flag sent for a non-final capture")
	}
}

// A VM agent that crashes mid-capture leaves its helper behind; the helper's
// --volumes-from reference blocks `docker volume rm` until the startup reaper runs.
func TestLeakedHelperBlocksVolumeRemovalUntilReaped(t *testing.T) {
	d := newIntegrationDocker(t)
	suffix := randomEventID()
	workspaceID := "it-" + suffix
	wsVolume, remoteVolume := "sam-ws-"+workspaceID, "sam-it-remote-"+suffix
	d.volume(wsVolume)
	d.volume(remoteVolume)
	source := d.container("sam-it-source-"+suffix, wsVolume, remoteVolume)
	d.run("stop", "-t", "1", source)
	s := helperIntegrationServer("http://127.0.0.1:1")
	runtime := helperIntegrationInput(workspaceID, "").runtime
	if _, _, err := s.startStoppedSnapshotHelper(context.Background(), workspaceID, source, runtime, false); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	// Crash: the cleanup closure never runs. Remove the source as deletion would.
	d.run("rm", "-f", source)
	if _, err := d.try("volume", "rm", wsVolume); err == nil {
		t.Fatal("precondition: the leaked helper did not hold the workspace volume")
	}
	if err := s.reapSnapshotHelpers(context.Background(), ""); err != nil {
		t.Fatalf("reap: %v", err)
	}
	if out, err := d.try("volume", "rm", wsVolume); err != nil {
		t.Fatalf("volume still pinned after reaping: %v %s", err, out)
	}
	if out := d.run("image", "ls", "-q", "--filter", "label="+snapshotHelperWorkspaceLabel+"="+workspaceID); out != "" {
		t.Fatalf("helper image survived the reap: %s", out)
	}
}
