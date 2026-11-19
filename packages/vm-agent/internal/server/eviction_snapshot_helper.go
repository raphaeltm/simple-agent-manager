package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/bits"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/container"
)

const (
	// snapshotHelperWorkspaceLabel scopes a helper container and its committed image to the
	// workspace it captures, so deletion and the startup reaper can find leaked helpers.
	snapshotHelperWorkspaceLabel = "sam.snapshot-helper.workspace"
	// snapshotHelperRootLabelValue replaces the inherited root label: a helper must never
	// match the workspace's own container filter, or deletion would refuse "unknown" IDs.
	snapshotHelperRootLabelValue = "sam-eviction-snapshot-helper"
	snapshotHelperImageRepo      = "sam-eviction-snapshot"
)

// snapshotHelperDiskLock holds a headroom check together with the commit it measures.
// The check reserves nothing, so two captures (for different workspaces) checked against
// the same free space could commit together past the headroom. One per process: every
// capture on the node commits to the same Docker root.
var snapshotHelperDiskLock = newSessionSnapshotLock()

func noopSnapshotHelperCleanup() {
	// No helper resources exist when snapshot-helper setup fails.
}

// awaitSnapshotHelperCleanup waits for a helper's cleanup only while the capture's own
// deadline allows. finishEviction waits for the capture before it records the eviction, so a
// stalled `docker rm` must not stretch the capture past its bound. The cleanup keeps running
// under its own timeout; the startup reaper, the stale-helper reaper and deletion's reap
// before volume removal remove the helper if it never finishes.
func awaitSnapshotHelperCleanup(ctx context.Context, cleanup func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		cleanup()
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// snapshotSourceState is the identity of a stopped source container at one moment.
// A restart between two reads changes StartedAt, so equal reads prove nothing ran.
type snapshotSourceState struct {
	running    bool
	oomKilled  bool
	exitCode   string
	startedAt  string
	finishedAt string
}

func (s *Server) inspectSnapshotSource(ctx context.Context, containerID string) (snapshotSourceState, error) {
	out, err := s.runEvictionDockerCommand(ctx, "inspect", "--format",
		"{{.State.Running}}|{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}", containerID)
	if err != nil {
		return snapshotSourceState{}, fmt.Errorf("inspect snapshot source: %w", err)
	}
	fields := strings.Split(strings.TrimSpace(out), "|")
	if len(fields) != 5 {
		return snapshotSourceState{}, fmt.Errorf("snapshot source state unavailable")
	}
	return snapshotSourceState{
		running:    fields[0] == "true",
		oomKilled:  fields[1] == "true",
		exitCode:   fields[2],
		startedAt:  fields[3],
		finishedAt: fields[4],
	}, nil
}

// startStoppedSnapshotHelper mounts an exact stopped source container's volumes into a
// short-lived container created from that source's writable layer. The original entrypoint
// never runs, so nothing but the capture's own docker exec commands touches the files.
// requireOOM keeps the original OOM-victim contract for the pre-stop capture path.
func (s *Server) startStoppedSnapshotHelper(ctx context.Context, workspaceID, sourceID string, runtime *WorkspaceRuntime, requireOOM bool) (*containerSnapshotTarget, func(), error) {
	state, err := s.inspectSnapshotSource(ctx, sourceID)
	if err != nil {
		return nil, noopSnapshotHelperCleanup, err
	}
	if state.running || (requireOOM && !state.oomKilled && state.exitCode != "137") {
		if requireOOM {
			return nil, noopSnapshotHelperCleanup, fmt.Errorf("OOM snapshot source is not an exited OOM container")
		}
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("snapshot source container is still running")
	}
	if err := snapshotHelperDiskLock.Lock(ctx); err != nil {
		return nil, noopSnapshotHelperCleanup, err
	}
	if err := s.requireSnapshotHelperDiskHeadroom(ctx, sourceID); err != nil {
		snapshotHelperDiskLock.Unlock()
		return nil, noopSnapshotHelperCleanup, err
	}
	limits := s.config.SnapshotHelper.WithDefaults()
	suffix := randomEventID()
	image := snapshotHelperImageRepo + ":" + suffix
	name := snapshotHelperImageRepo + "-" + suffix
	workspaceLabel := snapshotHelperWorkspaceLabel + "=" + workspaceID
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), s.config.EvictionSnapshotTimeout)
		defer cancel()
		// Staging saw Docker `oom` events for helpers whose captures still completed; record
		// the helper's end state so the next one says whether a process was really killed.
		if state, err := s.runEvictionDockerCommand(cleanupCtx, "inspect", "--format",
			"oomKilled={{.State.OOMKilled}} running={{.State.Running}} exitCode={{.State.ExitCode}}", name); err == nil {
			slog.Info("Snapshot helper finished", "workspaceId", workspaceID, "name", name, "state", strings.TrimSpace(state))
		}
		if _, err := s.runEvictionDockerCommand(cleanupCtx, "rm", "--force", "--volumes", name); err != nil {
			slog.Warn("Failed to remove snapshot helper container; deletion and startup reap it", "name", name, "error", err)
		}
		if _, err := s.runEvictionDockerCommand(cleanupCtx, "image", "rm", "--force", image); err != nil {
			slog.Warn("Failed to remove snapshot helper image; deletion and startup reap it", "image", image, "error", err)
		}
	}

	// The image label makes a commit left behind by a crash findable by workspace.
	_, err = s.runEvictionDockerCommand(ctx, "commit", "--change", "LABEL "+workspaceLabel, sourceID, image)
	snapshotHelperDiskLock.Unlock()
	if err != nil {
		awaitSnapshotHelperCleanup(ctx, cleanup)
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("commit stopped container for snapshot: %w", err)
	}
	helperID, err := s.runEvictionDockerCommand(ctx,
		"create",
		"--name", name,
		"--label", s.config.ContainerLabelKey+"="+snapshotHelperRootLabelValue,
		"--label", workspaceLabel,
		"--volumes-from", sourceID,
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--memory", limits.MemoryLimit,
		"--pids-limit", strconv.Itoa(limits.PidsLimit),
		"--entrypoint", "/bin/sh",
		image,
		"-c", "exec tail -f /dev/null",
	)
	if err != nil {
		awaitSnapshotHelperCleanup(ctx, cleanup)
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("create stopped snapshot helper: %w", err)
	}
	helperID = strings.TrimSpace(helperID)
	if !isValidContainerID(helperID) {
		awaitSnapshotHelperCleanup(ctx, cleanup)
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("stopped snapshot helper identity unavailable")
	}
	if _, err := s.runEvictionDockerCommand(ctx, "start", helperID); err != nil {
		awaitSnapshotHelperCleanup(ctx, cleanup)
		return nil, noopSnapshotHelperCleanup, fmt.Errorf("start stopped snapshot helper: %w", err)
	}
	return &containerSnapshotTarget{
		containerID: helperID,
		workDir:     runtime.ContainerWorkDir,
		user:        runtime.ContainerUser,
	}, cleanup, nil
}

