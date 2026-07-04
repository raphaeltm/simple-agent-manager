package features

import (
	"context"
	"encoding/json"
	"fmt"
)

// Tool is the minimal interface required by the harness registry.
type Tool interface {
	Name() string
	Description() string
	Schema() map[string]any
	Execute(context.Context, map[string]any) (string, error)
}

// StartTool lets the model request a harness-validated feature start.
type StartTool struct {
	List    *List
	OnState func()
}

func (t *StartTool) Name() string { return "feature_start" }

func (t *StartTool) Description() string {
	return "Request that the harness mark one feature as in_progress. The harness enforces WIP=1."
}

func (t *StartTool) Schema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id"},
		"properties": map[string]any{
			"id": map[string]any{"type": "string", "description": "Feature id to start."},
		},
	}
}

func (t *StartTool) Execute(context.Context, map[string]any) (string, error) {
	return "", fmt.Errorf("feature_start is misconfigured")
}

// CompleteTool lets the model request a harness-validated feature completion.
type CompleteTool struct {
	List    *List
	OnState func()
}

func (t *CompleteTool) Name() string { return "feature_complete" }

func (t *CompleteTool) Description() string {
	return "Request that the harness mark an in-progress feature done. Provide one evidence entry for each verification item."
}

func (t *CompleteTool) Schema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "evidence"},
		"properties": map[string]any{
			"id":       map[string]any{"type": "string", "description": "Feature id to complete."},
			"evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Evidence entries matching the feature verification list."},
		},
	}
}

func (t *CompleteTool) Execute(context.Context, map[string]any) (string, error) {
	return "", fmt.Errorf("feature_complete is misconfigured")
}

// BlockTool lets the model record an explicit blocker. Blocked features still
// prevent successful termination.
type BlockTool struct {
	List    *List
	OnState func()
}

func (t *BlockTool) Name() string { return "feature_block" }

func (t *BlockTool) Description() string {
	return "Request that the harness mark a feature blocked with blocker evidence. Blocked features remain unfinished."
}

func (t *BlockTool) Schema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "evidence"},
		"properties": map[string]any{
			"id":       map[string]any{"type": "string", "description": "Feature id to block."},
			"evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Evidence explaining the blocker."},
		},
	}
}

func (t *BlockTool) Execute(context.Context, map[string]any) (string, error) {
	return "", fmt.Errorf("feature_block is misconfigured")
}

// StatusTool reports current feature state.
type StatusTool struct {
	List *List
}

func (t *StatusTool) Name() string { return "feature_status" }

func (t *StatusTool) Description() string {
	return "Show the current harness-owned feature list and statuses."
}

func (t *StatusTool) Schema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

func (t *StatusTool) Execute(context.Context, map[string]any) (string, error) {
	if t.List == nil {
		return "", fmt.Errorf("feature_status is misconfigured")
	}
	data, err := json.MarshalIndent(t.List.Snapshot(), "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// NewTools returns the internal feature-state tools for a list.
func NewTools(list *List, onState func()) []Tool {
	return []Tool{
		&startTool{StartTool{List: list, OnState: onState}},
		&completeTool{CompleteTool{List: list, OnState: onState}},
		&blockTool{BlockTool{List: list, OnState: onState}},
		&StatusTool{List: list},
	}
}

type startTool struct{ StartTool }

func (t *startTool) Execute(_ context.Context, params map[string]any) (string, error) {
	id, _ := params["id"].(string)
	if err := t.List.Start(id); err != nil {
		return "", err
	}
	if t.OnState != nil {
		t.OnState()
	}
	return fmt.Sprintf("feature %q is now in_progress", id), nil
}

type completeTool struct{ CompleteTool }

func (t *completeTool) Execute(_ context.Context, params map[string]any) (string, error) {
	id, _ := params["id"].(string)
	evidence, err := stringSlice(params["evidence"])
	if err != nil {
		return "", err
	}
	if err := t.List.Complete(id, evidence); err != nil {
		return "", err
	}
	if t.OnState != nil {
		t.OnState()
	}
	return fmt.Sprintf("feature %q is done", id), nil
}

type blockTool struct{ BlockTool }

func (t *blockTool) Execute(_ context.Context, params map[string]any) (string, error) {
	id, _ := params["id"].(string)
	evidence, err := stringSlice(params["evidence"])
	if err != nil {
		return "", err
	}
	if err := t.List.Block(id, evidence); err != nil {
		return "", err
	}
	if t.OnState != nil {
		t.OnState()
	}
	return fmt.Sprintf("feature %q is blocked", id), nil
}

func stringSlice(value any) ([]string, error) {
	raw, ok := value.([]any)
	if !ok {
		if strings, ok := value.([]string); ok {
			return strings, nil
		}
		return nil, fmt.Errorf("evidence must be an array of strings")
	}
	out := make([]string, 0, len(raw))
	for i, item := range raw {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("evidence item %d must be a string", i)
		}
		out = append(out, s)
	}
	return out, nil
}
