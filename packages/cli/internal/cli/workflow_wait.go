package cli

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

func runTaskWait(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, fmt.Errorf("tasks wait requires a full task ID"))
	}
	timeout := 30 * time.Minute
	interval := 2 * time.Second
	if err := parseWaitDurations(p, &timeout, &interval); err != nil {
		return fail(runtime.Stderr, err)
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		var value map[string]any
		if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "tasks", args[0]), nil, &value); err != nil {
			return writeWaitRequestError(ctx, runtime, p, value, err)
		}
		switch value["status"] {
		case "completed":
			return writeWorkflow(runtime, p, value)
		case "failed", "cancelled":
			if code := writeWorkflow(runtime, p, value); code != 0 {
				return code
			}
			return 4
		}
		if err = sleepContext(ctx, interval); err != nil {
			return writeWaitInterruption(runtime, p, value, ctx.Err())
		}
	}
}

func writeWaitInterruption(runtime Runtime, p parsedArgs, task map[string]any, reason error) int {
	outcome, code := "wait_timeout", 3
	if reason == context.Canceled {
		outcome, code = "wait_cancelled", 130
	}
	if result := writeWorkflow(runtime, p, map[string]any{"task": task, "outcome": outcome, "completed": false}); result != 0 {
		return result
	}
	return code
}

func parseWaitDurations(p parsedArgs, timeout, interval *time.Duration) error {
	for name, target := range map[string]*time.Duration{"timeout": timeout, "interval": interval} {
		if raw := p.Flags[name]; raw != "" {
			d, err := time.ParseDuration(raw)
			if err != nil || d <= 0 {
				return fmt.Errorf("--%s must be a positive duration", name)
			}
			*target = d
		}
	}
	return nil
}

func writeWaitRequestError(ctx context.Context, runtime Runtime, p parsedArgs, task map[string]any, err error) int {
	if ctx.Err() != nil {
		return writeWaitInterruption(runtime, p, task, ctx.Err())
	}
	return fail(runtime.Stderr, err)
}
