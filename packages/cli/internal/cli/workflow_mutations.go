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
		return boundedPromptForRuntime(runtime, f)
	}
	if stdin {
		return boundedPromptForRuntime(runtime, runtime.Stdin)
	}
	if len(args) > 0 {
		return strings.Join(args, " "), nil
	}
	return direct, nil
}

type metadataMutation struct {
	path, method, cloneSource string
	fields                    map[string]any
}

func metadataFields(p parsedArgs) (map[string]any, error) {
	fields := map[string]any{}
	for _, name := range []string{"name", "description", "title", "priority"} {
		v, ok := p.Flags[name]
		if !ok {
			continue
		}
		if name != "priority" {
			fields[name] = v
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("priority requires an integer")
		}
		fields[name] = n
	}
	return fields, nil
}

func prepareMetadataMutation(ctx context.Context, client APIClient, p parsedArgs, project string, args []string) (metadataMutation, error) {
	fields, err := metadataFields(p)
	m := metadataMutation{path: projectAPIPath(project), method: http.MethodPatch, fields: fields}
	if err != nil {
		return m, err
	}
	switch p.Positionals[0] {
	case "settings":
		m.path = projectAPIPath(project, "cli", "settings")
		if len(args) > 0 {
			return m, fmt.Errorf("settings update takes no resource ID")
		}
	case "tasks", "ideas":
		m.path = projectAPIPath(project, "tasks")
		if p.Positionals[1] == "create" {
			m.method = http.MethodPost
			break
		}
		if len(args) != 1 {
			return m, fmt.Errorf("update requires a full task ID")
		}
		m.path = projectAPIPath(project, "tasks", args[0])
	case "profiles", "skills":
		return prepareNamedMetadata(ctx, client, p, project, args, m)
	default:
		return m, fmt.Errorf("unsupported mutation")
	}
	return m, nil
}

func prepareNamedMetadata(ctx context.Context, client APIClient, p parsedArgs, project string, args []string, m metadataMutation) (metadataMutation, error) {
	family, action := p.Positionals[0], p.Positionals[1]
	apiFamily := "agent-profiles"
	if family == "skills" {
		apiFamily = "skills"
	}
	m.path = projectAPIPath(project, "cli", family)
	if action == "create" {
		m.method = http.MethodPost
		return m, nil
	}
	if len(args) != 1 {
		return m, fmt.Errorf("update/clone requires one name or ID")
	}
	id, err := resolveNamedResource(ctx, client, project, apiFamily, args[0])
	if err != nil {
		return m, err
	}
	var current map[string]any
	if err = client.request(ctx, http.MethodGet, projectAPIPath(project, apiFamily, id), nil, &current); err != nil {
		return m, err
	}
	if action == "clone" {
		return prepareMetadataClone(p, id, current, m)
	}
	if current["projectId"] != project {
		return m, fmt.Errorf("shared/global resources cannot be updated through project commands")
	}
	m.path = projectAPIPath(project, "cli", family, id)
	version, _ := current["updatedAt"].(string)
	if v := p.Flags["expected-updated-at"]; v != "" {
		version = v
	}
	if version == "" {
		return m, fmt.Errorf("resource version unavailable")
	}
	m.fields["expectedUpdatedAt"] = version
	return m, nil
}

func prepareMetadataClone(p parsedArgs, id string, current map[string]any, m metadataMutation) (metadataMutation, error) {
	if p.Flags["name"] == "" {
		return m, fmt.Errorf("clone requires --name for a new project resource")
	}
	if _, ok := m.fields["description"]; !ok {
		if v, exists := current["description"]; exists {
			m.fields["description"] = v
		}
	}
	m.method, m.cloneSource = http.MethodPost, id
	return m, nil
}

func pinSettingsVersion(ctx context.Context, client APIClient, project string, fields map[string]any) error {
	var current map[string]any
	if err := client.request(ctx, http.MethodGet, projectAPIPath(project), nil, &current); err != nil {
		return err
	}
	version, _ := current["updatedAt"].(string)
	if version == "" {
		return fmt.Errorf("project version unavailable")
	}
	fields["expectedUpdatedAt"] = version
	return nil
}

