package deploy

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

func volumeMountRootsFromPayload(volumes []VolumeMount) []string {
	roots := make([]string, 0, len(volumes))
	for _, volume := range volumes {
		roots = append(roots, volume.MountRoot)
	}
	return uniqueNonEmptyStrings(roots)
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func subtractVolumeMountRoots(roots []string, keep []string) []string {
	keepSet := make(map[string]struct{}, len(keep))
	for _, root := range uniqueNonEmptyStrings(keep) {
		keepSet[root] = struct{}{}
	}
	var removed []string
	for _, root := range uniqueNonEmptyStrings(roots) {
		if _, ok := keepSet[root]; !ok {
			removed = append(removed, root)
		}
	}
	return removed
}

func (e *Engine) releaseVolumeMountRoots(seq int64) ([]string, error) {
	state, stateErr := e.disk.ReadState(seq)
	if stateErr == nil && len(state.VolumeMountRoots) > 0 {
		return uniqueNonEmptyStrings(state.VolumeMountRoots), nil
	}

	rawCompose, composeErr := e.disk.ReadComposeFile(seq)
	if composeErr != nil {
		if stateErr != nil {
			return nil, fmt.Errorf("%v; %w", stateErr, composeErr)
		}
		return nil, composeErr
	}
	roots, err := extractSAMVolumeMountRoots(rawCompose)
	if err != nil {
		return nil, err
	}
	return roots, nil
}

func (e *Engine) removedVolumeMountRoots(previousSeq int64, nextRoots []string) ([]string, error) {
	previousRoots, err := e.releaseVolumeMountRoots(previousSeq)
	if err != nil {
		return nil, err
	}
	return subtractVolumeMountRoots(previousRoots, nextRoots), nil
}

func (e *Engine) teardownVolumeMountRoots(ctx context.Context, roots []string) error {
	roots = uniqueNonEmptyStrings(roots)
	if len(roots) == 0 {
		return nil
	}
	volumeTeardowner, ok := e.cfg.VolumeMounter.(VolumeTeardowner)
	if !ok {
		volumeTeardowner = NewRealVolumeMounter()
	}
	return volumeTeardowner.TeardownMounts(ctx, roots)
}
