package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
)

func Run(ctx context.Context, runtime Runtime) int {
	parsed, err := parseArgs(runtime.Args)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(parsed.Positionals) == 0 || parsed.Bools["help"] || parsed.Bools["h"] {
		fmt.Fprintln(runtime.Stdout, helpText())
		return 0
	}

	namespace := parsed.Positionals[0]
	args := parsed.Positionals[1:]
	switch namespace {
	case "auth":
		return runAuth(ctx, runtime, parsed, args)
	case "task":
		return runTask(ctx, runtime, parsed, args)
	case "tasks":
		return runTasks(ctx, runtime, parsed, args)
	case "chat":
		return runChat(ctx, runtime, parsed, args)
	case "runner":
		return runRunner(ctx, runtime, parsed, args)
	case "harness":
		return fail(runtime.Stderr, plannedCommand("sam harness"))
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown command: %s", strings.Join(parsed.Positionals, " ")))
	}
}

func runAuth(_ context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("auth requires an action"))
	}
	switch args[0] {
	case "login":
		return runAuthLogin(runtime, parsed)
	case "status":
		return runAuthStatus(runtime, parsed)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown auth action: %s", args[0]))
	}
}

func runAuthLogin(runtime Runtime, parsed parsedArgs) int {
	apiURL := flagValue(parsed.Flags, "api-url")
	cookie, err := readSessionCookie(runtime, parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if apiURL == "" || cookie == "" {
		return fail(runtime.Stderr, errors.New("auth login requires --api-url and a session cookie"))
	}

	config := CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: cookie}
	paths, err := SaveConfig(runtime.Env, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	text := fmt.Sprintf("Saved SAM CLI auth config to %s", paths.ConfigFile)
	value := map[string]string{
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
	}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func readSessionCookie(runtime Runtime, parsed parsedArgs) (string, error) {
	cookie := flagValue(parsed.Flags, "session-cookie")
	if !parsed.Bools["session-cookie-stdin"] {
		return cookie, nil
	}
	if cookie != "" {
		return "", errors.New("use either --session-cookie or --session-cookie-stdin, not both")
	}
	read, err := io.ReadAll(bufio.NewReader(runtime.Stdin))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(read)), nil
}

func runAuthStatus(runtime Runtime, parsed parsedArgs) int {
	config, err := LoadConfig(runtime.Env)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	paths, err := ResolveConfigPaths(runtime.Env)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if config == nil {
		text := fmt.Sprintf("Not authenticated. Expected config at %s", paths.ConfigFile)
		if err := writeOutput(runtime.Stdout, parsed.Globals.JSON, text, map[string]any{"authenticated": false, "configFile": paths.ConfigFile}); err != nil {
			return fail(runtime.Stderr, err)
		}
		return 1
	}
	text := strings.Join([]string{
		"Authenticated",
		"apiUrl: " + config.APIURL,
		"sessionCookie: " + redactSecret(config.SessionCookie),
		"configFile: " + paths.ConfigFile,
	}, "\n")
	value := map[string]any{
		"authenticated": true,
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
	}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func runTask(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("task requires an action"))
	}
	action := args[0]
	projectID, rest, err := projectFromArgs(parsed.Globals, args[1:], "task "+action)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	switch action {
	case "submit":
		return runTaskSubmit(ctx, runtime, parsed, projectID, rest)
	case "status":
		return runTaskStatus(ctx, runtime, parsed, projectID, rest)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown task action: %s", action))
	}
}

func runTaskSubmit(ctx context.Context, runtime Runtime, parsed parsedArgs, projectID string, args []string) int {
	message := commandMessage(parsed, args)
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("task submit requires <message> or --prompt"))
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return submitTask(ctx, runtime, parsed, projectID, message, options)
}

func runTaskStatus(ctx context.Context, runtime Runtime, parsed parsedArgs, projectID string, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, errors.New("task status requires <taskId>"))
	}
	client, err := authenticatedClient(runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	response, err := client.GetTaskStatus(ctx, projectID, args[0])
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, formatTaskStatus(response), response)
}

func runTasks(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("tasks requires an action"))
	}
	if args[0] != "dispatch" {
		return fail(runtime.Stderr, fmt.Errorf("unknown tasks action: %s", args[0]))
	}
	projectID, rest, err := projectFromArgs(parsed.Globals, args[1:], "tasks dispatch")
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	message := commandMessage(parsed, rest)
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("tasks dispatch requires --prompt or <prompt>"))
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return submitTask(ctx, runtime, parsed, projectID, message, options)
}

