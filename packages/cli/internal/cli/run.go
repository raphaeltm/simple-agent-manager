package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func Run(ctx context.Context, runtime Runtime) int {
	if containsJSONFlag(runtime.Args) {
		runtime.Stderr = structuredErrorWriter{runtime.Stderr}
	}
	secured, secureErr := secureRuntime(runtime)
	if secureErr != nil {
		return fail(runtime.Stderr, secureErr)
	}
	runtime = secured
	parsed, err := parseArgs(runtime.Args)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	if len(parsed.Positionals) == 0 || parsed.Bools["help"] || parsed.Bools["h"] {
		fmt.Fprintln(runtime.Stdout, contextualHelp(parsed))
		return 0
	}

	if err := validateCommandFlags(parsed); err != nil {
		return fail(runtime.Stderr, err)
	}
	if err := validateCommandSyntax(parsed); err != nil {
		return fail(runtime.Stderr, err)
	}
	if c, args, ok := findWorkflow(parsed); ok && !legacyTextInspection(parsed) {
		return runWorkflow(ctx, runtime, parsed, c, args)
	}
	if isMetadataCommand(parsed) {
		return runMetadataMutation(ctx, runtime, parsed, parsed.Positionals[2:])
	}
	if parsed.Positionals[0] == "settings" {
		return runSettingsInspect(ctx, runtime, parsed)
	}
	if len(parsed.Positionals) > 1 && (parsed.Positionals[0] == "library" || parsed.Positionals[0] == "files") && parsed.Positionals[1] == "download" {
		return runArtifactDownload(ctx, runtime, parsed, parsed.Positionals[2:])
	}
	return dispatchCommand(ctx, runtime, parsed)
}
func dispatchCommand(ctx context.Context, runtime Runtime, parsed parsedArgs) int {
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
	case "comments":
		if len(args) > 0 && (args[0] == "add" || args[0] == "reply" || args[0] == "resolve" || args[0] == "reopen") {
			return runCommentMutation(ctx, runtime, parsed, args[0], args[1:])
		}
		return fail(runtime.Stderr, errors.New("unknown comments action"))
	case "ideas":
		if len(args) > 0 && args[0] == "execute" {
			return runIdeaExecute(ctx, runtime, parsed, args[1:])
		}
		return runIdeas(ctx, runtime, parsed)
	case "library":
		if len(args) > 0 && args[0] == "upload" {
			return runLibraryUpload(ctx, runtime, parsed, args[1:])
		}
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

func runTask(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("task requires an action"))
	}
	action := args[0]
	projectID, rest, err := projectFromArgs(parsed.Globals, args[1:], "task "+action)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	client, config, resolveErr := authenticatedClientWithConfig(ctx, runtime)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	resolvedID, _, resolveErr := ResolveProject(ctx, client, projectID, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	projectID = resolvedID

	switch action {
	case "submit":
		return runTaskSubmit(ctx, runtime, parsed, client, projectID, rest)
	case "status":
		return runTaskStatus(ctx, runtime, parsed, client, projectID, rest)
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown task action: %s", action))
	}
}

func runTaskSubmit(ctx context.Context, runtime Runtime, parsed parsedArgs, client APIClient, projectID string, args []string) int {
	message, inputErr := readCommandInput(runtime, parsed, args, "prompt")
	if inputErr != nil {
		return fail(runtime.Stderr, inputErr)
	}
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("task submit requires <message> or --prompt"))
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return submitTaskWithClient(ctx, runtime, parsed, client, projectID, message, options)
}

func runTaskStatus(ctx context.Context, runtime Runtime, parsed parsedArgs, client APIClient, projectID string, args []string) int {
	if len(args) != 1 {
		return fail(runtime.Stderr, errors.New("task status requires <taskId>"))
	}
	if parsed.Globals.JSON {
		var value map[string]any
		if err := client.request(ctx, http.MethodGet, projectAPIPath(projectID, "tasks", args[0]), nil, &value); err != nil {
			return fail(runtime.Stderr, err)
		}
		return writeWorkflow(runtime, parsed, value)
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
	if args[0] == "wait" {
		return runTaskWait(ctx, runtime, parsed, args[1:])
	}
	if args[0] == "submit" {
		return runScopedTaskSubmit(ctx, runtime, parsed, args[1:])
	}
	if args[0] != "dispatch" {
		return fail(runtime.Stderr, fmt.Errorf("unknown tasks action: %s", args[0]))
	}
	projectID, rest, err := projectFromArgs(parsed.Globals, args[1:], "tasks dispatch")
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	client, config, resolveErr := authenticatedClientWithConfig(ctx, runtime)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	resolvedID, _, resolveErr := ResolveProject(ctx, client, projectID, config)
	if resolveErr != nil {
		return fail(runtime.Stderr, resolveErr)
	}
	projectID = resolvedID
	message, inputErr := readCommandInput(runtime, parsed, rest, "prompt")
	if inputErr != nil {
		return fail(runtime.Stderr, inputErr)
	}
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("tasks dispatch requires --prompt or <prompt>"))
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return submitTaskWithClient(ctx, runtime, parsed, client, projectID, message, options)
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
	case "answer":
		return runAttentionAnswer(ctx, runtime, parsed, args[1:])
	case "fork", "retry":
		return runLineage(ctx, runtime, parsed, args[0], args[1:])
	case "send", "cancel", "sleep":
		return runSessionAction(ctx, runtime, parsed, args[0], args[1:])
	case "export":
		return runTranscriptExport(ctx, runtime, parsed, args[1:])
	case "new":
		return runChatNew(ctx, runtime, parsed, args[1:])
	default:
		// Treat the first arg as a session ID for chat view
		return runChatView(ctx, runtime, parsed, args[0])
	}
}

