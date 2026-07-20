package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
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
	case "projects":
		return runListProjects(ctx, runtime, parsed)
	case "project":
		return runProjectCommand(ctx, runtime, parsed, args)
	case "status":
		return runStatus(ctx, runtime, parsed)
	case "chat":
		return runChatCommand(ctx, runtime, parsed, args)
	case "ideas":
		return runIdeas(ctx, runtime, parsed)
	case "library":
		return runLibrary(ctx, runtime, parsed)
	case "context":
		return runContext(ctx, runtime, parsed)
	case "notifications":
		return runNotifications(ctx, runtime, parsed)
	case "triggers":
		return runTriggers(ctx, runtime, parsed)
	case "profiles":
		return runProfiles(ctx, runtime, parsed)
	case "activity":
		return runActivity(ctx, runtime, parsed)
	case "nodes":
		return runNodes(ctx, runtime, parsed)
	case "workspace":
		return runWorkspace(ctx, runtime, parsed, args)
	// Legacy commands (hidden from help, still functional)
	case "task":
		return runTask(ctx, runtime, parsed, args)
	case "tasks":
		return runTasks(ctx, runtime, parsed, args)
	case "runner":
		return runRunner(ctx, runtime, parsed, args)
	case "harness":
		return fail(runtime.Stderr, plannedCommand("sam harness"))
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown command: %s\nRun `sam --help` for usage", namespace))
	}
}

func runAuth(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("auth requires an action"))
	}
	switch args[0] {
	case "login":
		return runAuthLogin(ctx, runtime, parsed)
	case "status":
		return runAuthStatus(ctx, runtime, parsed)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown auth action: %s", args[0]))
	}
}

func runAuthLogin(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	apiURL := resolveLoginAPIURL(runtime, parsed)
	token := flagValue(parsed.Flags, "token")
	if token != "" {
		return runTokenLogin(ctx, runtime, parsed, apiURL, token)
	}

	cookie, err := readSessionCookie(runtime, parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if cookie != "" {
		return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), cookie, AuthUser{})
	}

	return runDeviceFlow(ctx, runtime, parsed, apiURL)
}

const defaultAPIURL = "https://api.simple-agent-manager.org"

func resolveLoginAPIURL(runtime Runtime, parsed parsedArgs) string {
	if apiURL := flagValue(parsed.Flags, "api-url"); apiURL != "" {
		return apiURL
	}
	config, err := LoadConfig(runtime.Env)
	if err == nil && config != nil {
		return config.APIURL
	}
	if envURL := strings.TrimSpace(runtime.Env.Getenv("SAM_API_URL")); envURL != "" {
		return envURL
	}
	return defaultAPIURL
}

func runTokenLogin(ctx context.Context, runtime Runtime, parsed parsedArgs, apiURL string, token string) int {
	response, err := ExchangeAPIToken(ctx, runtime.HTTPClient, apiURL, token)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), response.SessionCookie, response.User)
}

func runDeviceFlow(ctx context.Context, runtime Runtime, parsed parsedArgs, apiURL string) int {
	code, err := CreateDeviceCode(ctx, runtime.HTTPClient, apiURL)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if code.Interval <= 0 {
		code.Interval = 5
	}
	if code.ExpiresIn <= 0 {
		code.ExpiresIn = 900
	}

	fmt.Fprintf(runtime.Stdout, "Open this URL to authorize SAM CLI:\n%s\n\nUser code: %s\n", code.VerificationURIComplete, code.UserCode)
	tryOpenBrowser(ctx, runtime, code.VerificationURIComplete)

	response, err := pollDeviceToken(ctx, runtime, apiURL, code)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	fmt.Fprintln(runtime.Stdout)
	return saveAuthConfig(runtime, parsed, normalizeAPIURL(apiURL), response.SessionCookie, response.User)
}

