package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func readCommandInput(runtime Runtime, p parsedArgs, args []string, kind string) (string, error) {
	direct := p.Flags[kind]
	file := p.Flags[kind+"-file"]
	stdin := p.Bools[kind+"-stdin"]
	n := 0
	for _, present := range []bool{direct != "", file != "", stdin, len(args) > 0} {
		if present {
			n++
		}
	}
	if n > 1 {
		return "", fmt.Errorf("choose one of positional %s, --%s, --%s-file or --%s-stdin", kind, kind, kind, kind)
	}
	if file != "" {
		f, err := os.Open(file)
		if err != nil {
			return "", err
		}
		defer f.Close()
		return boundedPrompt(f)
	}
	if stdin {
		return boundedPrompt(runtime.Stdin)
	}
	if len(args) > 0 {
		return strings.Join(args, " "), nil
	}
	return direct, nil
}
func boundedPrompt(r io.Reader) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, 16001))
	if err != nil {
		return "", err
	}
	if len(b) > 16000 {
		return "", fmt.Errorf("prompt input exceeds 16000 bytes")
	}
	return string(b), nil
}

func runMetadataMutation(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	family := p.Positionals[0]
	action := p.Positionals[1]
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	fields := map[string]any{}
	for _, name := range []string{"name", "description", "title", "priority"} {
		if v, ok := p.Flags[name]; ok {
			if name == "priority" {
				n, e := strconv.Atoi(v)
				if e != nil {
					return fail(runtime.Stderr, fmt.Errorf("priority requires an integer"))
				}
				fields[name] = n
			} else {
				fields[name] = v
			}
		}
	}
	path := projectAPIPath(project)
	method := http.MethodPatch
	switch family {
	case "settings":
		if len(args) > 0 {
			return fail(runtime.Stderr, fmt.Errorf("settings update takes no resource ID"))
		}
	case "tasks", "ideas":
		path = projectAPIPath(project, "tasks")
		if action == "create" {
			method = http.MethodPost
		} else {
			if len(args) != 1 {
				return fail(runtime.Stderr, fmt.Errorf("update requires a full task ID"))
			}
			path = projectAPIPath(project, "tasks", args[0])
		}
	case "profiles", "skills":
		apiFamily := "agent-profiles"
		if family == "skills" {
			apiFamily = "skills"
		}
		path = projectAPIPath(project, apiFamily)
		if action == "create" {
			method = http.MethodPost
		} else {
			if len(args) != 1 {
				return fail(runtime.Stderr, fmt.Errorf("update requires one name or ID"))
			}
			id, e := resolveNamedResource(ctx, client, project, apiFamily, args[0])
			if e != nil {
				return fail(runtime.Stderr, e)
			}
			var current map[string]any
			if e = client.request(ctx, http.MethodGet, projectAPIPath(project, apiFamily, id), nil, &current); e != nil {
				return fail(runtime.Stderr, e)
			}
			if current["projectId"] != project {
				return fail(runtime.Stderr, fmt.Errorf("shared/global resources cannot be updated through project commands"))
			}
			path = projectAPIPath(project, apiFamily, id)
			if family == "profiles" {
				method = http.MethodPut
			}
		}
	default:
		return fail(runtime.Stderr, fmt.Errorf("unsupported mutation"))
	}
	if len(fields) == 0 {
		return fail(runtime.Stderr, fmt.Errorf("no approved fields specified"))
	}
	if p.Bools["preview"] {
		return writeWorkflow(runtime, p, map[string]any{"preview": true, "method": method, "path": path, "fields": fields})
	}
	var value any
	if err = client.request(ctx, method, path, fields, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeWorkflow(runtime, p, value)
}
func runSettingsInspect(ctx context.Context, runtime Runtime, p parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var value map[string]any
	if err = client.request(ctx, http.MethodGet, projectAPIPath(project), nil, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	safe := map[string]any{}
	for _, k := range []string{"id", "name", "description", "repository", "defaultBranch", "status", "summary", "defaultAgentProfileId"} {
		if v, ok := value[k]; ok {
			safe[k] = v
		}
	}
	safe["runtimeValues"] = "redacted"
	return writeWorkflow(runtime, p, safe)
}