// requireSnapshotHelperDiskHeadroom refuses a commit that would leave less than the
// configured headroom on the Docker root filesystem. docker commit copies the whole
// writable layer, so a large layer on a nearly full disk could starve other tenants.
func (s *Server) requireSnapshotHelperDiskHeadroom(ctx context.Context, sourceID string) error {
	sizeText, err := s.runEvictionDockerCommand(ctx, "container", "inspect", "--size", "--format", "{{.SizeRw}}", sourceID)
	if err != nil {
		return fmt.Errorf("measure snapshot source writable layer: %w", err)
	}
	layerBytes, err := strconv.ParseInt(strings.TrimSpace(sizeText), 10, 64)
	if err != nil || layerBytes < 0 {
		return fmt.Errorf("snapshot source writable layer size unavailable")
	}
	root, err := s.runEvictionDockerCommand(ctx, "info", "--format", "{{.DockerRootDir}}")
	if err != nil {
		return fmt.Errorf("resolve docker root for snapshot helper: %w", err)
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(filepath.Clean(strings.TrimSpace(root)), &stat); err != nil {
		return fmt.Errorf("measure docker root free space: %w", err)
	}
	hi, lo := bits.Mul64(stat.Bavail, uint64(stat.Bsize)) //nolint:gosec // Bsize is a positive block size
	free := int64(math.MaxInt64)
	if hi == 0 && lo <= math.MaxInt64 {
		free = int64(lo)
	}
	headroom := s.config.SnapshotHelper.WithDefaults().MinFreeBytes
	// Compared without adding, so a huge layer size cannot overflow into a pass.
	if layerBytes > free || free-layerBytes < headroom {
		return fmt.Errorf("snapshot helper needs %d bytes plus %d headroom on the docker root, %d available", layerBytes, headroom, free)
	}
	return nil
}

// reapSnapshotHelpers removes helper containers and committed images left by a capture
// that never ran its cleanup (agent crash, failed rm). An empty workspaceID reaps every
// helper, including legacy ones created before helpers carried a workspace label; only the
// startup path does that, when no capture can be in flight. A leaked helper holds a
// --volumes-from reference that makes `docker volume rm` fail, so deletion calls this first.
func (s *Server) reapSnapshotHelpers(ctx context.Context, workspaceID string) error {
	containerFilters := []string{"label=" + snapshotHelperWorkspaceLabel + "=" + workspaceID}
	imageFilters := containerFilters
	if workspaceID == "" {
		containerFilters = []string{
			"label=" + snapshotHelperWorkspaceLabel,
			"label=" + s.config.ContainerLabelKey + "=" + snapshotHelperRootLabelValue,
		}
		imageFilters = []string{"label=" + snapshotHelperWorkspaceLabel, "reference=" + snapshotHelperImageRepo}
	}
	for _, filter := range containerFilters {
		ids, err := s.runEvictionDockerCommand(ctx, "ps", "-aq", "--no-trunc", "--filter", filter)
		if err != nil {
			return fmt.Errorf("list snapshot helpers: %w", err)
		}
		for _, id := range strings.Fields(ids) {
			if _, err := s.runEvictionDockerCommand(ctx, "rm", "--force", "--volumes", id); err != nil {
				return fmt.Errorf("remove snapshot helper: %w", err)
			}
			slog.Info("Reaped leaked snapshot helper container", "workspaceId", workspaceID, "containerId", id)
		}
	}
	for _, filter := range imageFilters {
		ids, err := s.runEvictionDockerCommand(ctx, "image", "ls", "-q", "--no-trunc", "--filter", filter)
		if err != nil {
			return fmt.Errorf("list snapshot helper images: %w", err)
		}
		for _, id := range strings.Fields(ids) {
			if _, err := s.runEvictionDockerCommand(ctx, "image", "rm", "--force", id); err != nil {
				return fmt.Errorf("remove snapshot helper image: %w", err)
			}
			slog.Info("Reaped leaked snapshot helper image", "workspaceId", workspaceID, "imageId", id)
		}
	}
	return nil
}

// requireNoForeignWorkspaceWriters proves no container other than the source and the
// helper could have written the files a deletion destroys since `since`: the workspace's
// SAM volume and its host root, or any directory above that root. A sidecar or sibling that
// mounts either one makes the capture a live capture, never final.
//
// It reads every container, not only running ones: one that starts, writes and exits inside
// the capture is invisible to two `docker ps` snapshots, but its FinishedAt records that it
// ran. A container removed again before this check (`docker run --rm`) leaves no record;
// `docker events --since` does not close that gap, because the daemon replays only a short
// in-memory buffer that the capture's own `docker exec` events can overrun.
//
// Cost: one `docker ps -aq` and one batched `docker inspect` of every container the daemon
// still holds, twice per final capture. That is bounded by the node's containers: one
// devcontainer per workspace it has not deleted yet (the deletion queue removes stopped ones
// after WORKSPACE_STOPPED_TTL_MS), helpers and system containers, i.e. tens on a VM sized for
// a handful of workspaces, where a batched inspect returns well under a second.
//
// A helper this same workspace's earlier capture leaked (its removal outlived the capture
// deadline) still mounts the volume and blocks quiescence until a reaper removes it. That is
// the conservative outcome, not a foreign tenant.
func (s *Server) requireNoForeignWorkspaceWriters(ctx context.Context, workspaceID, hostRoot string, since time.Time, ownIDs ...string) error {
	ids, err := s.runEvictionDockerCommand(ctx, "ps", "-aq", "--no-trunc")
	if err != nil {
		return fmt.Errorf("list containers: %w", err)
	}
	containers := strings.Fields(ids)
	if len(containers) == 0 {
		return nil
	}
	// One line per container: "<id> <running> <finishedAt> <mounts JSON>". JSON keeps any
	// byte a path may hold.
	args := append([]string{"inspect", "--format", "{{.Id}} {{.State.Running}} {{.State.FinishedAt}} {{json .Mounts}}"}, containers...)
	out, err := s.runEvictionDockerCommand(ctx, args...)
	if err != nil {
		return fmt.Errorf("inspect container mounts: %w", err)
	}
	volume := bootstrap.VolumeNameForWorkspace(workspaceID)
	root := filepath.Clean(hostRoot)
lines:
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(strings.TrimSpace(line), " ", 4)
		if len(fields) == 1 && fields[0] == "" {
			continue
		}
		if len(fields) != 4 {
			return fmt.Errorf("container state unavailable: %q", line)
		}
		id, running, finished, mountsJSON := fields[0], fields[1], fields[2], fields[3]
		for _, own := range ownIDs {
			if dockerContainerIdentityMatches(id, own) {
				continue lines
			}
		}
		if running != "true" {
			finishedAt, err := time.Parse(time.RFC3339Nano, finished)
			if err != nil {
				// An unknown end time cannot prove the container stayed out of the window.
				return fmt.Errorf("parse finish time of container %s: %w", shortContainerID(id), err)
			}
			if finishedAt.Before(since) {
				continue // Exited before the capture began; its writes were captured.
			}
		}
		var mounts []struct {
			Name   string `json:"Name"`
			Source string `json:"Source"`
		}
		if err := json.Unmarshal([]byte(mountsJSON), &mounts); err != nil {
			// Unknown mounts cannot be proven harmless: refuse certification.
			return fmt.Errorf("parse mounts of container %s: %w", shortContainerID(id), err)
		}
		for _, mount := range mounts {
			source := filepath.Clean(mount.Source)
			if mount.Name == volume || (hostRoot != "" && (pathContains(root, source) || pathContains(source, root))) {
				return fmt.Errorf("container %s mounted workspace storage during the capture", shortContainerID(id))
			}
		}
	}
	return nil
}

