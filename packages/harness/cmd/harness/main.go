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

	"github.com/workspace/harness/agent"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/mcp"
	"github.com/workspace/harness/prompts"
	"github.com/workspace/harness/repomap"
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
		providerName     = flag.String("provider", "mock", "LLM provider: mock, openai, or anthropic")
		apiURL           = flag.String("api-url", "", "OpenAI-compatible API base URL (enables real LLM provider)")
		apiKey           = flag.String("api-key", "", "API key for LLM provider (or set SAM_API_KEY env var)")
		model            = flag.String("model", llm.DefaultModel, "Model ID for LLM completions (used for orchestrator when --worker-model is set)")
		workerModel      = flag.String("worker-model", "", "Model ID for worker subtasks (defaults to --model if not set)")
		authHeader       = flag.String("auth-header", "", "Custom auth header name (e.g. cf-aig-authorization for AI Gateway unified billing)")
		repoMapFlag      = flag.Bool("repo-map", true, "Generate and prepend a repo map to the system prompt")
		mcpURL           = flag.String("mcp-url", envOr("SAM_MCP_URL", ""), "MCP server URL (or SAM_MCP_URL env var)")
		mcpToken         = flag.String("mcp-token", envOr("SAM_MCP_TOKEN", ""), "MCP server Bearer token (or SAM_MCP_TOKEN env var)")
		toolProfile      = flag.String("tool-profile", "workspace", "Tool profile: workspace, orchestrate, or full")
		mockOrchScenario = flag.String("mock-orchestration", "", "Register mock orchestration tools with scenario: success, failure, or mixed (for eval without MCP)")
		realOrch         = flag.Bool("real-orchestration", false, "Enable real subtask execution — dispatch_task spawns child harness sessions")
		stream           = flag.Bool("stream", false, "Enable streaming output from LLM providers that support it")
	)
	flag.Parse()

	if *prompt == "" {
		fmt.Fprintln(os.Stderr, "error: --prompt is required")
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

	// Register orchestration tools: mock (for eval) or real (for actual subtask execution).
	if *mockOrchScenario != "" && *realOrch {
		fmt.Fprintln(os.Stderr, "error: --mock-orchestration and --real-orchestration are mutually exclusive")
		os.Exit(1)
	}

	if *mockOrchScenario != "" {
		orchTools := tools.MockOrchestrationTools(*mockOrchScenario)
		allTools = append(allTools, orchTools...)
		fmt.Fprintf(os.Stderr, "Mock orchestration tools registered (scenario: %s)\n", *mockOrchScenario)
	}

	if *realOrch {
		realState := tools.NewRealOrchestrationState()
		realState.WorkDir = workDir
		realState.Model = resolvedWorkerModel
		realState.APIURL = *apiURL
		realState.APIKey = *apiKey
		realState.AuthHeader = *authHeader

		orchTools := tools.RealOrchestrationTools(realState)
		allTools = append(allTools, orchTools...)
		fmt.Fprintf(os.Stderr, "Real orchestration tools registered (worker model: %s)\n", resolvedWorkerModel)
	}

	// Apply tool profile filtering.
	allTools = mcp.FilterTools(*toolProfile, allTools)

	for _, t := range allTools {
		if err := registry.Register(t); err != nil {
			fmt.Fprintf(os.Stderr, "error registering tool %s: %v\n", t.Name(), err)
			os.Exit(1)
		}
	}
	fmt.Fprintf(os.Stderr, "Registered %d tools (profile: %s)\n", len(allTools), *toolProfile)

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

	// Run agent loop with signal handling.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	result, err := agent.Run(ctx, provider, registry, log, agent.Config{
		SystemPrompt:     sysPrompt,
		MaxTurns:         *maxTurns,
		MaxContextTokens: *maxContextTokens,
		WorkerModel:      resolvedWorkerModel,
		WorkDir:          workDir,
		Stream:           *stream,
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