func runRunner(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	if len(args) == 0 {
		return fail(runtime.Stderr, errors.New("runner requires an action"))
	}
	switch args[0] {
	case "doctor":
		report := RunRunnerDoctor(ctx, runtime.Runner)
		code := writeOrFail(runtime, parsed.Globals.JSON, FormatRunnerDoctor(report), report)
		if code != 0 {
			return code
		}
		if !report.Ready {
			return 1
		}
		return 0
	case "install":
		return fail(runtime.Stderr, plannedCommand("sam runner install"))
	case "register":
		return fail(runtime.Stderr, plannedCommand("sam runner register"))
	default:
		return fail(runtime.Stderr, fmt.Errorf("unknown runner action: %s", args[0]))
	}
}

func submitTaskWithClient(ctx context.Context, runtime Runtime, parsed parsedArgs, client APIClient, projectID string, message string, options TaskSubmitOptions) int {
	if strings.TrimSpace(message) == "" {
		return fail(runtime.Stderr, errors.New("submission requires a nonempty prompt"))
	}
	client.idempotencyKey = parsed.Flags["idempotency-key"]
	if options.AgentProfile != "" {
		id, err := resolveNamedResource(ctx, client, projectID, "agent-profiles", options.AgentProfile)
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		options.AgentProfile = id
	}
	if options.Skill != "" {
		id, err := resolveNamedResource(ctx, client, projectID, "skills", options.Skill)
		if err != nil {
			return fail(runtime.Stderr, err)
		}
		options.Skill = id
	}
	refs, uploadErr := attachmentReferences(ctx, runtime, client, projectID, parsed)
	if uploadErr != nil {
		return fail(runtime.Stderr, uploadErr)
	}
	options.Attachments = refs
	warnDeprecatedVMSize(runtime.Stderr, options)
	response, err := client.SubmitTask(ctx, projectID, message, options)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return writeOrFail(runtime, parsed.Globals.JSON, formatSubmitResponse(response), response)
}

func warnDeprecatedVMSize(stderr io.Writer, options TaskSubmitOptions) {
	if options.VMSize != "" {
		fmt.Fprintln(stderr, "warning: --vm-size is deprecated; prefer --min-vcpu, --min-memory-gb, --min-disk-gb, and --exclusive-node. Legacy tiers are translated by SAM compatibility policy.")
	}
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
	if w, ok := stderr.(redactingWriter); ok {
		message := err.Error()
		for _, secret := range w.secrets {
			if len(secret) >= 4 {
				message = strings.ReplaceAll(message, secret, "REDACTED")
			}
		}
		var apiErr APIError
		if errors.As(err, &apiErr) {
			apiErr.Message = message
			return fail(w.destination, apiErr)
		}
		return fail(w.destination, errors.New(message))
	}
	if w, ok := stderr.(structuredErrorWriter); ok {
		w.writeError(err)
		return 1
	}
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

Task resource flags:
  --min-vcpu <number>       Minimum vCPU count for task/chat dispatch
  --min-memory-gb <number>  Minimum memory in GB
  --min-disk-gb <number>    Minimum disk in GB
  --exclusive-node[=bool]   Request no co-tenants; explicit false is preserved
  --vm-size <small|medium|large>
                            Deprecated legacy tier; prefer resource flags
`
}

func containsJSONFlag(args []string) bool {
	for _, a := range args {
		if a == "--json" {
			return true
		}
	}
	return false
}

func isMetadataCommand(p parsedArgs) bool {
	if len(p.Positionals) < 2 {
		return false
	}
	switch p.Positionals[0] {
	case "tasks", "ideas", "profiles", "skills", "settings":
		switch p.Positionals[1] {
		case "create", "update", "clone":
			return true
		}
	}
	return false
}

func runScopedTaskSubmit(ctx context.Context, runtime Runtime, parsed parsedArgs, args []string) int {
	client, config, err := authenticatedClientWithConfig(ctx, runtime)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	id, _, err := resolveProjectRef(ctx, client, parsed, config)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	message, err := readCommandInput(runtime, parsed, args, "prompt")
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	options, err := parseSubmitOptions(parsed)
	if err != nil {
		return fail(runtime.Stderr, err)
	}
	return submitTaskWithClient(ctx, runtime, parsed, client, id, message, options)
}
