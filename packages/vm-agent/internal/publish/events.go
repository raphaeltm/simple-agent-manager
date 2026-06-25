package publish

import "context"

// Event describes publish progress. Details must be bounded and must not include
// signed URLs, callback tokens, registry credentials, or secret values.
type Event struct {
	Status         string         `json:"status,omitempty"`
	CurrentStep    string         `json:"currentStep,omitempty"`
	Level          string         `json:"level,omitempty"`
	EventType      string         `json:"eventType"`
	Message        string         `json:"message"`
	Detail         map[string]any `json:"detail,omitempty"`
	Terminal       bool           `json:"terminal,omitempty"`
	ReleaseID      string         `json:"releaseId,omitempty"`
	ReleaseVersion int            `json:"releaseVersion,omitempty"`
	ReleaseStatus  string         `json:"releaseStatus,omitempty"`
	ErrorMessage   string         `json:"errorMessage,omitempty"`
	ErrorCode      string         `json:"errorCode,omitempty"`
	Retryable      bool           `json:"retryable,omitempty"`
}

// EventSink receives best-effort publish progress.
type EventSink interface {
	Event(ctx context.Context, event Event)
}

type EventFunc func(context.Context, Event)

func (f EventFunc) Event(ctx context.Context, event Event) {
	if f != nil {
		f(ctx, event)
	}
}
