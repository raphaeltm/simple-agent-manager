package cli

import (
	"context"
	"fmt"
	"net/http"
)

func runAttentionAnswer(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	if len(args) != 2 || p.Flags["answer"] == "" {
		return fail(runtime.Stderr, fmt.Errorf("chat answer requires <session-id> <marker-id> --answer <exact-option>"))
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var detail map[string]any
	if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", args[0]), nil, &detail); err != nil {
		return fail(runtime.Stderr, err)
	}
	session, _ := detail["session"].(map[string]any)
	attention, _ := session["attention"].(map[string]any)
	if attention["markerId"] != args[1] || attention["kind"] != "needs_input" {
		return fail(runtime.Stderr, fmt.Errorf("answer target is not the current needs_input marker; permission/auth interactions require human action"))
	}
	options, _ := attention["options"].([]any)
	matched := false
	for _, option := range options {
		if option == p.Flags["answer"] {
			matched = true
		}
	}
	if !matched {
		return fail(runtime.Stderr, fmt.Errorf("answer must match an offered option"))
	}
	var value any
	if err = client.request(ctx, http.MethodPost, projectAPIPath(project, "sessions", args[0], "attention", args[1], "resolve"), map[string]any{"answer": p.Flags["answer"]}, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeWorkflow(runtime, p, value)
}
