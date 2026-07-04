package handoff

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/transcript"
)

const (
	currentVersion = 1
)

// TerminalStatus is the harness-normalized session terminal status.
type TerminalStatus string

const (
	StatusSuccess    TerminalStatus = "success"
	StatusIncomplete TerminalStatus = "incomplete"
	StatusError      TerminalStatus = "error"
)

// Input is the complete set of harness state used to generate a handoff.
type Input struct {
	MissionID      string
	FromTaskID     string
	ToTaskID       *string
	SessionID      string
	TaskPrompt     string
	TerminalStatus TerminalStatus
	StopReason     string
	TurnsUsed      int
	Messages       []llm.Message
	Transcript     *transcript.Log
	TranscriptPath string
	WorkDir        string
	Now            time.Time
}

// Generate creates a platform-shaped handoff packet. LLM failures and malformed
// structured output never fail generation; they return a mechanical fallback.
func Generate(ctx context.Context, provider llm.Provider, in Input) Packet {
	now := in.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	artifacts := artifactRefs(in)
	fallback := fallbackPacket(in, artifacts, now, "mechanical fallback")
	if provider == nil {
		return fallback
	}

	resp, err := provider.SendMessage(ctx, handoffPrompt(in), nil)
	if err != nil {
		return fallbackPacket(in, artifacts, now, fmt.Sprintf("LLM handoff generation failed: %v", err))
	}

	structured, err := parseStructured(resp.Content)
	if err != nil || strings.TrimSpace(structured.Summary) == "" {
		reason := "LLM handoff generation returned malformed JSON"
		if err != nil {
			reason = err.Error()
		}
		return fallbackPacket(in, artifacts, now, reason)
	}

	return Packet{
		ID:               packetID(now),
		MissionID:        in.MissionID,
		FromTaskID:       fromTaskID(in),
		ToTaskID:         in.ToTaskID,
		Summary:          strings.TrimSpace(structured.Summary),
		Facts:            cleanFacts(structured.Facts),
		OpenQuestions:    cleanStrings(structured.OpenQuestions),
		ArtifactRefs:     artifacts,
		SuggestedActions: cleanStrings(structured.SuggestedActions),
		Version:          currentVersion,
		CreatedAt:        now.UnixMilli(),
	}
}

type structuredOutput struct {
	Summary          string   `json:"summary"`
	Facts            []Fact   `json:"facts"`
	OpenQuestions    []string `json:"openQuestions"`
	SuggestedActions []string `json:"suggestedActions"`
}

func handoffPrompt(in Input) []llm.Message {
	var b strings.Builder
	b.WriteString("Generate a SAM session handoff packet as strict JSON.\n")
	b.WriteString("Return exactly this object shape and no markdown: ")
	b.WriteString(`{"summary":"...","facts":[{"key":"...","value":"..."}],"openQuestions":["..."],"suggestedActions":["..."]}`)
	b.WriteString("\n\nSummarize what was attempted and accomplished. Extract durable facts, unresolved questions, and suggested next actions.\n")
	fmt.Fprintf(&b, "\nTask prompt:\n%s\n", in.TaskPrompt)
	fmt.Fprintf(&b, "\nTerminal status: %s\nStop reason: %s\nTurns used: %d\n", in.TerminalStatus, in.StopReason, in.TurnsUsed)
	b.WriteString("\nConversation excerpt:\n")
	for _, msg := range tailMessages(in.Messages, 12) {
		content := strings.TrimSpace(msg.Content)
		if content == "" && msg.ToolResult != nil {
			content = msg.ToolResult.Content
		}
		if content == "" {
			continue
		}
		fmt.Fprintf(&b, "- %s: %s\n", msg.Role, truncate(content, 1200))
	}

	return []llm.Message{
		{Role: llm.RoleSystem, Content: "You produce strict JSON for a coding-agent handoff. Do not include markdown fences."},
		{Role: llm.RoleUser, Content: b.String()},
	}
}

func parseStructured(content string) (structuredOutput, error) {
	var out structuredOutput
	raw := strings.TrimSpace(content)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return structuredOutput{}, fmt.Errorf("LLM handoff generation returned malformed JSON: %w", err)
	}
	return out, nil
}

