package resourcemon

import "context"

// EvictionSnapshotOutcome describes one completed eviction capture.
type EvictionSnapshotOutcome struct {
	// Quiesced is true only for a capture taken from a stopped source with no other
	// writer. Only a quiesced capture can prove the source's final state was preserved.
	Quiesced bool
}

// captureFinalSnapshot recaptures the now-stopped source so the snapshot the wake restores
// is its final state, not a live checkpoint taken while the agent was still writing.
func (c *EvictionController) captureFinalSnapshot(ctx context.Context, result *EvictionResult) {
	if result.SnapshotQuiesced || c.cfg.FinalSnapshot == nil || ctx.Err() != nil {
		return
	}
	finalCtx, cancel := context.WithTimeout(ctx, c.cfg.FinalSnapshotTimeout)
	defer cancel()
	outcome, err := c.cfg.FinalSnapshot(finalCtx, result.Target)
	if err != nil {
		result.FinalSnapshotError = err
		c.logger.Warn("resourcemon: final eviction snapshot failed; keeping the pre-stop capture",
			"workspaceId", result.Target.WorkspaceID,
			"containerId", result.Target.ContainerID,
			"reason", result.Target.Reason,
			"error", err,
		)
		return
	}
	result.SnapshotQuiesced = outcome.Quiesced
}
