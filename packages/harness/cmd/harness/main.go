// Command harness is the CLI entry point for the SAM agent harness prototype.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	acpserver "github.com/workspace/harness/acp"
	"github.com/workspace/harness/agent"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/mcp"
	"github.com/workspace/harness/prompts"
	"github.com/workspace/harness/repomap"
	"github.com/workspace/harness/session"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func main() {
	var (
		dir              = flag.String("dir", ".", "Working directory for tools")
		prompt           = flag.String("prompt", "", "Initial task prompt")
		maxTurns         = flag.Int("max-turns", 10, "Maximum agent loop iterations")
		maxContextTokens = flag.Int("max-context-tokens", 30000, "Maximum context window tokens before compaction")
		transcriptF      = flag.String("transcript", "", "Path to write transcript JSON")
		systemPrompt     = flag.String("system", "You are a coding assistant. Use the provided tools to complete tasks.", "System prompt (lowest precedence)")
		promptFile       = flag.String("prompt-file", "", "Path to a markdown file to use as system prompt (highest precedence)")
		promptPreset     = flag.String("prompt-preset", "", "Built-in prompt preset: workspace, orchestrator")
		providerName     = flag.String("provider", envOr("SAM_PROVIDER", "mock"), "LLM provider: mock, openai, or anthropic")
		apiURL           = flag.String("api-url", envOr("SAM_API_URL", ""), "OpenAI-compatible API base URL (enables real LLM provider)")
		apiKey           = flag.String("api-key", "", "API key for LLM provider (or set SAM_API_KEY env var)")
		model            = flag.String("model", envOr("SAM_AI_MODEL", llm.DefaultModel), "Model ID for LLM completions (used for orchestrator when --worker-model is set)")
		workerModel      = flag.String("worker-model", "", "Model ID for worker subtasks (defaults to --model if not set)")
		authHeader       = flag.String("auth-header", envOr("SAM_AUTH_HEADER", ""), "Custom auth header name (e.g. cf-aig-authorization for AI Gateway unified billing)")
		repoMapFlag      = flag.Bool("repo-map", true, "Generate and prepend a repo map to the system prompt")
		mcpURL           = flag.String("mcp-url", envOr("SAM_MCP_URL", ""), "MCP server URL (or SAM_MCP_URL env var)")
		mcpToken         = flag.String("mcp-token", envOr("SAM_MCP_TOKEN", ""), "MCP server Bearer token (or SAM_MCP_TOKEN env var)")
		mockOrchScenario = flag.String("mock-orchestration", "", "TEST ONLY: Register mock orchestration tools with scenario: success, failure, or mixed (for eval without MCP)")
		stream           = flag.Bool("stream", false, "Enable streaming output from LLM providers that support it")
		permissionMode   = flag.String("permission-mode", "allow-all", "Permission mode: allow-all, deny-dangerous, or ask-always")
		parallelTools    = flag.Bool("parallel-tools", false, "Execute multiple tool calls in parallel")
		maxParallelTools = flag.Int("max-parallel-tools", 5, "Maximum concurrent tool executions when --parallel-tools is enabled")
		compactionStrat  = flag.String("compaction-strategy", "extractive", "Compaction strategy: extractive (default) or llm")
		sessionDB        = flag.String("session-db", "", "Path to SQLite session database (enables persistence)")
		resumeSession    = flag.String("resume", "", "Resume a previous session by ID")
		listSessions     = flag.Bool("list-sessions", false, "List recent sessions and exit")
		acpMode          = flag.Bool("acp", false, "Run in ACP mode: JSON-RPC over stdin/stdout (used by VM agent)")
	)
	flag.Parse()

	// Handle --list-sessions.
	if *listSessions {
		dbPath := *sessionDB
		if dbPath == "" {
			home, _ := os.UserHomeDir()
			dbPath = filepath.Join(home, ".sam-harness", "sessions.db")
		}
		store, err := session.NewStore(dbPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		defer store.Close()
		sessions, err := store.ListSessions(20)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		if len(sessions) == 0 {
			fmt.Println("No sessions found.")
		} else {
			fmt.Printf("%-36s  %-10s  %-5s  %s\n", "ID", "STATUS", "TURNS", "CREATED")
			for _, s := range sessions {
				fmt.Printf("%-36s  %-10s  %-5d  %s\n", s.ID, s.Status, s.TotalTurns, s.CreatedAt.Format(time.RFC3339))
			}
		}
		os.Exit(0)
	}

	// ACP mode: run as a JSON-RPC server over stdin/stdout.
	// This branch handles the full lifecycle (Initialize, NewSession, Prompt, etc.)
	// and never returns — it blocks until the peer disconnects.
	if *acpMode {
		runACPMode(acpModeArgs{
			dir:              *dir,
			providerName:     *providerName,
			apiURL:           *apiURL,
			apiKey:           *apiKey,
			model:            *model,
			workerModel:      *workerModel,
			systemPrompt:     *systemPrompt,
			promptFile:       *promptFile,
			promptPreset:     *promptPreset,
			repoMap:          *repoMapFlag,
			authHeader:       *authHeader,
			maxTurns:         *maxTurns,
			maxContextTokens: *maxContextTokens,
			compactionStrat:  *compactionStrat,
			stream:           *stream,
			permissionMode:   *permissionMode,
			parallelTools:    *parallelTools,
			maxParallelTools: *maxParallelTools,
			mcpURL:           *mcpURL,
			mcpToken:         *mcpToken,
			mockOrchScenario: *mockOrchScenario,
		})
		return // unreachable — runACPMode blocks
	}

	if *prompt == "" && *resumeSession == "" {
		fmt.Fprintln(os.Stderr, "error: --prompt is required (unless --resume is used)")
		flag.Usage()
		os.Exit(1)
	}

	// Resolve working directory.
	workDir := *dir
	if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "error: --dir %q is not a valid directory\n", workDir)
		os.Exit(1)
	}

	// Create LLM provider.
	var provider llm.Provider
	switch *providerName {
	case "mock":
		provider = llm.NewMockProvider(
			&llm.Response{Content: "I'll analyze this directory. Let me start by reading the files."},
		)
		fmt.Fprintln(os.Stderr, "Using mock provider (pass --provider openai to use a real LLM)")
	case "openai":
		if *apiURL == "" {
			fmt.Fprintln(os.Stderr, "error: --api-url is required when using openai provider")
			os.Exit(1)
		}
		key := *apiKey
		if key == "" {
			key = os.Getenv("SAM_API_KEY")
		}
		if key == "" {
			fmt.Fprintln(os.Stderr, "error: --api-key or SAM_API_KEY env var is required when using openai provider")
			os.Exit(1)
		}
		opts := []llm.OpenAIOption{llm.WithModel(*model)}
		if *authHeader != "" {
			opts = append(opts, llm.WithAuthHeader(*authHeader))
		}
		provider = llm.NewOpenAIClient(*apiURL, key, opts...)
		fmt.Fprintf(os.Stderr, "Using OpenAI-compatible provider: %s (model: %s)\n", *apiURL, *model)
	case "anthropic":
		if *apiURL == "" {
			fmt.Fprintln(os.Stderr, "error: --api-url is required when using anthropic provider")
			os.Exit(1)
		}
		key := *apiKey
		if key == "" {
			key = os.Getenv("SAM_API_KEY")
		}
		if key == "" {
			fmt.Fprintln(os.Stderr, "error: --api-key or SAM_API_KEY env var is required when using anthropic provider")
			os.Exit(1)
		}
		opts := []llm.AnthropicOption{llm.WithAnthropicModel(*model)}
		if *authHeader != "" {
			opts = append(opts, llm.WithAnthropicAuthHeader(*authHeader))
		}
		provider = llm.NewAnthropicClient(*apiURL, key, opts...)
		fmt.Fprintf(os.Stderr, "Using Anthropic provider: %s (model: %s)\n", *apiURL, *model)
	default:
		fmt.Fprintf(os.Stderr, "error: unknown provider %q (use mock, openai, or anthropic)\n", *providerName)
		os.Exit(1)
	}

	// Resolve worker model — defaults to orchestrator model.
	resolvedWorkerModel := *workerModel
	if resolvedWorkerModel == "" {
		resolvedWorkerModel = *model
	}

	// Build tool registry with local tools.
	registry := tools.NewRegistry()
	localTools := []tools.Tool{
		&tools.ReadFile{WorkDir: workDir},
		&tools.WriteFile{WorkDir: workDir},
		&tools.EditFile{WorkDir: workDir},
		&tools.ApplyDiff{WorkDir: workDir},
		&tools.Bash{WorkDir: workDir},
		&tools.Grep{WorkDir: workDir},
		&tools.Glob{WorkDir: workDir},
		&tools.GitStatus{WorkDir: workDir},
		&tools.GitDiff{WorkDir: workDir},
		&tools.GitLog{WorkDir: workDir},
		&tools.GitCommit{WorkDir: workDir},
		&tools.GitBranch{WorkDir: workDir},
	}

	// Discover and merge MCP tools if configured.
	allTools := localTools
	if *mcpURL != "" {
		if *mcpToken == "" {
			fmt.Fprintln(os.Stderr, "error: --mcp-token (or SAM_MCP_TOKEN) is required when --mcp-url is set")
			os.Exit(1)
		}

		client := mcp.NewClient(*mcpURL, *mcpToken)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		mcpDefs, err := client.ListTools(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error discovering MCP tools: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Discovered %d MCP tools\n", len(mcpDefs))

		mcpTools := mcp.AdaptTools(client, mcpDefs)
		allTools = append(allTools, mcpTools...)
	}

	// Register mock orchestration tools if requested (test only).
	if *mockOrchScenario != "" {
		orchTools := tools.MockOrchestrationTools(*mockOrchScenario)
		allTools = append(allTools, orchTools...)
		fmt.Fprintf(os.Stderr, "TEST: Mock orchestration tools registered (scenario: %s)\n", *mockOrchScenario)
	}

	for _, t := range allTools {
		if err := registry.Register(t); err != nil {
			fmt.Fprintf(os.Stderr, "error registering tool %s: %v\n", t.Name(), err)
			os.Exit(1)
		}
	}
	fmt.Fprintf(os.Stderr, "Registered %d tools\n", len(allTools))

	// Create transcript log.
	log := transcript.NewLog()

	// Resolve system prompt from flags (precedence: file > preset > inline).
	sysPrompt, err := prompts.Resolve(*promptFile, *promptPreset, *systemPrompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading system prompt: %v\n", err)
		os.Exit(1)
	}

	// Generate repo map if enabled and directory is a git repo.
	if *repoMapFlag && isGitRepo(workDir) {
		start := time.Now()
		rm, err := repomap.Generate(workDir, nil)
		elapsed := time.Since(start)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: repo map generation failed: %v\n", err)
		} else if rm != "" {
			sysPrompt = "# Repository Map\n\n" + rm + "\n\n" + sysPrompt
			log.Append(transcript.EventInfo, 0, map[string]any{
				"action":   "repo_map",
				"chars":    len(rm),
				"duration": elapsed.String(),
			})
			fmt.Fprintf(os.Stderr, "Repo map generated in %v (%d chars)\n", elapsed.Round(time.Millisecond), len(rm))
		}
	}

	// Parse permission mode.
	permMode, err := tools.ParsePermissionMode(*permissionMode)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// Set up session persistence if requested.
	var sessionStore *session.Store
	var sessionID string
	if *sessionDB != "" || *resumeSession != "" {
		dbPath := *sessionDB
		if dbPath == "" {
			home, _ := os.UserHomeDir()
			dbPath = filepath.Join(home, ".sam-harness", "sessions.db")
		}
		var storeErr error
		sessionStore, storeErr = session.NewStore(dbPath)
		if storeErr != nil {
			fmt.Fprintf(os.Stderr, "error opening session store: %v\n", storeErr)
			os.Exit(1)
		}
		defer sessionStore.Close()

		if *resumeSession != "" {
			sessionID = *resumeSession
			sess, loadErr := sessionStore.LoadSession(sessionID)
			if loadErr != nil {
				fmt.Fprintf(os.Stderr, "error loading session %q: %v\n", sessionID, loadErr)
				os.Exit(1)
			}
			fmt.Fprintf(os.Stderr, "Resuming session %s (%d turns, status: %s)\n", sess.ID, sess.TotalTurns, sess.Status)
		} else {
			sessionID = fmt.Sprintf("%d", time.Now().UnixNano())
			if _, createErr := sessionStore.CreateSession(sessionID, session.Config{
				SystemPrompt: sysPrompt,
				WorkDir:      workDir,
				Model:        *model,
			}); createErr != nil {
				fmt.Fprintf(os.Stderr, "error creating session: %v\n", createErr)
				os.Exit(1)
			}
			fmt.Fprintf(os.Stderr, "Session %s created\n", sessionID)
		}
	}

	// Run agent loop with signal handling.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	result, err := agent.Run(ctx, provider, registry, log, agent.Config{
		SystemPrompt:       sysPrompt,
		MaxTurns:           *maxTurns,
		MaxContextTokens:   *maxContextTokens,
		CompactionStrategy: agent.CompactionStrategy(*compactionStrat),
		WorkerModel:        resolvedWorkerModel,
		WorkDir:            workDir,
		Stream:             *stream,
		PermissionMode:     permMode,
		PermissionChecker:  tools.AutoApproveChecker{},
		ParallelTools:      *parallelTools,
		MaxParallelTools:   *maxParallelTools,
		SessionStore:       sessionStore,
		SessionID:          sessionID,
		ProviderConfig: &agent.ProviderConfig{
			Name:       *providerName,
			APIURL:     *apiURL,
			APIKey:     *apiKey,
			AuthHeader: *authHeader,
			Model:      *model,
		},
	}, *prompt)

	if err != nil {
		fmt.Fprintf(os.Stderr, "agent error: %v\n", err)
		if result == nil {
			os.Exit(1)
		}
	}

	if result != nil {
		fmt.Printf("Agent completed in %d turns (reason: %s)\n", result.TurnsUsed, result.StopReason)
		if result.FinalMessage != "" {
			fmt.Printf("Final message: %s\n", result.FinalMessage)
		}
	}

	// Write transcript if requested.
	if *transcriptF != "" {
		data, err := log.JSON()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error serializing transcript: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*transcriptF, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "error writing transcript: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Transcript written to %s (%d events)\n", *transcriptF, log.Len())
	}
}