func pollDeviceToken(ctx context.Context, runtime Runtime, apiURL string, code DeviceCodeResponse) (TokenLoginResponse, error) {
	deadline := time.Now().Add(time.Duration(code.ExpiresIn) * time.Second)
	interval := time.Duration(code.Interval) * time.Second
	for {
		response, err := ExchangeDeviceCode(ctx, runtime.HTTPClient, apiURL, code.DeviceCode)
		if err == nil {
			return response, nil
		}
		var apiErr APIError
		if !errors.As(err, &apiErr) {
			return TokenLoginResponse{}, err
		}
		switch {
		case apiErr.Status == http.StatusPreconditionRequired || apiErr.Code == "authorization_pending":
			fmt.Fprint(runtime.Stdout, ".")
		case apiErr.Status == http.StatusTooManyRequests || apiErr.Code == "slow_down":
			interval += 5 * time.Second
			fmt.Fprint(runtime.Stdout, ".")
		case apiErr.Status == http.StatusGone || apiErr.Code == "expired_token":
			return TokenLoginResponse{}, errors.New("code expired. Run `sam auth login` again")
		default:
			return TokenLoginResponse{}, err
		}
		if time.Now().Add(interval).After(deadline) {
			return TokenLoginResponse{}, errors.New("code expired. Run `sam auth login` again")
		}
		if err := sleepContext(ctx, interval); err != nil {
			return TokenLoginResponse{}, err
		}
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func tryOpenBrowser(ctx context.Context, runtime Runtime, url string) {
	commands := browserCommands(runtime.Runner.GOOS(), url)
	for _, command := range commands {
		if _, err := runtime.Runner.LookPath(command.name); err != nil {
			continue
		}
		_, _ = runtime.Runner.Command(ctx, command.name, command.args...)
		return
	}
}

type browserCommand struct {
	name string
	args []string
}

func browserCommands(goos string, target string) []browserCommand {
	switch goos {
	case "darwin":
		return []browserCommand{{name: "open", args: []string{target}}}
	case "windows":
		return []browserCommand{{name: "rundll32", args: []string{"url.dll,FileProtocolHandler", target}}}
	default:
		return []browserCommand{{name: "xdg-open", args: []string{target}}}
	}
}

func saveAuthConfig(runtime Runtime, parsed parsedArgs, apiURL string, sessionCookie string, user AuthUser) int {
	config := CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: sessionCookie}
	paths, err := SaveConfig(runtime.Env, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	text := "Authenticated"
	if user.Email != "" || user.Name != "" {
		text = "Authenticated as " + formatAuthUser(user)
	}
	text += fmt.Sprintf("\nSaved SAM CLI auth config to %s", paths.ConfigFile)
	value := map[string]any{
		"authenticated": true,
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
		"user":          user,
	}
	return writeOrFail(runtime, parsed.Globals.JSON, text, value)
}

func formatAuthUser(user AuthUser) string {
	if user.Name != "" && user.Email != "" {
		return fmt.Sprintf("%s <%s>", user.Name, user.Email)
	}
	if user.Email != "" {
		return user.Email
	}
	if user.Name != "" {
		return user.Name
	}
	return "user"
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

func runAuthStatus(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
	config, source, err := resolveAuthenticatedConfig(ctx, runtime)
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
		"source: " + source,
		"configFile: " + paths.ConfigFile,
	}, "\n")
	value := map[string]any{
		"authenticated": true,
		"apiUrl":        config.APIURL,
		"configFile":    paths.ConfigFile,
		"sessionCookie": redactSecret(config.SessionCookie),
		"source":        source,
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
	client, err := authenticatedClient(ctx, runtime)
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

func runProjectCommand(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return runProjectDetail(ctx, runtime, parsed)
	}
	switch args[0] {
	case "use":
		return runProjectUse(ctx, runtime, parsed, args[1:])
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown project action: %s", args[0]))
	}
}

func runChatCommand(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return runChatList(ctx, runtime, parsed)
	}
	switch args[0] {
	case "new":
		return runChatNew(ctx, runtime, parsed, args[1:])
	default:
		// Treat the first arg as a session ID for chat view
		return runChatView(ctx, runtime, parsed, args[0])
	}
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
	client, err := authenticatedClient(ctx, runtime)
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

func authenticatedClient(ctx context.Context, runtime Runtime) (APIClient, error) {
	config, _, err := resolveAuthenticatedConfig(ctx, runtime)
	if err != nil {
		return APIClient{}, err
	}
	if config == nil {
		return APIClient{}, errors.New("not authenticated. Run `sam auth login` first")
	}
	return NewAPIClient(*config, runtime.HTTPClient), nil
}

func resolveAuthenticatedConfig(ctx context.Context, runtime Runtime) (*CLIConfig, string, error) {
	config, err := LoadConfig(runtime.Env)
	if err != nil {
		return nil, "", err
	}
	if config != nil {
		return config, "config-or-session-env", nil
	}
	token := strings.TrimSpace(runtime.Env.Getenv("SAM_API_TOKEN"))
	if token == "" {
		return nil, "", nil
	}
	apiURL := strings.TrimSpace(runtime.Env.Getenv("SAM_API_URL"))
	if apiURL == "" {
		apiURL = defaultAPIURL
	}
	maxAPIResponseBytes, err := loadMaxAPIResponseBytes(runtime.Env)
	if err != nil {
		return nil, "", err
	}
	response, err := ExchangeAPIToken(ctx, runtime.HTTPClient, apiURL, token)
	if err != nil {
		return nil, "", err
	}
	return &CLIConfig{APIURL: normalizeAPIURL(apiURL), SessionCookie: response.SessionCookie, MaxAPIResponseBytes: maxAPIResponseBytes}, "env-token", nil
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
  sam auth login [--api-url <url>]              Log in to SAM
  sam auth status                               Show auth status

  sam projects                                  List all projects
  sam project use [<name-or-id>]                Set the active project
  sam project                                   Show active project details
  sam status                                    Project dashboard (detail + recent chats)

  sam chat                                      List chats
  sam chat new <message>                        Start a new chat
  sam chat <sessionId>                          View chat messages

  sam ideas                                     List ideas (draft tasks)
  sam library [--recursive|--all]               List library files
  sam context                                   List knowledge entities
  sam notifications                             List notifications
  sam triggers                                  List triggers
  sam profiles                                  List agent profiles
  sam activity                                  List recent activity
  sam nodes                                     List infrastructure nodes

  sam workspace <id> forward [--port <port>] [--local-port <port>] [--local-host localhost|127.0.0.1]
                                                Forward workspace ports
  sam workspace <id> ports                      List workspace ports

Global flags:
  --project <name-or-id>  Override active project (accepts name, prefix, or full ID)
  --json                  Print machine-readable JSON output
`
}
