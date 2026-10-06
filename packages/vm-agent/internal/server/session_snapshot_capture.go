package server

import (
	"context"
	"os"
	"time"
)

type snapshotArtifactCapture struct {
	server            *Server
	target            *containerSnapshotTarget
	workDir, token    string
	prepare           *snapshotPrepareResponse
	threshold, budget int64
	idleTimeout       time.Duration
	progress          *snapshotProgressReporter
	manifest          *snapshotManifest
}

func (c *snapshotArtifactCapture) captureWIP(ctx context.Context) bool {
	var err error
	var baseCommit, wipPath string
	var wipSkipped []snapshotSkippedEntry
	var gitState snapshotGitState
	if c.target == nil {
		baseCommit, wipPath, wipSkipped, err = createWIPBundleWithGitState(ctx, c.workDir, c.threshold, &gitState)
	} else {
		baseCommit, wipPath, wipSkipped, err = c.server.createContainerWIPBundleWithGitState(ctx, c.target, c.threshold, c.budget, c.progress.Report, &gitState)
	}
	c.manifest.BaseCommit = baseCommit
	if baseCommit != "" && err == nil {
		if c.target == nil {
			err = validateCapturedSnapshotGitState(ctx, standaloneSnapshotGit(c.workDir), gitState)
		} else {
			err = validateCapturedSnapshotGitState(ctx, func(ctx context.Context, env []string, args ...string) (string, error) {
				return c.server.containerGit(ctx, c.target, env, args...)
			}, gitState)
		}
		if err == nil {
			c.manifest.Git = gitState.Git
		}
	}
	c.manifest.Skipped = append(c.manifest.Skipped, wipSkipped...)
	wipCaptureFailed := err != nil
	if err != nil {
		c.manifest.Skipped = append(c.manifest.Skipped, snapshotSkippedEntry{Path: c.workDir, Reason: err.Error()})
		if wipPath != "" {
			_ = os.Remove(wipPath)
			wipPath = ""
		}
	}

	if wipPath != "" {
		size, sha, uploadErr := c.server.uploadSessionSnapshotArtifact(ctx, c.prepare.Upload.WIP, c.prepare.DirectUpload.WIP, wipPath, c.token, c.idleTimeout)
		_ = os.Remove(wipPath)
		if uploadErr != nil {
			wipCaptureFailed = true
			c.manifest.Skipped = append(c.manifest.Skipped, snapshotSkippedEntry{Path: c.workDir, Reason: uploadErr.Error()})
		} else {
			c.manifest.Artifacts["wip"] = snapshotArtifact{SizeBytes: size, SHA256: sha}
			c.budget -= size
		}
		c.progress.Report(ctx, "wip-upload")
	}
	return wipCaptureFailed
}

func (c *snapshotArtifactCapture) captureHome(ctx context.Context) bool {
	var err error
	var homePath string
	var homeSkipped []snapshotSkippedEntry
	if c.target == nil {
		homePath, homeSkipped, err = createSessionStateTarWithContext(ctx, os.UserHomeDir, c.threshold, c.budget, true, c.progress.Report)
	} else {
		homePath, homeSkipped, err = c.server.createContainerHomeTar(ctx, c.target, c.threshold, c.budget, c.progress.Report)
	}
	c.progress.Report(ctx, "home-captured")
	c.manifest.Skipped = append(c.manifest.Skipped, homeSkipped...)
	homeCaptureFailed := err != nil
	if err != nil {
		c.manifest.Skipped = append(c.manifest.Skipped, snapshotSkippedEntry{Path: "$HOME", Reason: err.Error()})
	}
	if homePath != "" {
		size, sha, uploadErr := c.server.uploadSessionSnapshotArtifact(ctx, c.prepare.Upload.Home, c.prepare.DirectUpload.Home, homePath, c.token, c.idleTimeout)
		_ = os.Remove(homePath)
		if uploadErr != nil {
			homeCaptureFailed = true
			c.manifest.Skipped = append(c.manifest.Skipped, snapshotSkippedEntry{Path: "$HOME", Reason: uploadErr.Error()})
		} else {
			c.manifest.Artifacts["home"] = snapshotArtifact{SizeBytes: size, SHA256: sha}
		}
		c.progress.Report(ctx, "home-upload")
	}
	if _, ok := c.manifest.Artifacts["home"]; !ok {
		homeCaptureFailed = true
	}
	return homeCaptureFailed
}
