package cli

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// resolveProjectRef resolves a --project flag or config default to a project ID and name.
func resolveProjectRef(ctx context.Context, client APIClient, parsed parsedArgs, config *CLIConfig) (string, string, error) {
	return ResolveProject(ctx, client, parsed.Globals.Project, config)
}

func runListProjects(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	response, err := client.ListProjects(ctx)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Projects) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No projects found", response)
	}
	headers := []string{"ID", "NAME", "REPO", "CHATS", "ACTIVITY"}
	var rows [][]string
	for _, p := range response.Projects {
		activity := ""
		activity = FormatAnyTimestamp(p.LastActivityAt)
		rows = append(rows, []string{
			TruncateID(p.ID),
			p.Name,
			or(p.Repository, "—"),
			fmt.Sprintf("%d", p.ActiveSessionCount),
			or(activity, "—"),
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runProjectUse(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var selected Project
	if len(args) > 0 {
		ref := strings.Join(args, " ")
		id, name, resolveErr := ResolveProject(ctx, client, ref, nil)
		if resolveErr != nil {
			return fail(runtime.Stderr, resolveErr)
		}
		selected = Project{ID: id, Name: name}
	} else {
		picked, pickErr := PickProject(ctx, client, runtime.Stdin, runtime.Stdout)
		if pickErr != nil {
			return fail(runtime.Stderr, pickErr)
		}
		selected = picked
	}
	if err := SetActiveProject(runtime.Env, selected.ID, selected.Name); err != nil {
		return fail(runtime.Stderr, err)
	}
	text := fmt.Sprintf("Active project set to %s (%s)", selected.Name, TruncateID(selected.ID))
	value := map[string]any{"projectId": selected.ID, "projectName": selected.Name}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func runProjectDetail(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	detail, err := client.GetProjectDetail(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Project: %s\n", detail.Name)
	fmt.Fprintf(&sb, "ID: %s\n", detail.ID)
	fmt.Fprintf(&sb, "Repo: %s\n", or(detail.Repository, "—"))
	fmt.Fprintf(&sb, "Branch: %s\n", or(detail.DefaultBranch, "—"))
	fmt.Fprintf(&sb, "Status: %s\n", or(detail.Status, "—"))
	fmt.Fprintf(&sb, "Active chats: %d\n", detail.ActiveSessionCount)
	fmt.Fprintf(&sb, "Active workspaces: %d", detail.ActiveWorkspaceCount)
	return writeOrFail(runtime, parsed.Globals.JSON, sb.String(), detail)
}

func runStatus(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, projectName, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		// No project configured — fall back to listing all projects
		return runListProjects(ctx, runtime, parsed)
	}
	detail, err := client.GetProjectDetail(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	sessions, err := client.ListSessions(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	displayName := projectName
	if displayName == "" {
		displayName = detail.Name
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Project: %s (%s)\n", displayName, TruncateID(projectID))
	fmt.Fprintf(&sb, "Repo: %s\n", or(detail.Repository, "—"))
	fmt.Fprintf(&sb, "Active chats: %d  Active workspaces: %d\n", detail.ActiveSessionCount, detail.ActiveWorkspaceCount)
	active := 0
	for _, s := range sessions.Sessions {
		if s.Status == "active" || s.Status == "running" {
			active++
		}
	}
	if active > 0 {
		fmt.Fprintf(&sb, "\nRecent active chats:\n")
		count := 0
		for _, s := range sessions.Sessions {
			if count >= 5 {
				break
			}
			if s.Status != "active" && s.Status != "running" {
				continue
			}
			topic := SanitizeTableCell(or(s.Topic, "(no topic)"))
			lastMsg := "—"
			if formatted := FormatAnyTimestamp(s.LastMessageAt); formatted != "" {
				lastMsg = formatted
			}
			fmt.Fprintf(&sb, "  %s  %s  %s\n", TruncateID(s.ID), topic, lastMsg)
			count++
		}
	}
	value := map[string]any{"project": detail, "sessions": sessions}
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), value)
}

func runChatList(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListSessions(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Sessions) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No chats found", response)
	}
	headers := []string{"ID", "TOPIC", "STATUS", "MSGS", "LAST MESSAGE"}
	var rows [][]string
	for _, s := range response.Sessions {
		lastMsg := "—"
		if formatted := FormatAnyTimestamp(s.LastMessageAt); formatted != "" {
			lastMsg = formatted
		}
		rows = append(rows, []string{
			TruncateID(s.ID),
			or(s.Topic, "—"),
			or(s.Status, "—"),
			fmt.Sprintf("%d", s.MessageCount),
			lastMsg,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runChatNew(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	message := commandMessage(parsed, args)
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, fmt.Errorf("chat new requires a message. Usage: sam chat new <message>"))
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	options.Mode = "conversation"
	response, err := client.SubmitTask(ctx, projectID, message, options)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, formatSubmitResponse(response), response)
}

func runChatView(ctx context.Context, runtime Runtime, parsed parsedArgs, sessionID string) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.GetSessionDetail(ctx, projectID, sessionID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Messages) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No messages in this chat", response)
	}
	var sb strings.Builder
	for i, m := range response.Messages {
		if i > 0 {
			sb.WriteString("\n")
		}
		role := m.Role
		if role == "" {
			role = "unknown"
		}
		ts := ""
		if formatted := FormatAnyTimestamp(m.CreatedAt); formatted != "" {
			ts = " (" + formatted + ")"
		}
		fmt.Fprintf(&sb, "[%s]%s\n%s", role, ts, m.Content)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, sb.String(), response)
}

func runIdeas(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListIdeas(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Tasks) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No ideas found", response)
	}
	headers := []string{"ID", "TITLE", "PRIORITY", "CREATED"}
	var rows [][]string
	for _, idea := range response.Tasks {
		created := "—"
		if formatted := FormatAnyTimestamp(idea.CreatedAt); formatted != "" {
			created = formatted
		}
		rows = append(rows, []string{
			TruncateID(idea.ID),
			or(idea.Title, "—"),
			fmt.Sprintf("%d", idea.Priority),
			created,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runLibrary(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	recursive := parsed.Bools["recursive"] || parsed.Bools["all"]
	response, err := client.ListLibraryFiles(ctx, projectID, recursive)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Files) == 0 {
		message := "No library files found"
		if !recursive {
			message = "No library files found in / (use --recursive or --all to include subdirectories)"
		}
		return writeOrFail(runtime, parsed.Globals.JSON, message, response)
	}
	headers := []string{"ID", "PATH", "SIZE", "SOURCE", "UPLOADED"}
	var rows [][]string
	for _, f := range response.Files {
		uploaded := "—"
		if formatted := FormatAnyTimestamp(f.CreatedAt); formatted != "" {
			uploaded = formatted
		}
		rows = append(rows, []string{
			TruncateID(f.ID),
			libraryPath(f),
			FormatSize(f.SizeBytes),
			or(f.UploadSource, "—"),
			uploaded,
		})
	}
	var sb strings.Builder
	if !recursive {
		sb.WriteString("Library files in / (use --recursive or --all to include subdirectories)\n")
	}
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runContext(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListKnowledge(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Entities) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No knowledge entities found", response)
	}
	headers := []string{"ENTITY", "TYPE", "OBSERVATIONS", "UPDATED"}
	var rows [][]string
	for _, e := range response.Entities {
		updated := "—"
		if formatted := FormatAnyTimestamp(e.UpdatedAt); formatted != "" {
			updated = formatted
		}
		rows = append(rows, []string{
			e.Name,
			or(e.EntityType, "—"),
			fmt.Sprintf("%d", e.ObservationCount),
			updated,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runNotifications(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	response, err := client.ListNotifications(ctx)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Notifications) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No notifications", response)
	}
	headers := []string{"ID", "TYPE", "TITLE", "READ", "CREATED"}
	var rows [][]string
	for _, n := range response.Notifications {
		read := "no"
		if n.Read || n.ReadAt != nil {
			read = "yes"
		}
		created := "—"
		if formatted := FormatAnyTimestamp(n.CreatedAt); formatted != "" {
			created = formatted
		}
		rows = append(rows, []string{
			TruncateID(n.ID),
			or(n.Type, "—"),
			or(n.Title, "—"),
			read,
			created,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runTriggers(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListTriggers(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Triggers) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No triggers found", response)
	}
	headers := []string{"ID", "NAME", "SCHEDULE", "STATUS", "NEXT RUN"}
	var rows [][]string
	for _, t := range response.Triggers {
		nextRun := "—"
		if formatted := FormatAnyTimestamp(t.NextFireAt); formatted != "" {
			nextRun = formatted
		}
		schedule := t.CronHumanReadable
		if schedule == "" && t.CronExpression != nil {
			schedule = *t.CronExpression
		}
		if schedule == "" {
			schedule = t.SourceType
		}
		rows = append(rows, []string{
			TruncateID(t.ID),
			or(t.Name, "—"),
			or(schedule, "—"),
			or(t.Status, "—"),
			nextRun,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runProfiles(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListProfiles(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Items) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No agent profiles found", response)
	}
	headers := []string{"ID", "NAME", "AGENT", "VM SIZE", "MODE"}
	var rows [][]string
	for _, p := range response.Items {
		rows = append(rows, []string{
			TruncateID(p.ID),
			or(p.Name, "—"),
			or(p.AgentType, "—"),
			or(or(p.VMSizeOverride, p.VMSize), "—"),
			or(p.TaskMode, "—"),
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runActivity(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	projectID, _, resolveErr := resolveProjectRef(ctx, client, parsed, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	response, err := client.ListActivity(ctx, projectID)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Events) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No activity found", response)
	}
	headers := []string{"ID", "TYPE", "SUMMARY", "WHEN"}
	var rows [][]string
	for _, e := range response.Events {
		when := "—"
		if formatted := FormatAnyTimestamp(e.CreatedAt); formatted != "" {
			when = formatted
		}
		rows = append(rows, []string{
			TruncateID(e.ID),
			or(e.EventType, "—"),
			or(activitySummary(e.Payload), "—"),
			when,
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func runNodes(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	client, err := authenticatedClient(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	response, err := client.ListNodes(ctx)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(response.Nodes) == 0 {
		return writeOrFail(runtime, parsed.Globals.JSON, "No nodes found", response)
	}
	headers := []string{"ID", "PROVIDER", "SIZE", "LOCATION", "STATUS", "IP"}
	var rows [][]string
	for _, n := range response.Nodes {
		rows = append(rows, []string{
			TruncateID(n.ID),
			or(n.CloudProvider, "—"),
			or(n.VMSize, "—"),
			or(n.VMLocation, "—"),
			or(n.Status, "—"),
			or(n.IPAddress, "—"),
		})
	}
	var sb strings.Builder
	PrintTable(&sb, headers, rows)
	return writeOrFail(runtime, parsed.Globals.JSON, strings.TrimRight(sb.String(), "\n"), response)
}

func libraryPath(file LibraryFile) string {
	directory := file.Directory
	if directory == "" || directory == "/" {
		return or(file.Filename, "—")
	}
	return strings.TrimRight(directory, "/") + "/" + or(file.Filename, "—")
}

func activitySummary(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	for _, key := range []string{"summary", "title", "message", "workspaceName", "taskTitle", "sessionTopic"} {
		if value := stringFromAny(payload[key]); value != "" {
			return value
		}
	}
	parts := make([]string, 0, len(payload))
	for key, value := range payload {
		if rendered := stringFromAny(value); rendered != "" {
			parts = append(parts, fmt.Sprintf("%s=%s", key, rendered))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

// authenticatedClientWithConfig returns both the API client and the raw config
// so callers can use the config for project resolution.
func authenticatedClientWithConfig(ctx context.Context, runtime Runtime) (APIClient, *CLIConfig, error) {
	config, _, err := resolveAuthenticatedConfig(ctx, runtime)
	if err != nil {
		return APIClient{}, nil, err
	}
	if config == nil {
		return APIClient{}, nil, fmt.Errorf("not authenticated. Run `sam auth login` first")
	}
	return NewAPIClient(*config, runtime.HTTPClient), config, nil
}