func runChat(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	projectID, rest, err := projectFromArgs(parsed.Globals, args, "chat")
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	message := commandMessage(parsed, rest)
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("chat requires <message> or --prompt"))
	}
	client, err := authenticatedClient(runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if sessionID := flagValue(parsed.Flags, "session"); sessionID != "" {
		response, err := client.SendPrompt(ctx, projectID, sessionID, message)
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		return writeOrFail(runtime, parsed.Globals.JSON, "Prompt sent to session "+sessionID, response)
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	options.Mode = "conversation"
	return submitTask(ctx, runtime, parsed, projectID, message, options)
}

func commandMessage(parsed parsedArgs, args []string) string {
	message := flagValue(parsed.Flags, "prompt")
	if message != "" || len(args) == 0 {
		return message
	}
	return strings.Join(args, " ")
}

func runRunner(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("runner requires an action"))
	}
	switch args[0] {
	case "doctor":
		report := RunRunnerDoctor(ctx, runtime.Runner)
		return writeOrFail(runtime, parsed.Globals.JSON, FormatRunnerDoctor(report), report)
	case "install":
		return fail(runtime.Stderr, plannedCommand("sam runner install"))
	case "register":
		return fail(runtime.Stderr, plannedCommand("sam runner register"))
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown runner action: %s", args[0]))
	}
}

func submitTask(ctx context.Context, runtime Runtime, parsed parsedArgs, projectID string, message string, options TaskSubmitOptions) int {
	client, err := authenticatedClient(runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	response, err := client.SubmitTask(ctx, projectID, message, options)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, formatSubmitResponse(response), response)
}

func parseSubmitOptions(parsed parsedArgs) (TaskSubmitOptions, error) {
	if flagValue(parsed.Flags, "model") != "" {
		return TaskSubmitOptions{}, errors.New("--model is reserved, but the current task submit API does not accept a per-dispatch model yet; use --agent-profile for configured model selection")
	}
	return TaskSubmitOptions{
		Agent:          flagValue(parsed.Flags, "agent"),
		AgentProfile:   flagValue(parsed.Flags, "agent-profile", "agent-profile-id"),
		ContextSummary: flagValue(parsed.Flags, "context-summary"),
		Devcontainer:   flagValue(parsed.Flags, "devcontainer-config", "devcontainer-config-name"),
		Mode:           flagValue(parsed.Flags, "mode"),
		Node:           flagValue(parsed.Flags, "node", "node-id"),
		ParentTask:     flagValue(parsed.Flags, "parent-task", "parent-task-id"),
		Provider:       flagValue(parsed.Flags, "provider"),
		VMLocation:     flagValue(parsed.Flags, "vm-location"),
		VMSize:         flagValue(parsed.Flags, "vm-size"),
		Workspace:      flagValue(parsed.Flags, "workspace", "workspace-profile"),
	}, nil
}

func authenticatedClient(runtime Runtime) (APIClient, error) {
	config, err := LoadConfig(runtime.Env)
	if err != nil {
		return APIClient{}, err
	}
	if config == nil {
		return APIClient{}, errors.New("not authenticated. Run `sam auth login` first")
	}
	return NewAPIClient(*config, runtime.HTTPClient), nil
}

func writeOrFail(runtime Runtime, jsonMode bool, text string, value any) int {
	if err := writeOutput(runtime.Stdout, jsonMode, text, value); err != nil {
		return fail(runtime.Stderr, err)
	}
	return 0
}

func fail(stderr io.Writer, err error) int {
	fmt.Fprintln(stderr, err.Error())
	return 1
}

func plannedCommand(command string) error {
	return fmt.Errorf("%s is planned but not implemented yet. The CLI now reserves this command, but the runner registration or local harness API contract is not safe to fake", command)
}

func helpText() string {
	return `SAM CLI

Usage:
  sam auth login --api-url <url> --session-cookie-stdin
  sam auth status
  sam --project <projectId> tasks dispatch --prompt <prompt>
  sam --project <projectId> task submit <prompt>
  sam --project <projectId> task status <taskId>
  sam --project <projectId> chat [--session <sessionId>] <prompt>
  sam runner doctor

Global flags:
  --project <projectId>  Project scope for project commands
  --json                 Print machine-readable JSON output
`
}