// isGitRepo checks whether dir (or an ancestor) is a git repository.
func isGitRepo(dir string) bool {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// envOr returns the value of the named environment variable, or fallback if unset.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// acpModeArgs holds the flags needed to set up the ACP server.
type acpModeArgs struct {
	dir              string
	providerName     string
	apiURL           string
	apiKey           string
	model            string
	workerModel      string
	systemPrompt     string
	promptFile       string
	promptPreset     string
	repoMap          bool
	authHeader       string
	maxTurns         int
	maxContextTokens int
	compactionStrat  string
	stream           bool
	permissionMode   string
	parallelTools    bool
	maxParallelTools int
	mcpURL           string
	mcpToken         string
	mockOrchScenario string
}

// runACPMode starts the harness as an ACP JSON-RPC server on stdin/stdout.
// It blocks until the peer disconnects or the process is interrupted.
func runACPMode(args acpModeArgs) {
	// Resolve working directory.
	workDir := args.dir
	if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "error: --dir %q is not a valid directory\n", workDir)
		os.Exit(1)
	}

	// Create LLM provider.
	provider := createProvider(args)

	// Resolve worker model.
	resolvedWorkerModel := args.workerModel
	if resolvedWorkerModel == "" {
		resolvedWorkerModel = args.model
	}

	sysPrompt, err := prompts.Resolve(args.promptFile, args.promptPreset, args.systemPrompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading system prompt: %v\n", err)
		os.Exit(1)
	}
	if args.repoMap && isGitRepo(workDir) {
		rm, err := repomap.Generate(workDir, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: repo map generation failed: %v\n", err)
		} else if rm != "" {
			sysPrompt = "# Repository Map\n\n" + rm + "\n\n" + sysPrompt
		}
	}

	// Build tool registry.
	registry := buildToolRegistry(args, workDir)

	// Parse permission mode.
	permMode, err := tools.ParsePermissionMode(args.permissionMode)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	cfg := agent.Config{
		SystemPrompt:       sysPrompt,
		MaxTurns:           args.maxTurns,
		MaxContextTokens:   args.maxContextTokens,
		CompactionStrategy: agent.CompactionStrategy(args.compactionStrat),
		WorkerModel:        resolvedWorkerModel,
		WorkDir:            workDir,
		Stream:             args.stream,
		PermissionMode:     permMode,
		PermissionChecker:  tools.AutoApproveChecker{},
		ParallelTools:      args.parallelTools,
		MaxParallelTools:   args.maxParallelTools,
		ProviderConfig: &agent.ProviderConfig{
			Name:       args.providerName,
			APIURL:     args.apiURL,
			APIKey:     args.apiKey,
			AuthHeader: args.authHeader,
			Model:      args.model,
		},
	}

	handler := acpserver.NewHandler(acpserver.Deps{
		Provider: provider,
		Registry: registry,
		Config:   cfg,
	})

	fmt.Fprintln(os.Stderr, "SAM harness: ACP mode active, waiting for JSON-RPC on stdin")
	acpserver.Serve(handler, os.Stdout, os.Stdin)
}

