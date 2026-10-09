package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
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
	maxBytes := int64(64 << 20)
	if v := runtime.Env.Getenv("SAM_CLI_MAX_EXPORT_BYTES"); v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil || n <= 0 {
			return fail(runtime.Stderr, fmt.Errorf("SAM_CLI_MAX_EXPORT_BYTES must be a positive integer"))
		}
		maxBytes = n
	}
	var exportBytes int64
	limit := p.Flags["limit"]
	if limit == "" {
		limit = "100"
	}
	query := url.Values{"limit": {limit}, "compact": {"false"}, "order": {"desc"}}
	var messages []any
	seen := map[string]bool{}
	var snapshot string
	for {
		var page map[string]any
		err = client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", args[0], "messages")+"?"+query.Encode(), nil, &page)
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		if skipped, ok := page["skippedMessages"].(float64); ok && skipped > 0 {
			return fail(runtime.Stderr, fmt.Errorf("API skipped invalid transcript messages; snapshot incomplete"))
		}
		rows, ok := page["messages"].([]any)
		if !ok {
			return fail(runtime.Stderr, fmt.Errorf("invalid transcript messages response"))
		}
		if len(rows) == 0 {
			if page["hasMore"] == true {
				return fail(runtime.Stderr, fmt.Errorf("transcript page made no progress; snapshot incomplete"))
			}
			break
		}
		cursor, e := messageCursor(rows[0])
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		if cursor == query.Get("before") {
			return fail(runtime.Stderr, fmt.Errorf("transcript cursor made no progress"))
		}
		if snapshot == "" {
			snapshot, e = messageCursor(rows[len(rows)-1])
			if e != nil {
				return fail(runtime.Stderr, e)
			}
		}
		for _, row := range rows {
			m, ok := row.(map[string]any)
			if !ok {
				return fail(runtime.Stderr, fmt.Errorf("invalid transcript message"))
			}
			id, _ := m["id"].(string)
			if seen[id] {
				return fail(runtime.Stderr, fmt.Errorf("duplicate transcript message; snapshot incomplete"))
			}
			seen[id] = true
		}
		encoded, e := json.Marshal(rows)
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		exportBytes += int64(len(encoded))
		if exportBytes > maxBytes {
			return fail(runtime.Stderr, fmt.Errorf("transcript export exceeds SAM_CLI_MAX_EXPORT_BYTES; use explicit pages"))
		}
		messages = append(rows, messages...)
		if page["hasMore"] != true {
			break
		}
		query.Set("before", cursor)
	}
	if p.Bools["hydrate-tools"] {
		for _, row := range messages {
			message := row.(map[string]any)
			role, _ := message["role"].(string)
			if role != "tool" && message["toolMetadata"] == nil {
				continue
			}
			id := message["id"].(string)
			var tool map[string]any
			if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", args[0], "messages", id, "tool-content"), nil, &tool); err != nil {
				return fail(runtime.Stderr, err)
			}
			message["toolContent"] = tool
			encoded, e := json.Marshal(tool)
			if e != nil {
				return fail(runtime.Stderr, e)
			}
			exportBytes += int64(len(encoded))
			if exportBytes > maxBytes {
				return fail(runtime.Stderr, fmt.Errorf("hydrated export exceeds SAM_CLI_MAX_EXPORT_BYTES"))
			}
		}
	}
	value := map[string]any{"sessionId": args[0], "messages": messages, "complete": true, "snapshotCursor": snapshot, "archivedToolContentHydrated": p.Bools["hydrate-tools"]}
	var data []byte
	if p.Bools["ndjson"] {
		for _, row := range messages {
			b, e := json.Marshal(row)
			if e != nil {
				return fail(runtime.Stderr, e)
			}
			data = append(data, append(b, '\n')...)
		}
	} else {
		data, err = json.MarshalIndent(value, "", "  ")
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		data = append(data, '\n')
	}
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
		return writeWorkflow(runtime, p, map[string]any{"output": output, "complete": true, "messageCount": len(messages), "snapshotCursor": snapshot})
	}
	_, err = runtime.Stdout.Write(data)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return 0
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
