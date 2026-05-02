// Command harness is the CLI entry point for the SAM agent harness prototype.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/workspace/harness/agent"
	"github.com/workspace/harness/llm"
	"github.com/workspace/harness/tools"
	"github.com/workspace/harness/transcript"
)

func main() {
	var (
		dir          = flag.String("dir", ".", "Working directory for tools")
		prompt       = flag.String("prompt", "", "Initial task prompt")
		maxTurns     = flag.Int("max-turns", 10, "Maximum agent loop iterations")
		transcriptF  = flag.String("transcript", "", "Path to write transcript JSON")
		systemPrompt = flag.String("system", "You are a coding assistant. Use the provided tools to complete tasks.", "System prompt")
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

	// Create mock provider (spike only supports mock mode).
	provider := llm.NewMockProvider(
		&llm.Response{Content: "I'll analyze this directory. Let me start by reading the files."},
	)

	// Build tool registry.
	registry := tools.NewRegistry()
	for _, t := range []tools.Tool{
		&tools.ReadFile{WorkDir: workDir},
		&tools.WriteFile{WorkDir: workDir},
		&tools.EditFile{WorkDir: workDir},
		&tools.Bash{WorkDir: workDir},
	} {
		if err := registry.Register(t); err != nil {
			fmt.Fprintf(os.Stderr, "error registering tool %s: %v\n", t.Name(), err)
			os.Exit(1)
		}
	}

	// Create transcript log.
	log := transcript.NewLog()

	// Run agent loop with signal handling.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	result, err := agent.Run(ctx, provider, registry, log, agent.Config{
		SystemPrompt: *systemPrompt,
		MaxTurns:     *maxTurns,
	}, *prompt)

	if err != nil {
		fmt.Fprintf(os.Stderr, "agent error: %v\n", err)
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