// pathContains reports whether child is parent or lies below it, by whole path component:
// /work does not contain /workspace. Both paths are clean.
func pathContains(parent, child string) bool {
	if parent == child {
		return true
	}
	if parent == string(filepath.Separator) {
		return strings.HasPrefix(child, parent)
	}
	return strings.HasPrefix(child, parent+string(filepath.Separator))
}

func shortContainerID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func (s *Server) runEvictionDockerCommand(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, container.DockerCLIPath(), args...)
	cmd.WaitDelay = s.config.EvictionResolveTimeout
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("docker %s failed: %s", args[0], message)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// dockerCreatedAtLayout is the format of `{{.CreatedAt}}` in `docker ps` / `docker image ls`.
const dockerCreatedAtLayout = "2006-01-02 15:04:05 -0700 MST"

// snapshotHelperMaxAge is longer than any capture can hold a helper: the pre-stop OOM
// capture is bounded by EvictionSnapshotTimeout and the final capture by its own timeout.
func (s *Server) snapshotHelperMaxAge() time.Duration {
	return 2 * (s.config.EvictionSnapshotTimeout + s.config.SnapshotHelper.WithDefaults().FinalSnapshotTimeout)
}

// reapStaleSnapshotHelpers removes helpers older than any capture can run, so a helper
// whose cleanup failed while the agent kept running does not keep a full copy of a
// workspace's writable layer on the node until the next restart or that workspace's
// deletion. Younger helpers may belong to a capture in flight and are left alone.
func (s *Server) reapStaleSnapshotHelpers(ctx context.Context, now time.Time) error {
	maxAge := s.snapshotHelperMaxAge()
	filter := "label=" + snapshotHelperWorkspaceLabel
	for _, kind := range []struct {
		list   []string
		remove []string
	}{
		{list: []string{"ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}\t{{.CreatedAt}}"}, remove: []string{"rm", "--force", "--volumes"}},
		{list: []string{"image", "ls", "--no-trunc", "--filter", filter, "--format", "{{.ID}}\t{{.CreatedAt}}"}, remove: []string{"image", "rm", "--force"}},
	} {
		out, err := s.runEvictionDockerCommand(ctx, kind.list...)
		if err != nil {
			return fmt.Errorf("list snapshot helpers: %w", err)
		}
		for _, line := range strings.Split(out, "\n") {
			id, created, ok := strings.Cut(strings.TrimSpace(line), "\t")
			if !ok {
				continue
			}
			createdAt, err := time.Parse(dockerCreatedAtLayout, strings.TrimSpace(created))
			if err != nil || now.Sub(createdAt) < maxAge {
				continue // Unknown age is treated as possibly in flight.
			}
			if _, err := s.runEvictionDockerCommand(ctx, append(kind.remove, id)...); err != nil {
				return fmt.Errorf("remove stale snapshot helper: %w", err)
			}
			slog.Info("Reaped stale snapshot helper", "id", id, "createdAt", createdAt)
		}
	}
	return nil
}
