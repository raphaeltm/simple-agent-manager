package server

import (
	"context"
	"fmt"
	"strings"
)

type snapshotGitMetadata struct {
	Branch   string `json:"branch,omitempty"`
	Upstream string `json:"upstream,omitempty"`
	Remote   string `json:"remote,omitempty"`
	Detached bool   `json:"detached"`
}

type snapshotGitState struct {
	BaseCommit string
	Git        *snapshotGitMetadata
}

type snapshotGitCommand func(context.Context, []string, ...string) (string, error)

func standaloneSnapshotGit(workDir string) snapshotGitCommand {
	return func(ctx context.Context, env []string, args ...string) (string, error) {
		return runStandaloneGitCommand(ctx, workDir, env, args...)
	}
}

func captureStandaloneSnapshotGitState(ctx context.Context, workDir string) (snapshotGitState, error) {
	return captureSnapshotGitState(ctx, standaloneSnapshotGit(workDir))
}

func captureSnapshotGitState(ctx context.Context, git snapshotGitCommand) (snapshotGitState, error) {
	baseCommit, err := git(ctx, nil, "rev-parse", "HEAD")
	if err != nil {
		return snapshotGitState{}, fmt.Errorf("resolve snapshot base commit: %w", err)
	}
	state := snapshotGitState{BaseCommit: strings.TrimSpace(baseCommit)}
	branch, branchErr := git(ctx, nil, "rev-parse", "--abbrev-ref", "HEAD")
	if branchErr != nil {
		return snapshotGitState{}, fmt.Errorf("resolve snapshot branch: %w", branchErr)
	}
	metadata := &snapshotGitMetadata{}
	if strings.TrimSpace(branch) == "HEAD" {
		metadata.Detached = true
	} else {
		metadata.Branch = strings.TrimSpace(branch)
		if upstream, upstreamErr := git(ctx, nil, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); upstreamErr == nil {
			metadata.Upstream = strings.TrimSpace(upstream)
		}
		if metadata.Branch != "" {
			if remote, remoteErr := git(ctx, nil, "for-each-ref", "--count=1", "--format=%(upstream:remotename)", "refs/heads/"+metadata.Branch); remoteErr == nil {
				metadata.Remote = strings.TrimSpace(remote)
			}
			if metadata.Remote != "origin" || metadata.Upstream != "origin/"+metadata.Branch {
				metadata.Upstream = ""
				metadata.Remote = ""
			}
		}
	}
	state.Git = metadata
	return state, nil
}

func validateCapturedSnapshotGitState(ctx context.Context, git snapshotGitCommand, expected snapshotGitState) error {
	actual, err := captureSnapshotGitState(ctx, git)
	if err != nil {
		return fmt.Errorf("validate snapshot Git state after capture: %w", err)
	}
	if actual.BaseCommit != expected.BaseCommit || !sameSnapshotGitMetadata(actual.Git, expected.Git) {
		return fmt.Errorf(
			"snapshot Git state changed during capture: expected HEAD %s (%s), actual HEAD %s (%s)",
			expected.BaseCommit,
			describeSnapshotGitMetadata(expected.Git),
			actual.BaseCommit,
			describeSnapshotGitMetadata(actual.Git),
		)
	}
	return validateSnapshotGitMetadata(ctx, git, actual.Git)
}

func sameSnapshotGitMetadata(left, right *snapshotGitMetadata) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Branch == right.Branch &&
		left.Upstream == right.Upstream &&
		left.Remote == right.Remote &&
		left.Detached == right.Detached
}

func describeSnapshotGitMetadata(metadata *snapshotGitMetadata) string {
	if metadata == nil {
		return "legacy ref metadata"
	}
	if metadata.Detached {
		return "detached HEAD"
	}
	if metadata.Upstream != "" {
		return fmt.Sprintf("branch %q tracking %q", metadata.Branch, metadata.Upstream)
	}
	return fmt.Sprintf("branch %q", metadata.Branch)
}

func restoreStandaloneSnapshotGitState(ctx context.Context, workDir string, state snapshotGitState) error {
	return restoreSnapshotGitState(ctx, standaloneSnapshotGit(workDir), state)
}

func validateStandaloneSnapshotGitState(ctx context.Context, workDir string, state snapshotGitState) error {
	return validateSnapshotGitState(ctx, standaloneSnapshotGit(workDir), state)
}

