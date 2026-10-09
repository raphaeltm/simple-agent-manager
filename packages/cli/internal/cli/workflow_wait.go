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
	for name, target := range map[string]*time.Duration{"timeout": &timeout, "interval": &interval} {
		if raw := p.Flags[name]; raw != "" {
			d, err := time.ParseDuration(raw)
			if err != nil || d <= 0 {
				return fail(runtime.Stderr, fmt.Errorf("--%s must be a positive duration", name))
			}
			*target = d
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
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		var value map[string]any
		if err = client.request(ctx, http.MethodGet, projectAPIPath(project, "tasks", args[0]), nil, &value); err != nil {
			return fail(runtime.Stderr, err)
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
			_ = writeWorkflow(runtime, p, map[string]any{"task": value, "outcome": "wait_timeout", "completed": false})
			return 3
		}
	}
}