// createProvider builds an LLM provider from the given args.
func createProvider(args acpModeArgs) llm.Provider {
	switch args.providerName {
	case "mock":
		return llm.NewMockProvider(
			&llm.Response{Content: "I'll analyze this directory. Let me start by reading the files."},
		)
	case "openai":
		if args.apiURL == "" {
			fmt.Fprintln(os.Stderr, "error: --api-url is required when using openai provider")
			os.Exit(1)
		}
		key := args.apiKey
		if key == "" {
			key = os.Getenv("SAM_API_KEY")
		}
		if key == "" {
			fmt.Fprintln(os.Stderr, "error: --api-key or SAM_API_KEY env var is required when using openai provider")
			os.Exit(1)
		}
		opts := []llm.OpenAIOption{llm.WithModel(args.model)}
		if args.authHeader != "" {
			opts = append(opts, llm.WithAuthHeader(args.authHeader))
		}
		return llm.NewOpenAIClient(args.apiURL, key, opts...)
	case "anthropic":
		if args.apiURL == "" {
			fmt.Fprintln(os.Stderr, "error: --api-url is required when using anthropic provider")
			os.Exit(1)
		}
		key := args.apiKey
		if key == "" {
			key = os.Getenv("SAM_API_KEY")
		}
		if key == "" {
			fmt.Fprintln(os.Stderr, "error: --api-key or SAM_API_KEY env var is required when using anthropic provider")
			os.Exit(1)
		}
		opts := []llm.AnthropicOption{llm.WithAnthropicModel(args.model)}
		if args.authHeader != "" {
			opts = append(opts, llm.WithAnthropicAuthHeader(args.authHeader))
		}
		return llm.NewAnthropicClient(args.apiURL, key, opts...)
	default:
		fmt.Fprintf(os.Stderr, "error: unknown provider %q\n", args.providerName)
		os.Exit(1)
		return nil
	}
}