func restoreSnapshotGitState(ctx context.Context, git snapshotGitCommand, state snapshotGitState) error {
	state.BaseCommit = strings.TrimSpace(state.BaseCommit)
	if state.BaseCommit == "" {
		return nil
	}
	if !isSnapshotObjectID(state.BaseCommit) {
		return fmt.Errorf("restore snapshot Git state: saved BaseCommit %q is not a full Git object ID", state.BaseCommit)
	}
	if err := validateSnapshotGitMetadata(ctx, git, state.Git); err != nil {
		return err
	}
	if err := ensureSnapshotCommitAvailable(ctx, git, state); err != nil {
		return err
	}
	if state.Git == nil {
		if output, err := git(ctx, nil, "reset", "--hard", state.BaseCommit); err != nil {
			return fmt.Errorf("restore snapshot HEAD %s: %w: %s", state.BaseCommit, err, output)
		}
		return validateSnapshotGitState(ctx, git, state)
	}
	if state.Git.Detached {
		if output, err := git(ctx, nil, "checkout", "--detach", "--force", state.BaseCommit); err != nil {
			return fmt.Errorf("restore detached snapshot HEAD %s: %w: %s", state.BaseCommit, err, output)
		}
		return validateSnapshotGitState(ctx, git, state)
	}
	return restoreSnapshotBranchState(ctx, git, state)
}

func restoreSnapshotBranchState(ctx context.Context, git snapshotGitCommand, state snapshotGitState) error {
	branch := strings.TrimSpace(state.Git.Branch)
	if output, err := git(ctx, nil, "checkout", "--force", "-B", branch, state.BaseCommit); err != nil {
		return fmt.Errorf("restore snapshot branch %q at %s: %w: %s", branch, state.BaseCommit, err, output)
	}
	upstream := strings.TrimSpace(state.Git.Upstream)
	if upstream == "" {
		_, _ = git(ctx, nil, "branch", "--unset-upstream", branch)
	} else {
		if err := ensureSnapshotUpstreamAvailable(ctx, git, state); err != nil {
			return err
		}
		remote := strings.TrimSpace(state.Git.Remote)
		upstreamBranch := strings.TrimPrefix(upstream, remote+"/")
		if output, err := git(ctx, nil, "config", "--local", "branch."+branch+".remote", remote); err != nil {
			return fmt.Errorf("restore snapshot remote %q for branch %q: %w: %s", remote, branch, err, output)
		}
		if output, err := git(ctx, nil, "config", "--local", "branch."+branch+".merge", "refs/heads/"+upstreamBranch); err != nil {
			return fmt.Errorf("restore snapshot upstream %q for branch %q: %w: %s", upstream, branch, err, output)
		}
	}
	return validateSnapshotGitState(ctx, git, state)
}

func validateSnapshotGitMetadata(ctx context.Context, git snapshotGitCommand, metadata *snapshotGitMetadata) error {
	if metadata == nil {
		return nil
	}
	branch := strings.TrimSpace(metadata.Branch)
	upstream := strings.TrimSpace(metadata.Upstream)
	remote := strings.TrimSpace(metadata.Remote)
	if metadata.Detached {
		if branch != "" || upstream != "" || remote != "" {
			return fmt.Errorf("restore snapshot Git state: detached metadata includes branch or upstream state")
		}
		return nil
	}
	if branch == "" {
		return fmt.Errorf("restore snapshot Git state: saved checkout is neither a branch nor detached")
	}
	if output, err := git(ctx, nil, "check-ref-format", "--branch", branch); err != nil {
		return fmt.Errorf("restore snapshot Git state: invalid saved branch: %w: %s", err, output)
	}
	if upstream == "" {
		if remote != "" {
			return fmt.Errorf("restore snapshot Git state: saved remote has no upstream")
		}
		return nil
	}
	if remote != "origin" || !strings.HasPrefix(upstream, "origin/") {
		return fmt.Errorf("restore snapshot Git state: saved upstream is not available from the canonical remote")
	}
	if output, err := git(ctx, nil, "check-ref-format", "--branch", strings.TrimPrefix(upstream, "origin/")); err != nil {
		return fmt.Errorf("restore snapshot Git state: invalid saved upstream: %w: %s", err, output)
	}
	return nil
}

func ensureSnapshotCommitAvailable(ctx context.Context, git snapshotGitCommand, state snapshotGitState) error {
	if snapshotCommitAvailable(ctx, git, state.BaseCommit) {
		return nil
	}
	var diagnostics []string
	for _, remote := range snapshotFetchRemotes(ctx, git, state.Git) {
		if state.Git != nil && state.Git.Branch != "" {
			refspec := "+refs/heads/" + state.Git.Branch + ":refs/remotes/" + remote + "/" + state.Git.Branch
			if _, err := git(ctx, nil, "fetch", "--no-tags", "--", remote, refspec); err != nil {
				diagnostics = append(diagnostics, fmt.Sprintf("fetch %s branch: %v", remote, err))
			}
			if snapshotCommitAvailable(ctx, git, state.BaseCommit) {
				return nil
			}
		}
		if _, err := git(ctx, nil, "fetch", "--no-tags", "--", remote, state.BaseCommit); err != nil {
			diagnostics = append(diagnostics, fmt.Sprintf("fetch %s saved commit: %v", remote, err))
		}
		if snapshotCommitAvailable(ctx, git, state.BaseCommit) {
			return nil
		}
	}
	actual, _ := git(ctx, nil, "rev-parse", "HEAD")
	return fmt.Errorf("restore snapshot Git state: expected HEAD %s, actual HEAD %s; saved commit is unavailable (%s)", state.BaseCommit, strings.TrimSpace(actual), strings.Join(diagnostics, "; "))
}

