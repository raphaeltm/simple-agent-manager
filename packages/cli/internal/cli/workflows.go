package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// A command contract enumerates its API boundary. It never accepts arbitrary
// paths, methods or patch bodies from an assistant.
type workflowContract struct {
	command string
	method  string
	path    []string
	args    int
	query   []string
	fields  map[string]string
	effect  string
}

func readContract(command string, path []string, args int, query string) workflowContract {
	return workflowContract{command: command, method: http.MethodGet, path: path, args: args, query: strings.Fields(query), effect: "read-only"}
}

func workflowContracts() []workflowContract {
	return []workflowContract{
		readContract("project get", nil, 0, ""),
		readContract("notifications list", nil, 0, "limit cursor filter type sessionId"),
		readContract("tasks receipt", []string{"operation-receipts"}, 0, "key operation sessionId"),
		readContract("tasks list", []string{"tasks"}, 0, "status minPriority sort limit cursor"),
		readContract("tasks get", []string{"tasks", "$0"}, 1, ""),
		readContract("tasks events", []string{"tasks", "$0", "events"}, 1, ""),
		readContract("tasks sessions", []string{"tasks", "$0", "sessions"}, 1, ""),
		readContract("ideas list", []string{"tasks"}, 0, cursorQueryFields),
		readContract("ideas get", []string{"tasks", "$0"}, 1, ""),
		workflowContract{command: "profiles resolve", method: http.MethodPost, path: []string{agentProfilesAPI, "resolve"}, args: 1, effect: "read-only"},
		readContract("skills resolve", []string{"skills", "$0", "resolve"}, 1, "profileId"),
		readContract("profiles list", []string{agentProfilesAPI}, 0, ""),
		readContract("profiles get", []string{agentProfilesAPI, "$0"}, 1, ""),
		readContract("skills list", []string{"skills"}, 0, ""),
		readContract("skills get", []string{"skills", "$0"}, 1, ""),
		readContract("chat list", []string{"sessions"}, 0, "limit offset scope status"),
		readContract("chat get", []string{"sessions", "$0"}, 1, "limit before after compact"),
		readContract("chat messages", []string{"sessions", "$0", "messages"}, 1, "limit before after compact order roles"),
		readContract("chat tool-content", []string{"sessions", "$0", "messages", "$1", "tool-content"}, 2, ""),
		readContract("chat state", []string{"sessions", "$0", "state"}, 1, ""),
		readContract("chat interactions", []string{"sessions", "$0", "interactions"}, 1, ""),
		readContract("chat interaction", []string{"sessions", "$0", "interactions", "$1"}, 2, ""),
		readContract("comments list", []string{"comments"}, 0, "limit status"),
		readContract("comments session", []string{"sessions", "$0", "comments"}, 1, "limit afterSequence messageId status"),
		readContract("files branches", []string{"repo", "branches"}, 0, ""),
		readContract("files tree", []string{"repo", "tree"}, 0, "ref"),
		readContract("files get", []string{"repo", "file"}, 0, "ref path"),
		readContract("files compare", []string{"repo", "compare"}, 0, "base head"),
		readContract("library list", []string{"library"}, 0, "limit cursor directory recursive search tags mimeType status uploadSource sortBy sortOrder"),
		readContract("library get", []string{"library", "$0"}, 1, ""),
		readContract("library directories", []string{"library", "directories"}, 0, "parentDirectory search"),
		readContract("context list", []string{"knowledge"}, 0, "limit offset entityType"),
		readContract("context get", []string{"knowledge", "$0"}, 1, "includeInactive"),
		readContract("context search", []string{"knowledge", "search"}, 0, "q entityType minConfidence limit"),
		readContract("policies list", []string{"policies"}, 0, ""),
		readContract("policies get", []string{"policies", "$0"}, 1, ""),
		readContract("activity list", []string{"activity"}, 0, "limit before eventType sessionId"),
		readContract("triggers list", []string{"triggers"}, 0, ""),
		readContract("triggers get", []string{"triggers", "$0"}, 1, ""),
		readContract("triggers executions", []string{"triggers", "$0", "executions"}, 1, "limit offset status"),
		readContract("events subscriptions", []string{eventSubscriptionsAPI}, 0, "limit state sessionId"),
		readContract("events subscription", []string{eventSubscriptionsAPI, "$0"}, 1, ""),
		readContract("events deliveries", []string{eventSubscriptionsAPI, "$0", "deliveries"}, 1, "limit"),
		readContract("events channels", []string{"event-channels"}, 0, cursorQueryFields),
		readContract("events history", []string{"event-channels", "$0", "history"}, 1, cursorQueryFields),
		readContract("schedules list", []string{"schedules"}, 0, "limit cursor sessionId"),
		readContract("schedules get", []string{"schedules", "$0"}, 1, ""),
		readContract("watches list", []string{"standing-watches"}, 0, "limit cursor sessionId"),
		readContract("watches get", []string{"standing-watches", "$0"}, 1, ""),
		readContract("deployments releases", []string{"environments", "$0", "releases"}, 1, ""),
		readContract("deployments release", []string{"environments", "$0", "releases", "$1"}, 2, ""),
		readContract("deployments routes", []string{"environments", "$0", "public-routes"}, 1, ""),
		readContract("deployments containers", []string{"environments", "$0", "containers"}, 1, ""),
		readContract("deployments metrics", []string{"environments", "$0", "metrics"}, 1, ""),
		readContract("deployments list", []string{"environments"}, 0, ""),
		readContract("deployments get", []string{"environments", "$0"}, 1, ""),
	}
}