func runMetadataMutation(ctx context.Context, runtime Runtime, p parsedArgs, args []string) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, p, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	m, err := prepareMetadataMutation(ctx, client, p, project, args)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	fieldCount := len(m.fields)
	if _, ok := m.fields["expectedUpdatedAt"]; ok {
		fieldCount--
	}
	if fieldCount == 0 {
		return fail(runtime.Stderr, fmt.Errorf("no approved fields specified"))
	}
	if p.Bools["preview"] {
		return writeWorkflow(runtime, p, map[string]any{"preview": true, "method": m.method, "path": m.path, "fields": m.fields})
	}
	if p.Positionals[0] == "settings" {
		if err = pinSettingsVersion(ctx, client, project, m.fields); err != nil {
			return fail(runtime.Stderr, err)
		}
	}
	client.idempotencyKey = p.Flags["idempotency-key"]
	var value any
	if err = client.request(ctx, m.method, m.path, m.fields, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	if m.cloneSource != "" {
		return writeWorkflow(runtime, p, map[string]any{"created": value, "sourceId": m.cloneSource, "configurationCopied": false, "copiedFields": []string{"description"}})
	}
	return writeWorkflow(runtime, p, value)
}

func selectedMetadata(source map[string]any, keys ...string) map[string]any {
	metadata := map[string]any{}
	for _, key := range keys {
		if value, exists := source[key]; exists {
			metadata[key] = value
		}
	}
	return metadata
}

func maskedRuntimeAssets(assets map[string]any) map[string]any {
	masked := map[string]any{}
	for _, kind := range []string{"envVars", "files"} {
		var rows []any
		for _, row := range anyRows(assets[kind]) {
			source, ok := row.(map[string]any)
			if !ok {
				continue
			}
			metadata := selectedMetadata(source, "key", "path", "isSecret", "hasValue", "createdAt", "updatedAt")
			metadata["value"] = "REDACTED"
			rows = append(rows, metadata)
		}
		masked[kind] = rows
	}
	return masked
}

func safeAgentDefaults(defaults map[string]any) map[string]any {
	filtered := map[string]any{}
	for agent, raw := range defaults {
		if config, ok := raw.(map[string]any); ok {
			filtered[agent] = selectedMetadata(config, "model", "permissionMode")
		}
	}
	return filtered
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
	safe := selectedMetadata(value, "id", "name", "description", "repository", "defaultBranch", "status", "summary", "defaultAgentProfileId")
	safe["runtimeValues"] = "redacted"
	var assets map[string]any
	if client.request(ctx, http.MethodGet, projectAPIPath(project, "runtime-config"), nil, &assets) != nil {
		safe["runtimeConfig"] = map[string]any{"available": false}
	} else {
		safe["runtimeConfig"] = maskedRuntimeAssets(assets)
	}
	safe["resolutionOrder"] = []string{"explicit task", "skill/profile", "project agent defaults", "user agent settings", "platform defaults"}
	if defaults, ok := value["agentDefaults"].(map[string]any); ok {
		safe["agentDefaults"] = safeAgentDefaults(defaults)
	}
	return writeWorkflow(runtime, p, safe)
}

func anyRows(v any) []any { rows, _ := v.([]any); return rows }

func boundedPromptForRuntime(runtime Runtime, reader io.Reader) (string, error) {
	limit, err := workflowByteLimit(runtime, "SAM_CLI_MAX_PROMPT_BYTES", 16000)
	if err != nil {
		return "", err
	}
	if limit > 16000 {
		return "", fmt.Errorf("SAM_CLI_MAX_PROMPT_BYTES cannot exceed API contract maximum 16000")
	}
	bytes, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return "", fmt.Errorf("prompt input could not be read")
	}
	if int64(len(bytes)) > limit {
		return "", fmt.Errorf("prompt input exceeds configured byte limit")
	}
	return string(bytes), nil
}
