// Package features owns the harness feature-list state machine.
package features

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

// Status is the harness-controlled lifecycle state for a feature.
type Status string

const (
	StatusPending    Status = "pending"
	StatusInProgress Status = "in_progress"
	StatusDone       Status = "done"
	StatusBlocked    Status = "blocked"
)

// Feature describes one externally tracked behavior and its required checks.
type Feature struct {
	ID           string   `json:"id"`
	Behavior     string   `json:"behavior"`
	Verification []string `json:"verification"`
	Status       Status   `json:"status"`
	Evidence     []string `json:"evidence"`
}

// List is a concurrency-safe, harness-owned feature state machine.
type List struct {
	mu       sync.Mutex
	features []Feature
}

// New validates and normalizes the supplied features.
func New(input []Feature) (*List, error) {
	features := cloneFeatures(input)
	if len(features) == 0 {
		return nil, errors.New("feature list cannot be empty")
	}

	seen := map[string]bool{}
	inProgress := 0
	for i := range features {
		features[i].ID = strings.TrimSpace(features[i].ID)
		features[i].Behavior = strings.TrimSpace(features[i].Behavior)
		if features[i].ID == "" {
			return nil, fmt.Errorf("feature at index %d has empty id", i)
		}
		if seen[features[i].ID] {
			return nil, fmt.Errorf("duplicate feature id %q", features[i].ID)
		}
		seen[features[i].ID] = true
		if features[i].Behavior == "" {
			return nil, fmt.Errorf("feature %q has empty behavior", features[i].ID)
		}
		for j := range features[i].Verification {
			features[i].Verification[j] = strings.TrimSpace(features[i].Verification[j])
			if features[i].Verification[j] == "" {
				return nil, fmt.Errorf("feature %q has empty verification at index %d", features[i].ID, j)
			}
		}
		for j := range features[i].Evidence {
			features[i].Evidence[j] = strings.TrimSpace(features[i].Evidence[j])
		}
		if features[i].Status == "" {
			features[i].Status = StatusPending
		}
		switch features[i].Status {
		case StatusPending, StatusInProgress, StatusDone, StatusBlocked:
		default:
			return nil, fmt.Errorf("feature %q has invalid status %q", features[i].ID, features[i].Status)
		}
		if features[i].Status == StatusInProgress {
			inProgress++
		}
		if features[i].Status == StatusDone {
			if err := requireEvidence(features[i]); err != nil {
				return nil, err
			}
		}
	}
	if inProgress > 1 {
		return nil, errors.New("feature list violates WIP limit: more than one feature is in_progress")
	}
	return &List{features: features}, nil
}

// LoadFile reads a feature JSON file. It accepts either an array of features
// or an object shaped as {"features": [...]}.
func LoadFile(path string) (*List, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("load features: %w", err)
	}
	return FromJSON(data)
}

// FromJSON parses persisted feature state.
func FromJSON(data []byte) (*List, error) {
	var features []Feature
	if err := json.Unmarshal(data, &features); err == nil && len(features) > 0 {
		return New(features)
	}

	var wrapped struct {
		Features []Feature `json:"features"`
	}
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return nil, fmt.Errorf("parse features: %w", err)
	}
	return New(wrapped.Features)
}

// MarshalJSON returns the canonical persisted representation.
func (l *List) MarshalJSON() ([]byte, error) {
	if l == nil {
		return nil, errors.New("feature list is nil")
	}
	return json.MarshalIndent(l.Snapshot(), "", "  ")
}

// Snapshot returns a stable copy of current feature state.
func (l *List) Snapshot() []Feature {
	l.mu.Lock()
	defer l.mu.Unlock()
	return cloneFeatures(l.features)
}

// AllDone reports whether every feature is done.
func (l *List) AllDone() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, f := range l.features {
		if f.Status != StatusDone {
			return false
		}
	}
	return true
}