// buildToolRegistry creates a tool registry with local and optional MCP/orchestration tools.
func buildToolRegistry(args acpModeArgs, workDir string) *tools.Registry {
	registry := tools.NewRegistry()
	localTools := []tools.Tool{
		&tools.ReadFile{WorkDir: workDir},
		&tools.WriteFile{WorkDir: workDir},
		&tools.EditFile{WorkDir: workDir},
		&tools.ApplyDiff{WorkDir: workDir},
		&tools.Bash{WorkDir: workDir},
		&tools.Grep{WorkDir: workDir},
		&tools.Glob{WorkDir: workDir},
		&tools.GitStatus{WorkDir: workDir},
		&tools.GitDiff{WorkDir: workDir},
		&tools.GitLog{WorkDir: workDir},
		&tools.GitCommit{WorkDir: workDir},
		&tools.GitBranch{WorkDir: workDir},
	}

	allTools := localTools

	if args.mcpURL != "" {
		if args.mcpToken == "" {
			fmt.Fprintln(os.Stderr, "error: --mcp-token (or SAM_MCP_TOKEN) is required when --mcp-url is set")
			os.Exit(1)
		}
		client := mcp.NewClient(args.mcpURL, args.mcpToken)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		mcpDefs, err := client.ListTools(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error discovering MCP tools: %v\n", err)
			os.Exit(1)
		}
		mcpTools := mcp.AdaptTools(client, mcpDefs)
		allTools = append(allTools, mcpTools...)
	}

	if args.mockOrchScenario != "" {
		allTools = append(allTools, tools.MockOrchestrationTools(args.mockOrchScenario)...)
	}

	for _, t := range allTools {
		if err := registry.Register(t); err != nil {
			fmt.Fprintf(os.Stderr, "error registering tool %s: %v\n", t.Name(), err)
			os.Exit(1)
		}
	}
	return registry
}

