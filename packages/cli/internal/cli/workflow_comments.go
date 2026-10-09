package cli

import (
	"context"
	"fmt"
	"net/http"
)

func runCommentMutation(ctx context.Context, runtime Runtime, p parsedArgs, action string, args []string) int {
	if len(args) != 2 {
		return fail(runtime.Stderr, fmt.Errorf("comments %s requires <session-id> <message-or-thread-id>", action))
	}
	body := map[string]any{}
	if key := p.Flags["idempotency-key"]; key != "" {
		body["clientMutationId"] = key
	}
	if action == "add" || action == "reply" {
		content, e := readCommandInput(runtime, p, nil, "body")
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		if content == "" {
			return fail(runtime.Stderr, fmt.Errorf("comment requires --body, --body-file or --body-stdin"))
		}
		body["body"] = content
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	segments := []string{"sessions", args[0], "comments"}
	if action == "add" {
		body["messageId"] = args[1]
	} else {
		segments = append(segments, args[1])
		if action == "reply" {
			segments = append(segments, "replies")
		} else {
			segments = append(segments, action)
		}
	}
	var value any
	if err = client.request(ctx, http.MethodPost, projectAPIPath(project, segments...), body, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeWorkflow(runtime, p, value)
}