// Unfinished returns features that are not done.
func (l *List) Unfinished() []Feature {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []Feature
	for _, f := range l.features {
		if f.Status != StatusDone {
			out = append(out, cloneFeature(f))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Start moves a pending or blocked feature into progress while enforcing WIP=1.
func (l *List) Start(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	idx, err := l.indexLocked(id)
	if err != nil {
		return err
	}
	current := l.features[idx]
	if current.Status == StatusDone {
		return fmt.Errorf("feature %q is already done", id)
	}
	if current.Status == StatusInProgress {
		return fmt.Errorf("feature %q is already in_progress", id)
	}
	for _, f := range l.features {
		if f.ID != id && f.Status == StatusInProgress {
			return fmt.Errorf("cannot start feature %q: feature %q is already in_progress; complete or block it first", id, f.ID)
		}
	}
	l.features[idx].Status = StatusInProgress
	return nil
}

// Complete marks an in-progress feature done after evidence validation.
func (l *List) Complete(id string, evidence []string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	idx, err := l.indexLocked(id)
	if err != nil {
		return err
	}
	if l.features[idx].Status != StatusInProgress {
		return fmt.Errorf("feature %q must be in_progress before it can be completed (current status: %s)", id, l.features[idx].Status)
	}
	l.features[idx].Evidence = trimStrings(evidence)
	if err := requireEvidence(l.features[idx]); err != nil {
		l.features[idx].Status = StatusInProgress
		return err
	}
	l.features[idx].Status = StatusDone
	return nil
}

// Block records a feature as blocked with explanatory evidence.
func (l *List) Block(id string, evidence []string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	idx, err := l.indexLocked(id)
	if err != nil {
		return err
	}
	if l.features[idx].Status == StatusDone {
		return fmt.Errorf("feature %q is already done", id)
	}
	clean := trimStrings(evidence)
	if len(clean) == 0 {
		return fmt.Errorf("feature_block for %q requires evidence explaining the blocker", id)
	}
	l.features[idx].Status = StatusBlocked
	l.features[idx].Evidence = clean
	return nil
}

// Summary renders a compact state report for transcript/CLI output.
func Summary(features []Feature) string {
	if len(features) == 0 {
		return "none"
	}
	var b strings.Builder
	for i, f := range features {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "- %s [%s]: %s", f.ID, f.Status, f.Behavior)
		if len(f.Verification) > 0 {
			b.WriteString("\n  verification:")
			for _, v := range f.Verification {
				fmt.Fprintf(&b, "\n    - %s", v)
			}
		}
		if len(f.Evidence) > 0 {
			b.WriteString("\n  evidence:")
			for _, e := range f.Evidence {
				fmt.Fprintf(&b, "\n    - %s", e)
			}
		}
	}
	return b.String()
}

// NudgeMessage tells the model exactly why the harness did not terminate.
func NudgeMessage(unfinished []Feature, remainingNudges int) string {
	return fmt.Sprintf("Harness termination gate: the task is not complete because these features are unfinished:\n%s\n\nContinue working. Use feature_start before working on one feature, then feature_complete with one evidence entry for each verification item when it is verified. Remaining termination nudges: %d.", Summary(unfinished), remainingNudges)
}

// IncompleteMessage records terminal incomplete status in the transcript/history.
func IncompleteMessage(reason string, unfinished []Feature) string {
	return fmt.Sprintf("Harness terminal status: incomplete\nReason: %s\nUnfinished features:\n%s", reason, Summary(unfinished))
}

func (l *List) indexLocked(id string) (int, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return -1, errors.New("feature id is required")
	}
	for i, f := range l.features {
		if f.ID == id {
			return i, nil
		}
	}
	return -1, fmt.Errorf("unknown feature id %q", id)
}

func requireEvidence(feature Feature) error {
	verificationCount := len(feature.Verification)
	evidence := trimStrings(feature.Evidence)
	if len(evidence) < verificationCount {
		return fmt.Errorf("feature_complete for %q requires evidence for each verification entry: got %d evidence item(s), need %d. Verification entries: %s", feature.ID, len(evidence), verificationCount, strings.Join(feature.Verification, "; "))
	}
	for i := 0; i < verificationCount; i++ {
		if evidence[i] == "" {
			return fmt.Errorf("feature_complete for %q has empty evidence for verification %q", feature.ID, feature.Verification[i])
		}
	}
	return nil
}

func cloneFeatures(in []Feature) []Feature {
	out := make([]Feature, len(in))
	for i := range in {
		out[i] = cloneFeature(in[i])
	}
	return out
}

func cloneFeature(in Feature) Feature {
	out := in
	out.Verification = append([]string(nil), in.Verification...)
	out.Evidence = append([]string(nil), in.Evidence...)
	return out
}

func trimStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}
