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
	var cloneSource string
	switch family {
	case "settings":
		path = projectAPIPath(project, "cli", "settings")
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
		path = projectAPIPath(project, "cli", family)
		if action == "create" {
			method = http.MethodPost
		} else {
			if len(args) != 1 {
				return fail(runtime.Stderr, fmt.Errorf("update/clone requires one name or ID"))
			}
			id, e := resolveNamedResource(ctx, client, project, apiFamily, args[0])
			if e != nil {
				return fail(runtime.Stderr, e)
			}
			var current map[string]any
			if e = client.request(ctx, http.MethodGet, projectAPIPath(project, apiFamily, id), nil, &current); e != nil {
				return fail(runtime.Stderr, e)
			}
			if action == "clone" {
				if p.Flags["name"] == "" {
					return fail(runtime.Stderr, fmt.Errorf("clone requires --name for a new project resource"))
				}
				if _, ok := fields["description"]; !ok {
					if v, exists := current["description"]; exists {
						fields["description"] = v
					}
				}
				method = http.MethodPost
				cloneSource = id
				break
			}
			if current["projectId"] != project {
				return fail(runtime.Stderr, fmt.Errorf("shared/global resources cannot be updated through project commands"))
			}
			path = projectAPIPath(project, "cli", family, id)
			version, _ := current["updatedAt"].(string)
			if v := p.Flags["expected-updated-at"]; v != "" {
				version = v
			}
			if version == "" {
				return fail(runtime.Stderr, fmt.Errorf("resource version unavailable"))
			}
			fields["expectedUpdatedAt"] = version
		}
	default:
		return fail(runtime.Stderr, fmt.Errorf("unsupported mutation"))
	}
	fieldCount := len(fields)
	if _, ok := fields["expectedUpdatedAt"]; ok {
		fieldCount--
	}
	if fieldCount == 0 {
		return fail(runtime.Stderr, fmt.Errorf("no approved fields specified"))
	}
	if p.Bools["preview"] {
		return writeWorkflow(runtime, p, map[string]any{"preview": true, "method": method, "path": path, "fields": fields})
	}
	if family == "settings" {
		var current map[string]any
		if err = client.request(ctx, http.MethodGet, projectAPIPath(project), nil, &current); err != nil {
			return fail(runtime.Stderr, err)
		}
		version, _ := current["updatedAt"].(string)
		if version == "" {
			return fail(runtime.Stderr, fmt.Errorf("project version unavailable"))
		}
		fields["expectedUpdatedAt"] = version
	}

	client.idempotencyKey = p.Flags["idempotency-key"]
	var value any
	if err = client.request(ctx, method, path, fields, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	if cloneSource != "" {
		return writeWorkflow(runtime, p, map[string]any{"created": value, "sourceId": cloneSource, "configurationCopied": false, "copiedFields": []string{"description"}})
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
	var assets map[string]any
	if readErr := client.request(ctx, http.MethodGet, projectAPIPath(project, "runtime-config"), nil, &assets); readErr != nil {
		safe["runtimeConfig"] = map[string]any{"available": false}
	} else {
		masked := map[string]any{}
		for _, kind := range []string{"envVars", "files"} {
			var rows []any
			for _, row := range anyRows(assets[kind]) {
				source, ok := row.(map[string]any)
				if !ok {
					continue
				}
				metadata := map[string]any{"value": "REDACTED"}
				for _, key := range []string{"key", "path", "isSecret", "hasValue", "createdAt", "updatedAt"} {
					if v, exists := source[key]; exists {
						metadata[key] = v
					}
				}
				rows = append(rows, metadata)
			}
			masked[kind] = rows
		}
		safe["runtimeConfig"] = masked
	}
	safe["resolutionOrder"] = []string{"explicit task", "skill/profile", "project agent defaults", "user agent settings", "platform defaults"}
	if defaults, ok := value["agentDefaults"].(map[string]any); ok {
		safe["agentDefaults"] = defaults
	}
	return writeWorkflow(runtime, p, safe)
}

func anyRows(v any) []any { rows, _ := v.([]any); return rows }
