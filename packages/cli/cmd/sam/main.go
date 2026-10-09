package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/workspace/sam-cli/internal/cli"
)

func main() {
	runtime := cli.Runtime{
		Args:       os.Args[1:],
		Env:        cli.OSConfigEnv{},
		HTTPClient: &http.Client{},
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		Runner:     cli.OSRunner{},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	code := cli.Run(ctx, runtime)
	if code != 0 {
		os.Exit(code)
	}
}
