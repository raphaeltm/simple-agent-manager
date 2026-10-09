package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Export drains backwards from an immutable high-water message. Appends after
// this snapshot are excluded. Empty/nonadvancing pages fail without output.
func runTranscriptExport(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("chat export requires one full session ID"))
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	maxBytes, err := workflowByteLimit(runtime, "SAM_CLI_MAX_EXPORT_BYTES", 64<<20)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	limit := p.Flags["limit"]
	if limit == "" {
		limit = "100"
	}
	transcript, err := collectTranscript(ctx, client, project, args[0], limit, maxBytes)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if p.Bools["hydrate-tools"] {
		if err = hydrateTranscript(ctx, client, project, args[0], &transcript, maxBytes); err != nil {
			return fail(runtime.Stderr, err)
		}
	}
	messages, snapshot := transcript.messages, transcript.snapshot
	value := map[string]any{"sessionId": args[0], "messages": messages, "complete": true, "snapshotCursor": snapshot, "archivedToolContentHydrated": p.Bools["hydrate-tools"]}
	data, err := encodeTranscript(value, messages, p.Bools["ndjson"])
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeTranscriptExport(runtime, p, transcript, data)
}

func writeTranscriptExport(runtime Runtime, p parsedArgs, transcript transcriptResult, data []byte) int {
	if output := p.Flags["output"]; output != "" {
		// Refuse overwrite; incomplete exports never leave a misleading artifact.
		f, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		_, e = f.Write(data)
		closeErr := f.Close()
		if e != nil || closeErr != nil {
			_ = os.Remove(output)
			return fail(runtime.Stderr, fmt.Errorf("failed to write transcript export"))
		}
		return writeWorkflow(runtime, p, map[string]any{"output": output, "complete": true, "messageCount": len(transcript.messages), "snapshotCursor": transcript.snapshot})
	}
	_, err := runtime.Stdout.Write(data)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return 0
}

type transcriptResult struct {
	messages []any
	snapshot string
	bytes    int64
}

func transcriptRows(page map[string]any) ([]any, error) {
	if skipped, ok := page["skippedMessages"].(float64); ok && skipped > 0 {
		return nil, fmt.Errorf("API skipped invalid transcript messages; snapshot incomplete")
	}
	rows, ok := page["messages"].([]any)
	if !ok {
		return nil, fmt.Errorf("invalid transcript messages response")
	}
	if len(rows) == 0 && page["hasMore"] == true {
		return nil, fmt.Errorf("transcript page made no progress; snapshot incomplete")
	}
	return rows, nil
}

func validateTranscriptIDs(rows []any, seen map[string]bool) error {
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			return fmt.Errorf("invalid transcript message")
		}
		id, ok := m["id"].(string)
		if !ok || strings.TrimSpace(id) == "" {
			return fmt.Errorf("transcript row missing ID")
		}
		if seen[id] {
			return fmt.Errorf("duplicate transcript message; snapshot incomplete")
		}
		seen[id] = true
	}
	return nil
}

func (t *transcriptResult) addPage(rows []any, before string, seen map[string]bool, maxBytes int64) (string, error) {
	cursor, err := messageCursor(rows[0])
	if err != nil {
		return "", err
	}
	if cursor == before {
		return "", fmt.Errorf("transcript cursor made no progress")
	}
	if t.snapshot == "" {
		t.snapshot, err = messageCursor(rows[len(rows)-1])
		if err != nil {
			return "", err
		}
	}
	if err = validateTranscriptIDs(rows, seen); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		return "", err
	}
	t.bytes += int64(len(encoded))
	if t.bytes > maxBytes {
		return "", fmt.Errorf("transcript export exceeds SAM_CLI_MAX_EXPORT_BYTES; use explicit pages")
	}
	t.messages = append(rows, t.messages...)
	return cursor, nil
}

func collectTranscript(ctx context.Context, client APIClient, project, session, limit string, maxBytes int64) (transcriptResult, error) {
	var result transcriptResult
	query := url.Values{"limit": {limit}, "compact": {"false"}, "order": {"desc"}}
	seen := map[string]bool{}
	for {
		var page map[string]any
		err := client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", session, "messages")+"?"+query.Encode(), nil, &page)
		if err != nil {
			return result, err
		}
		rows, err := transcriptRows(page)
		if err != nil {
			return result, err
		}
		if len(rows) == 0 {
			return result, nil
		}
		cursor, err := result.addPage(rows, query.Get("before"), seen, maxBytes)
		if err != nil {
			return result, err
		}
		if page["hasMore"] != true {
			return result, nil
		}
		query.Set("before", cursor)
	}
}

func hydrateTranscript(ctx context.Context, client APIClient, project, session string, transcript *transcriptResult, maxBytes int64) error {
	for _, row := range transcript.messages {
		message := row.(map[string]any)
		role, _ := message["role"].(string)
		if role != "tool" && message["toolMetadata"] == nil {
			continue
		}
		id := message["id"].(string)
		var tool map[string]any
		if err := client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", session, "messages", id, "tool-content"), nil, &tool); err != nil {
			return err
		}
		message["toolContent"] = tool
		encoded, err := json.Marshal(tool)
		if err != nil {
			return err
		}
		transcript.bytes += int64(len(encoded))
		if transcript.bytes > maxBytes {
			return fmt.Errorf("hydrated export exceeds SAM_CLI_MAX_EXPORT_BYTES")
		}
	}
	return nil
}

func encodeTranscript(value map[string]any, messages []any, ndjson bool) ([]byte, error) {
	if !ndjson {
		data, err := json.MarshalIndent(value, "", "  ")
		return append(data, '\n'), err
	}
	var data []byte
	for _, row := range messages {
		encoded, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		data = append(data, append(encoded, '\n')...)
	}
	return data, nil
}

func messageCursor(row any) (string, error) {
	m, ok := row.(map[string]any)
	if !ok {
		return "", fmt.Errorf("invalid transcript row")
	}
	id, ok := m["id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return "", fmt.Errorf("transcript row missing ID")
	}
	if m["createdAt"] == nil || m["sequence"] == nil {
		return "", fmt.Errorf("transcript row missing exact cursor metadata")
	}
	b, err := json.Marshal([]any{m["createdAt"], m["sequence"], id})
	return string(b), err
}
