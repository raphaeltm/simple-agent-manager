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
		systemPrompt     = flag.String("system", "You are a coding assistant. Use the provided tools to complete tasks.", "System prompt")
		apiURL           = flag.String("api-url", "", "OpenAI-compatible API base URL (enables real LLM provider)")
		apiKey           = flag.String("api-key", "", "API key for LLM provider (or set SAM_API_KEY env var)")
		model            = flag.String("model", llm.DefaultModel, "Model ID for LLM completions")
		repoMapFlag      = flag.Bool("repo-map", true, "Generate and prepend a repo map to the system prompt")
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
	if *apiURL != "" {
		key := *apiKey
		if key == "" {
			key = os.Getenv("SAM_API_KEY")
		}
		if key == "" {
			fmt.Fprintln(os.Stderr, "error: --api-key or SAM_API_KEY env var is required when using --api-url")
			os.Exit(1)
		}
		provider = llm.NewOpenAIClient(*apiURL, key, llm.WithModel(*model))
		fmt.Fprintf(os.Stderr, "Using OpenAI-compatible provider: %s (model: %s)\n", *apiURL, *model)
	} else {
		provider = llm.NewMockProvider(
			&llm.Response{Content: "I'll analyze this directory. Let me start by reading the files."},
		)
		fmt.Fprintln(os.Stderr, "Using mock provider (pass --api-url to use a real LLM)")
	}

	// Build tool registry.
	registry := tools.NewRegistry()
	for _, t := range []tools.Tool{
		&tools.ReadFile{WorkDir: workDir},
		&tools.WriteFile{WorkDir: workDir},
		&tools.EditFile{WorkDir: workDir},
		&tools.Bash{WorkDir: workDir},
		&tools.GitStatus{WorkDir: workDir},
		&tools.GitDiff{WorkDir: workDir},
		&tools.GitLog{WorkDir: workDir},
		&tools.GitCommit{WorkDir: workDir},
		&tools.GitBranch{WorkDir: workDir},
	} {
		if err := registry.Register(t); err != nil {
			fmt.Fprintf(os.Stderr, "error registering tool %s: %v\n", t.Name(), err)
			os.Exit(1)
		}
	}

	// Create transcript log.
	log := transcript.NewLog()

	// Generate repo map if enabled and directory is a git repo.
	sysPrompt := *systemPrompt
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