func fallbackPacket(in Input, artifacts []ArtifactRef, now time.Time, reason string) Packet {
	facts := []Fact{
		{Key: "terminalStatus", Value: string(in.TerminalStatus)},
		{Key: "stopReason", Value: in.StopReason},
		{Key: "turnsUsed", Value: fmt.Sprintf("%d", in.TurnsUsed)},
	}
	if strings.TrimSpace(reason) != "" {
		facts = append(facts, Fact{Key: "handoffGeneration", Value: reason})
	}
	summary := fmt.Sprintf("Task prompt: %s\n\nSession ended with status %s after %d turns.",
		strings.TrimSpace(in.TaskPrompt), in.TerminalStatus, in.TurnsUsed)

	return Packet{
		ID:               packetID(now),
		MissionID:        in.MissionID,
		FromTaskID:       fromTaskID(in),
		ToTaskID:         in.ToTaskID,
		Summary:          summary,
		Facts:            facts,
		OpenQuestions:    []string{"Review the transcript for details not captured in the mechanical fallback."},
		ArtifactRefs:     artifacts,
		SuggestedActions: []string{"Review the transcript and continue from the recorded terminal status."},
		Version:          currentVersion,
		CreatedAt:        now.UnixMilli(),
	}
}

func artifactRefs(in Input) []ArtifactRef {
	seen := map[string]bool{}
	var refs []ArtifactRef
	add := func(ref ArtifactRef) {
		if strings.TrimSpace(ref.Ref) == "" {
			return
		}
		key := string(ref.Type) + "\x00" + ref.Ref
		if seen[key] {
			return
		}
		seen[key] = true
		refs = append(refs, ref)
	}

	add(ArtifactRef{Type: ArtifactFile, Ref: in.TranscriptPath, Description: "Session transcript"})
	for _, path := range modifiedFiles(in.Transcript) {
		add(ArtifactRef{Type: ArtifactFile, Ref: path, Description: "File modified during session"})
	}
	if branch := gitBranch(in.WorkDir); branch != "" {
		add(ArtifactRef{Type: ArtifactBranch, Ref: branch, Description: "Git branch at session end"})
	}
	return refs
}

func modifiedFiles(log *transcript.Log) []string {
	if log == nil {
		return nil
	}
	toolCalls := map[string]struct {
		name   string
		params map[string]any
	}{}
	success := map[string]bool{}

	for _, event := range log.Events() {
		data, ok := event.Data.(map[string]any)
		if !ok {
			continue
		}
		switch event.Type {
		case transcript.EventToolCall:
			id, _ := data["id"].(string)
			name, _ := data["name"].(string)
			params, _ := data["params"].(map[string]any)
			if id != "" {
				toolCalls[id] = struct {
					name   string
					params map[string]any
				}{name: name, params: params}
			}
		case transcript.EventToolResult:
			id, _ := data["call_id"].(string)
			isError, _ := data["is_error"].(bool)
			if id != "" && !isError {
				success[id] = true
			}
		}
	}

	files := map[string]bool{}
	for id, call := range toolCalls {
		if !success[id] {
			continue
		}
		switch call.name {
		case "write_file", "edit_file":
			if path, _ := call.params["path"].(string); path != "" {
				files[path] = true
			}
		case "apply_diff":
			if diff, _ := call.params["diff"].(string); diff != "" {
				for _, path := range pathsFromDiff(diff) {
					files[path] = true
				}
			}
		}
	}

	out := make([]string, 0, len(files))
	for path := range files {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

func pathsFromDiff(diff string) []string {
	files := map[string]bool{}
	for _, line := range strings.Split(diff, "\n") {
		if !strings.HasPrefix(line, "+++ ") {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(line, "+++ "))
		path = strings.TrimPrefix(path, "b/")
		if path != "" && path != "/dev/null" {
			files[path] = true
		}
	}
	out := make([]string, 0, len(files))
	for path := range files {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

func gitBranch(workDir string) string {
	if strings.TrimSpace(workDir) == "" {
		return ""
	}
	cmd := exec.Command("git", "-C", workDir, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(string(out))
	if branch == "HEAD" {
		return ""
	}
	return branch
}

func fromTaskID(in Input) string {
	if in.FromTaskID != "" {
		return in.FromTaskID
	}
	if in.SessionID != "" {
		return in.SessionID
	}
	return "local-session"
}

func packetID(now time.Time) string {
	return fmt.Sprintf("handoff-%d", now.UnixNano())
}

func tailMessages(messages []llm.Message, max int) []llm.Message {
	if len(messages) <= max {
		return messages
	}
	return messages[len(messages)-max:]
}

func cleanFacts(facts []Fact) []Fact {
	out := make([]Fact, 0, len(facts))
	for _, fact := range facts {
		key := strings.TrimSpace(fact.Key)
		value := strings.TrimSpace(fact.Value)
		if key == "" || value == "" {
			continue
		}
		out = append(out, Fact{Key: key, Value: value})
	}
	return out
}

func cleanStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}

// HandoffPathForTranscript returns the default sidecar path for a transcript.
func HandoffPathForTranscript(transcriptPath string) string {
	if transcriptPath == "" {
		return ""
	}
	ext := filepath.Ext(transcriptPath)
	if ext == "" {
		return transcriptPath + ".handoff.json"
	}
	return strings.TrimSuffix(transcriptPath, ext) + ".handoff.json"
}
