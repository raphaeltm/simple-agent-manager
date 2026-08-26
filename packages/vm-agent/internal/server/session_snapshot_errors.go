package server

import (
	"fmt"
	"strings"
)

// sessionSnapshotCaptureError ties a capture failure to the snapshot generation it belongs to,
// so a failure report can be scoped to that generation and a stale one can be ignored.
type sessionSnapshotCaptureError struct {
	generation string
	err        error
}

func (e *sessionSnapshotCaptureError) Error() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e *sessionSnapshotCaptureError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

// newSnapshotResolveError boxes a devcontainer-resolution failure for a capture generation.
//
// This is the ONLY place the "resolve snapshot devcontainer" wrap is produced. It exists as a
// named seam so that isSnapshotTeardownRaceError and its tests exercise the same %w chain the
// capture path actually builds — a hand-duplicated wrap in a test would keep passing if this
// one were ever changed to %v, silently disabling the classification.
// See .claude/rules/67-shared-predicates-that-trigger-actions.md.
func newSnapshotResolveError(generation string, err error) *sessionSnapshotCaptureError {
	return &sessionSnapshotCaptureError{
		generation: generation,
		err:        fmt.Errorf("resolve snapshot devcontainer: %w", err),
	}
}

// snapshotCaptureErrorGeneration walks the error chain for the generation a capture failure
// belongs to, returning "" when the failure is not generation-scoped.
func snapshotCaptureErrorGeneration(err error) string {
	for err != nil {
		if captureErr, ok := err.(*sessionSnapshotCaptureError); ok {
			return strings.TrimSpace(captureErr.generation)
		}
		unwrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return ""
		}
		err = unwrapped.Unwrap()
	}
	return ""
}
