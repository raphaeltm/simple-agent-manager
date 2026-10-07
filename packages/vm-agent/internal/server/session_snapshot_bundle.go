package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
)

// snapshotBundleHeaderMaxBytes bounds how much of a downloaded bundle is read
// while looking for its prerequisites. A WIP bundle header is a version line,
// at most a few prerequisite lines and two refs: a few hundred bytes.
const snapshotBundleHeaderMaxBytes = 1024 * 1024

// snapshotWIPBundleBasis returns the rev-list exclusion that keeps a WIP bundle
// down to the work a woken session cannot fetch for itself.
//
// Without a basis, `git bundle create` packs every commit reachable from the
// snapshot commits. For the SAM repository that is 246.6 MiB, leaving about
// 9 MiB of the 256 MiB snapshot budget for HOME, so every capture overflowed
// and none completed (2026-10-03).
//
// Only history reachable from the default branch (`refs/remotes/origin/HEAD`)
// is excluded. A fresh wake clone already has it, and origin can serve it
// otherwise. Other remote-tracking refs are deliberately not used: a branch
// that was pushed and then deleted leaves a stale remote-tracking ref, and a
// commit reachable only from it would become an unfetchable prerequisite
// (TestCreateWIPBundlePreservesHeadWhenRemoteTrackingRefIsStale). Without a
// default-branch ref the bundle stays self-contained, as it was before.
func snapshotWIPBundleBasis(ctx context.Context, git snapshotGitCommand) []string {
	commit, err := git(ctx, nil, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}")
	commit = strings.TrimSpace(commit)
	if err != nil || !isSnapshotObjectID(commit) {
		// Visible on purpose: without a basis the bundle silently grows back to
		// the full branch history that kept idle sessions awake.
		slog.Warn("Snapshot WIP bundle basis unavailable; bundling full branch history",
			"ref", "refs/remotes/origin/HEAD", "resolved", commit, "error", err)
		return nil
	}
	return []string{"^" + commit}
}

// snapshotBundlePrerequisites lists the commits a Git bundle requires the
// receiving repository to already contain (its "-<oid>" header lines, in both
// the v2 and v3 formats). Self-contained bundles, including every bundle
// written before snapshotWIPBundleBasis existed, have none.
func snapshotBundlePrerequisites(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, snapshotBundleHeaderMaxBytes))
	signature, err := reader.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("read snapshot bundle header: %w", err)
	}
	if signature = strings.TrimSpace(signature); signature != "# v2 git bundle" && signature != "# v3 git bundle" {
		return nil, fmt.Errorf("snapshot bundle has unsupported header %q", signature)
	}
	var prerequisites []string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("snapshot bundle header is truncated: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			return prerequisites, nil
		}
		if !strings.HasPrefix(line, "-") {
			continue
		}
		commit, _, _ := strings.Cut(strings.TrimPrefix(line, "-"), " ")
		if !isSnapshotObjectID(commit) {
			return nil, fmt.Errorf("snapshot bundle prerequisite %q is not a full Git object ID", commit)
		}
		prerequisites = append(prerequisites, commit)
	}
}

// ensureSnapshotBundlePrerequisites makes every prerequisite commit available
// before `git fetch <bundle>`, which otherwise fails with "Repository lacks
// these prerequisite commits". A wake clone normally has them, because they are
// default-branch history. If it does not (a single-branch clone, or a clone
// older than the default branch it was captured against), origin's branches are
// refreshed once, and any commit still missing is recovered the same way the
// saved HEAD is.
func ensureSnapshotBundlePrerequisites(ctx context.Context, git snapshotGitCommand, bundlePath string, state snapshotGitState) error {
	prerequisites, err := snapshotBundlePrerequisites(bundlePath)
	if err != nil {
		return err
	}
	var missing []string
	for _, commit := range prerequisites {
		if !snapshotCommitAvailable(ctx, git, commit) {
			missing = append(missing, commit)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	for _, remote := range snapshotFetchRemotes(ctx, git, state.Git) {
		_, _ = git(ctx, nil, "fetch", "--no-tags", "--", remote)
	}
	for _, commit := range missing {
		if err := ensureSnapshotCommitAvailable(ctx, git, snapshotGitState{BaseCommit: commit, Git: state.Git}); err != nil {
			return fmt.Errorf("restore snapshot bundle prerequisite %s: %w", commit, err)
		}
	}
	return nil
}