func findWorkflow(parsed parsedArgs) (workflowContract, []string, bool) {
	p := parsed.Positionals
	if len(p) == 0 {
		return workflowContract{}, nil, false
	}
	action := "list"
	if p[0] == "project" {
		action = "get"
	}
	start := 1
	if len(p) > 1 {
		action = p[1]
		start = 2
	}
	if p[0] == "chat" && len(p) > 1 && !knownChatAction(action) {
		action = "get"
		start = 1
	}
	for _, c := range workflowContracts() {
		if c.command == p[0]+" "+action {
			return c, p[start:], true
		}
	}
	return workflowContract{}, nil, false
}

func knownChatAction(action string) bool {
	for _, c := range workflowContracts() {
		if c.command == "chat "+action {
			return true
		}
	}
	return action == "new" || action == "send" || action == "cancel" || action == "sleep" || action == "export" || action == "fork" || action == "retry" || action == "answer"
}

func runWorkflow(ctx context.Context, runtime Runtime, parsed parsedArgs, c workflowContract, args []string) int {
	if len(args) != c.args {
		return fail(runtime.Stderr, fmt.Errorf("sam %s requires %d resource argument(s)", c.command, c.args))
	}
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	project, _, err := resolveProjectRef(ctx, client, parsed, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	path, query, err := workflowRequestPath(ctx, client, project, parsed, c, args)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	basePath := path
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	if parsed.Bools[allPagesFlag] {
		paging, ok := pagingFor(c.command)
		if !ok {
			return fail(runtime.Stderr, fmt.Errorf("--all-pages is unsupported for %s; use its explicit cursor controls", c.command))
		}
		value, err := drainPages(ctx, client, basePath, query, paging)
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		return writeWorkflow(runtime, parsed, value)
	}
	var body map[string]any
	if c.command == "profiles resolve" {
		id, e := resolveNamedResource(ctx, client, project, agentProfilesAPI, args[0])
		if e != nil {
			return fail(runtime.Stderr, e)
		}
		body = map[string]any{"profileNameOrId": id}
	}
	var value any
	if err := client.request(ctx, c.method, path, body, &value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeWorkflow(runtime, parsed, value)
}

func writeWorkflow(runtime Runtime, parsed parsedArgs, value any) int {
	// Full JSON is also the text fallback for richer resources; no fields are
	// silently discarded by a stale projection struct.
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, string(content), value)
}

func resolveNamedResource(ctx context.Context, client APIClient, project, family, ref string) (string, error) {
	var value map[string]any
	if err := client.request(ctx, http.MethodGet, projectAPIPath(project, family), nil, &value); err != nil {
		return "", err
	}
	key := "items"

	rows, _ := value[key].([]any)
	var matches []string
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		name, _ := m["name"].(string)
		if id == ref {
			return id, nil
		}
		if strings.EqualFold(name, ref) {
			matches = append(matches, id)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("ambiguous %s name %q; use a full ID", family, ref)
	}
	return "", fmt.Errorf("no accessible %s matches %q", family, ref)
}

func legacyTextInspection(p parsedArgs) bool {
	if p.Globals.JSON || len(p.Flags) > 0 || p.Bools[allPagesFlag] {
		return false
	}
	if len(p.Positionals) == 2 && p.Positionals[0] == "chat" && !knownChatAction(p.Positionals[1]) {
		return true
	}
	if len(p.Positionals) != 1 {
		return false
	}
	switch p.Positionals[0] {
	case "project", "chat", "ideas", "library", "context", "notifications", "triggers", "profiles", "activity":
		return true
	}
	return false
}

const agentProfilesAPI = "agent-profiles"
const cursorQueryFields = "limit cursor"
const eventSubscriptionsAPI = "event-subscriptions"

func workflowRequestPath(ctx context.Context, client APIClient, project string, parsed parsedArgs, c workflowContract, args []string) (string, url.Values, error) {
	segments := append([]string(nil), c.path...)
	for i, s := range segments {
		if strings.HasPrefix(s, "$") {
			segments[i] = args[int(s[1]-'0')]
		}
	}
	if err := resolveWorkflowResource(ctx, client, project, c, args, segments); err != nil {
		return "", nil, err
	}
	query := url.Values{}
	for _, key := range c.query {
		if v := parsed.Flags[key]; v != "" {
			query.Set(key, v)
		}
	}
	if c.command == "ideas list" {
		query.Set("status", "draft")
	}
	if parsed.Bools["recursive"] || parsed.Bools["all"] {
		query.Set("recursive", "true")
	}
	if err := validateWorkflowSort(c, parsed, query); err != nil {
		return "", nil, err
	}
	path := projectAPIPath(project, segments...)
	if c.command == "notifications list" {
		path = "/api/notifications"
		query.Set("projectId", project)
	}
	return path, query, nil
}

func resolveWorkflowResource(ctx context.Context, client APIClient, project string, c workflowContract, args, segments []string) error {
	if strings.HasPrefix(c.command, "profiles get") || strings.HasPrefix(c.command, "skills get") || c.command == "skills resolve" {
		id, e := resolveNamedResource(ctx, client, project, c.path[0], args[0])
		if e != nil {
			return e
		}
		segments[1] = id
	}
	return nil
}

func validateWorkflowSort(c workflowContract, parsed parsedArgs, query url.Values) error {
	if c.command == "tasks list" && (query.Get("cursor") != "" || parsed.Bools[allPagesFlag]) && query.Get("sort") != "" && query.Get("sort") != "createdAtDesc" {
		return fmt.Errorf("cursor paging with non-created sort is unsupported by the API")
	}
	return nil
}
