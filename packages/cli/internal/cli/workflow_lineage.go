package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func runLineage(ctx context.Context, runtime Runtime, p parsedArgs, action string, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("chat %s requires a full session ID", action))
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
	taskID, _ := session["taskId"].(string)
	if taskID == "" {
		if task, ok := session["task"].(map[string]any); ok {
			taskID, _ = task["id"].(string)
		}
	}
	if taskID == "" {
		return fail(runtime.Stderr, fmt.Errorf("source session has no task lineage"))
	}
	prompt := fmt.Sprintf("Continue work from project %s, session %s, task %s. Inspect the source session and task before acting.", project, args[0], taskID)
	if action == "retry" {
		page, e := drainOriginalPrompt(ctx, client, project, args[0])
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		prompt = fmt.Sprintf("Retry the original request from project %s, session %s, task %s:\n\n%s", project, args[0], taskID, page)
	}
	if !p.Bools["launch"] {
		return writeWorkflow(runtime, p, map[string]any{"preparedPrompt": prompt, "parentTaskId": taskID, "launch": false})
	}
	options, err := parseSubmitOptions(p)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	options.ParentTask = taskID
	return submitTaskWithClient(ctx, runtime, p, client, project, prompt, options)
}
func drainOriginalPrompt(ctx context.Context, client APIClient, project, session string) (string, error) {
	// Ascending role-filtered reads explicitly reach the original prompt rather
	// than guessing from the latest session page.
	var value map[string]any
	err := client.request(ctx, http.MethodGet, projectAPIPath(project, "sessions", session, "messages")+"?roles=user&order=asc&compact=false&limit=1", nil, &value)
	if err != nil {
		return "", err
	}
	rows, _ := value["messages"].([]any)
	if len(rows) == 0 {
		return "", fmt.Errorf("original user prompt unavailable")
	}
	row, _ := rows[0].(map[string]any)
	content, _ := row["content"].(string)
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("original user prompt unavailable")
	}
	return content, nil
}
