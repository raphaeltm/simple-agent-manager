package main

import (
	"context"
	"net/http"
	"os"

	"github.com/workspace/sam-cli/internal/cli"
)

func main() {
	runtime := cli.Runtime{
		Args:       os.Args[1:],
		Env:        cli.OSConfigEnv{},
		HTTPClient: http.DefaultClient,
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		Runner:     cli.OSRunner{},
	}

	code := cli.Run(context.Background(), runtime)
	if code != 0 {
		os.Exit(code)
	}
}
