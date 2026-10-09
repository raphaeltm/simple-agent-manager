package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

func runSessionAction(ctx context.Context, runtime Runtime, p parsedArgs, action string, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, fmt.Errorf("chat %s requires a full session ID", action))
	}
	if action != "send" && len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("chat %s requires exactly one session ID", action))
	}
	content := ""
	var err error
	if action == "send" {
		content, err = readCommandInput(runtime, p, args[1:], "content")
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		if content == "" {
			return fail(runtime.Stderr, fmt.Errorf("chat send requires content"))
		}
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	path := projectAPIPath(project, "sessions", args[0], "cancel")
	var body map[string]any
	switch action {
	case "send":
		path = projectAPIPath(project, "sessions", args[0], "prompt")
		body = map[string]any{"content": content}
	case "sleep":
		var session map[string]any
		if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", args[0]), nil, &session); err != nil {
			return fail(runtime.Stderr, err)
		}
		metadata, _ := session["session"].(map[string]any)
		workspace, _ := metadata["workspaceId"].(string)
		if workspace == "" {
			return fail(runtime.Stderr, fmt.Errorf("session has no resumable workspace"))
		}
		path = apiWorkspacesPath + url.PathEscape(workspace) + "/sleep"
	}
	client.idempotencyKey = p.Flags["idempotency-key"]
	var value any
	if err = client.request(ctx, http.MethodPost, path, body, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeWorkflow(runtime, p, value)
}