func ensureSnapshotUpstreamAvailable(ctx context.Context, git snapshotGitCommand, state snapshotGitState) error {
	upstream := strings.TrimSpace(state.Git.Upstream)
	remote := strings.TrimSpace(state.Git.Remote)
	if remote == "" || !strings.HasPrefix(upstream, remote+"/") {
		return fmt.Errorf("restore snapshot upstream %q: saved remote metadata is unavailable", upstream)
	}
	branch := strings.TrimPrefix(upstream, remote+"/")
	remoteTrackingRef := "refs/remotes/" + remote + "/" + branch
	refspec := "+refs/heads/" + branch + ":" + remoteTrackingRef
	if _, err := git(ctx, nil, "rev-parse", "--verify", remoteTrackingRef); err != nil {
		if _, err := git(ctx, nil, "fetch", "--no-tags", "--", remote, refspec); err != nil {
			return fmt.Errorf("restore snapshot upstream %q from remote %q: %w", upstream, remote, err)
		}
	}
	if _, err := git(ctx, nil, "rev-parse", "--verify", remoteTrackingRef); err != nil {
		return fmt.Errorf("restore snapshot upstream %q: fetched ref is unavailable", upstream)
	}
	fetchRefspecs, _ := git(ctx, nil, "config", "--local", "--get-all", "remote."+remote+".fetch")
	found := false
	for _, configured := range strings.Split(fetchRefspecs, "\n") {
		if strings.TrimSpace(configured) == refspec {
			found = true
			break
		}
	}
	if !found {
		if output, err := git(ctx, nil, "config", "--local", "--add", "remote."+remote+".fetch", refspec); err != nil {
			return fmt.Errorf("restore snapshot fetch mapping for upstream %q: %w: %s", upstream, err, output)
		}
	}
	return nil
}

func snapshotFetchRemotes(ctx context.Context, git snapshotGitCommand, _ *snapshotGitMetadata) []string {
	available, err := git(ctx, nil, "remote")
	if err != nil {
		return nil
	}
	for _, remote := range strings.Fields(available) {
		if remote == "origin" {
			return []string{"origin"}
		}
	}
	return nil
}

func snapshotCommitAvailable(ctx context.Context, git snapshotGitCommand, commit string) bool {
	_, err := git(ctx, nil, "cat-file", "-e", strings.TrimSpace(commit)+"^{commit}")
	return err == nil
}

func isSnapshotObjectID(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		switch {
		case char >= '0' && char <= '9', char >= 'a' && char <= 'f', char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

func validateSnapshotGitState(ctx context.Context, git snapshotGitCommand, state snapshotGitState) error {
	expected := strings.TrimSpace(state.BaseCommit)
	if expected == "" {
		return nil
	}
	actual, err := git(ctx, nil, "rev-parse", "HEAD")
	actual = strings.TrimSpace(actual)
	if err != nil || actual != expected {
		return fmt.Errorf("snapshot Git HEAD mismatch: expected %s, actual %s", expected, actual)
	}
	if state.Git == nil {
		return nil
	}
	branch, branchErr := git(ctx, nil, "rev-parse", "--abbrev-ref", "HEAD")
	branch = strings.TrimSpace(branch)
	if state.Git.Detached {
		if branchErr != nil || branch != "HEAD" {
			return fmt.Errorf("snapshot Git ref mismatch: expected detached HEAD at %s, actual branch %s", expected, branch)
		}
		return nil
	}
	if branchErr != nil || branch != strings.TrimSpace(state.Git.Branch) {
		return fmt.Errorf("snapshot Git branch mismatch: expected %q, actual %q", state.Git.Branch, branch)
	}
	expectedUpstream := strings.TrimSpace(state.Git.Upstream)
	actualUpstream, upstreamErr := git(ctx, nil, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	actualUpstream = strings.TrimSpace(actualUpstream)
	if expectedUpstream == "" {
		if upstreamErr == nil && actualUpstream != "" {
			return fmt.Errorf("snapshot Git upstream mismatch: expected none, actual %q", actualUpstream)
		}
		return nil
	}
	if upstreamErr != nil || actualUpstream != expectedUpstream {
		return fmt.Errorf("snapshot Git upstream mismatch: expected %q, actual %q", expectedUpstream, actualUpstream)
	}
	return nil
}
